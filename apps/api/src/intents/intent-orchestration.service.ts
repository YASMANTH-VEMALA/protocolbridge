import { Injectable, NotImplementedException, UnprocessableEntityException } from "@nestjs/common";
import { createIntentResolver, type IntentResolver } from "@protocolbridge/ai";
import { ActorType, AgentStatus, IntentStatus, type Prisma } from "@protocolbridge/database";
import type {
  CreateIntentRequest,
  PolicyDecision,
  QuoteSnapshot,
  SearchConstraints,
  UniversalCommerceIntent,
} from "@protocolbridge/types";

import { AuthorizationService } from "../authorization/authorization.service";
import type { AuthenticatedAgent } from "../auth/auth.types";
import { AuditService } from "../audit/audit.service";
import { CatalogService } from "../catalog/catalog.service";
import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";
import { PolicyService } from "../policy/policy.service";
import { QuoteService } from "../quote/quote.service";
import { IntentStateService } from "./intent-state.service";

export interface PreparedIntent {
  universalIntent: UniversalCommerceIntent;
  status: "APPROVED" | "AWAITING_APPROVAL" | "BLOCKED";
  quote: QuoteSnapshot;
  policyDecision: PolicyDecision;
  amountChargedMinor: 0;
}

@Injectable()
export class IntentOrchestrationService {
  private readonly resolver: IntentResolver;

  constructor(
    config: AppConfigService,
    private readonly database: PrismaService,
    private readonly catalog: CatalogService,
    private readonly quotes: QuoteService,
    private readonly authorizations: AuthorizationService,
    private readonly policies: PolicyService,
    private readonly states: IntentStateService,
    private readonly audit: AuditService,
  ) {
    this.resolver = createIntentResolver(config.value);
  }

  async prepare(agent: AuthenticatedAgent, request: CreateIntentRequest): Promise<PreparedIntent> {
    if (request.protocol !== "INTERNAL") {
      throw new NotImplementedException({
        code: "PROTOCOL_NOT_IMPLEMENTED",
        message: `${request.protocol} is not implemented in P0. No compatibility is claimed.`,
      });
    }
    const buyer = await this.database.user.findUnique({
      where: { id: request.buyerId },
      select: { id: true },
    });
    if (!buyer) {
      throw new UnprocessableEntityException({
        code: "BUYER_NOT_FOUND",
        message: "The buyer identity does not exist.",
      });
    }

    const intent = await this.database.purchaseIntent.create({
      data: {
        merchantId: agent.merchantId,
        userId: request.buyerId,
        agentId: agent.id,
        requestId: request.requestId,
        protocol: request.protocol,
        status: IntentStatus.RECEIVED,
        originalRequest: { prompt: request.prompt, protocol: request.protocol },
        constraints: {},
        currency: "INR",
      },
    });
    await this.audit.append({
      merchantId: agent.merchantId,
      purchaseIntentId: intent.id,
      actorType: ActorType.AGENT,
      actorId: agent.id,
      eventType: "INTENT_RECEIVED",
      data: { requestId: request.requestId, protocol: request.protocol, amountChargedMinor: 0 },
    });
    await this.states.transition({
      merchantId: agent.merchantId,
      intentId: intent.id,
      from: "RECEIVED",
      to: "RESOLVING",
      actorType: ActorType.AGENT,
      actorId: agent.id,
    });

    try {
      const constraints = await this.resolver.resolve(request.prompt);
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "INTENT_CONSTRAINTS_RESOLVED",
        data: { resolver: this.resolver.providerName, constraints },
      });
      const resolved = await this.catalog.resolveVariant(agent.merchantId, constraints);
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "CATALOG_VARIANT_RESOLVED",
        data: {
          productId: resolved.productId,
          productVariantId: resolved.productVariantId,
          unitAmountMinor: resolved.unitAmountMinor,
          currency: resolved.currency,
          stock: resolved.availableStock,
          variantVersion: resolved.variantVersion,
        },
      });
      const universalIntent: UniversalCommerceIntent = {
        version: "1.0",
        intentId: intent.id,
        requestId: request.requestId,
        protocol: request.protocol,
        merchantId: agent.merchantId,
        buyerId: request.buyerId,
        agentId: agent.id,
        constraints,
        requestedAt: intent.createdAt.toISOString(),
      };
      await this.database.purchaseIntent.update({
        where: { id: intent.id },
        data: {
          constraints: constraints as Prisma.InputJsonValue,
          originalRequest: {
            prompt: request.prompt,
            protocol: request.protocol,
            universalCommerceIntent: universalIntent,
          },
          currency: resolved.currency,
          items: {
            create: {
              productId: resolved.productId,
              productVariantId: resolved.productVariantId,
              quantity: constraints.quantity,
              discoveredUnitAmountMinor: BigInt(resolved.unitAmountMinor),
            },
          },
        },
      });
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "UNIVERSAL_COMMERCE_INTENT_CREATED",
        data: universalIntent as unknown as Prisma.InputJsonValue,
      });
      const quote = await this.quotes.createFreshQuote({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        productVariantId: resolved.productVariantId,
        quantity: constraints.quantity,
      });
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "QUOTE_CREATED",
        data: quote as unknown as Prisma.InputJsonValue,
      });
      await this.states.transition({
        merchantId: agent.merchantId,
        intentId: intent.id,
        from: "RESOLVING",
        to: "QUOTED",
      });
      const authorization = await this.authorizations.evaluate({
        merchantId: agent.merchantId,
        userId: request.buyerId,
        agentId: agent.id,
        purchaseIntentId: intent.id,
        productVariantId: resolved.productVariantId,
        quote,
        constraints,
      });
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "AUTHORIZATION_EVALUATED",
        data: {
          authorizationId: authorization.authorization?.authorizationId ?? null,
          valid: authorization.valid,
          reasons: authorization.reasons,
        },
      });
      await this.states.transition({
        merchantId: agent.merchantId,
        intentId: intent.id,
        from: "QUOTED",
        to: "POLICY_CHECK",
      });
      const policyDecision = await this.policies.evaluate({
        merchantId: agent.merchantId,
        quote,
        constraints,
        authorization: authorization.authorization,
        authorizationReasons: authorization.reasons,
        agentActive: agent.status === AgentStatus.ACTIVE,
      });
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "POLICY_EVALUATED",
        data: policyDecision as unknown as Prisma.InputJsonValue,
      });
      const status: PreparedIntent["status"] =
        policyDecision.outcome === "ALLOW"
          ? "APPROVED"
          : policyDecision.outcome === "BLOCK"
            ? "BLOCKED"
            : "AWAITING_APPROVAL";
      await this.states.transition({
        merchantId: agent.merchantId,
        intentId: intent.id,
        from: "POLICY_CHECK",
        to: status,
        reasonCode: policyDecision.reasons[0] ?? null,
      });
      if (authorization.authorization) {
        await this.database.purchaseIntent.updateMany({
          where: { id: intent.id, merchantId: agent.merchantId },
          data: { authorizationId: authorization.authorization.authorizationId },
        });
      }
      return {
        universalIntent,
        status,
        quote,
        policyDecision,
        amountChargedMinor: 0,
      };
    } catch (error: unknown) {
      await this.database.purchaseIntent.updateMany({
        where: {
          id: intent.id,
          merchantId: agent.merchantId,
          status: { in: [IntentStatus.RESOLVING, IntentStatus.QUOTED, IntentStatus.POLICY_CHECK] },
        },
        data: { status: IntentStatus.FAILED, reasonCode: "PREPARATION_FAILED" },
      });
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "INTENT_PREPARATION_FAILED",
        data: {
          code:
            typeof error === "object" && error !== null && "name" in error
              ? String(error.name)
              : "UNKNOWN_ERROR",
          amountChargedMinor: 0,
        },
      });
      throw error;
    }
  }

  async getConstraints(merchantId: string, intentId: string): Promise<SearchConstraints> {
    const intent = await this.database.purchaseIntent.findFirstOrThrow({
      where: { id: intentId, merchantId },
      select: { constraints: true },
    });
    return intent.constraints as SearchConstraints;
  }
}
