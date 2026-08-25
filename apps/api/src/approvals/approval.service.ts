import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  hashApprovalToken,
  issueApprovalToken,
  verifyApprovalToken,
  type ApprovalTokenClaims,
} from "@protocolbridge/auth";
import { PurchaseStateMachine } from "@protocolbridge/commerce-core";
import {
  ActorType,
  AgentStatus,
  ApprovalRequestStatus,
  type ApprovalRequest,
  AuthorizationStatus,
  AuthorizationType,
  IntentStatus,
  Prisma,
} from "@protocolbridge/database";
import { minorToWire, type SearchConstraints } from "@protocolbridge/types";
import { createHmac } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import type { AuthenticatedAgent } from "../auth/auth.types";
import { AuthorizationService } from "../authorization/authorization.service";
import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";
import { PolicyService } from "../policy/policy.service";
import { QuoteService } from "../quote/quote.service";

const APPROVAL_TTL_MS = 10 * 60_000;

@Injectable()
export class ApprovalService {
  private readonly stateMachine = new PurchaseStateMachine();

  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
    private readonly quotes: QuoteService,
    private readonly authorizations: AuthorizationService,
    private readonly policies: PolicyService,
    private readonly audit: AuditService,
  ) {}

  async createLink(agent: AuthenticatedAgent, intentId: string): Promise<Record<string, unknown>> {
    const intent = await this.database.purchaseIntent.findFirst({
      where: {
        id: intentId,
        merchantId: agent.merchantId,
        agentId: agent.id,
        status: IntentStatus.AWAITING_APPROVAL,
      },
      include: { items: true, approvalRequest: true },
    });
    if (!intent) {
      throw new ConflictException({
        code: "INTENT_NOT_AWAITING_APPROVAL",
        message: "Only this agent's tenant-scoped AWAITING_APPROVAL intent can request approval.",
      });
    }
    const item = intent.items[0];
    if (!item || intent.items.length !== 1) {
      throw new ConflictException({
        code: "UNSUPPORTED_CART_SHAPE",
        message: "Buyer approval is limited to exactly one resolved product variant.",
      });
    }

    const now = new Date();
    if (
      intent.approvalRequest?.status === ApprovalRequestStatus.PENDING &&
      intent.approvalRequest.expiresAt > now
    ) {
      const token = this.issueStoredToken({
        id: intent.approvalRequest.id,
        merchantId: intent.merchantId,
        purchaseIntentId: intent.id,
        userId: intent.userId,
        productVariantId: intent.approvalRequest.productVariantId,
        amountMinor: minorToWire(intent.approvalRequest.approvedAmountMinor),
        currency: intent.approvalRequest.currency,
        expiresAt: intent.approvalRequest.expiresAt,
      });
      if (hashApprovalToken(token) !== intent.approvalRequest.tokenHash) {
        throw new ConflictException({
          code: "APPROVAL_TOKEN_STATE_CONFLICT",
          message: "The stored approval capability could not be reproduced safely.",
        });
      }
      return this.linkResponse(token, intent.approvalRequest);
    }

    const constraints = intent.constraints as unknown as SearchConstraints;
    const quote = await this.quotes.createFreshQuote({
      merchantId: agent.merchantId,
      purchaseIntentId: intent.id,
      productVariantId: item.productVariantId,
      quantity: item.quantity,
    });
    const authorization = await this.authorizations.evaluate({
      merchantId: agent.merchantId,
      userId: intent.userId,
      agentId: agent.id,
      purchaseIntentId: intent.id,
      productVariantId: item.productVariantId,
      quote,
      constraints,
    });
    const policy = await this.policies.evaluate({
      merchantId: agent.merchantId,
      quote,
      constraints,
      authorization: authorization.authorization,
      authorizationReasons: authorization.reasons,
      agentActive: agent.status === AgentStatus.ACTIVE,
    });
    if (policy.outcome !== "AWAITING_APPROVAL" || !policy.reasons.includes("MAX_AMOUNT_EXCEEDED")) {
      throw new ConflictException({
        code: "APPROVAL_NOT_APPLICABLE",
        message: "A buyer link is only issued for a current MAX_AMOUNT_EXCEEDED decision.",
      });
    }

    const approvalId = `apr_${intent.id}`;
    const expiresAt = new Date(Math.floor((now.getTime() + APPROVAL_TTL_MS) / 1_000) * 1_000);
    const token = this.issueStoredToken({
      id: approvalId,
      merchantId: intent.merchantId,
      purchaseIntentId: intent.id,
      userId: intent.userId,
      productVariantId: item.productVariantId,
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      expiresAt,
    });
    const tokenHash = hashApprovalToken(token);
    const approval = await this.database.$transaction(async (transaction) => {
      const saved = await transaction.approvalRequest.upsert({
        where: { purchaseIntentId: intent.id },
        create: {
          id: approvalId,
          merchantId: intent.merchantId,
          purchaseIntentId: intent.id,
          userId: intent.userId,
          status: ApprovalRequestStatus.PENDING,
          tokenHash,
          approvedAmountMinor: BigInt(quote.totalMinor),
          currency: quote.currency,
          productVariantId: item.productVariantId,
          expiresAt,
        },
        update: {
          status: ApprovalRequestStatus.PENDING,
          tokenHash,
          approvedAmountMinor: BigInt(quote.totalMinor),
          currency: quote.currency,
          productVariantId: item.productVariantId,
          expiresAt,
          usedAt: null,
        },
      });
      await this.audit.append(
        {
          merchantId: intent.merchantId,
          purchaseIntentId: intent.id,
          actorType: ActorType.AGENT,
          actorId: agent.id,
          eventType: "BUYER_APPROVAL_LINK_CREATED",
          data: {
            approvalRequestId: saved.id,
            productVariantId: saved.productVariantId,
            amountMinor: quote.totalMinor,
            currency: quote.currency,
            expiresAt: saved.expiresAt.toISOString(),
            tokenStoredAsHashOnly: true,
          },
        },
        transaction,
      );
      return saved;
    });
    return this.linkResponse(token, approval);
  }

  async inspect(token: string): Promise<Record<string, unknown>> {
    const { claims, approval } = await this.resolveToken(token);
    const intent = await this.database.purchaseIntent.findFirst({
      where: { id: claims.purchaseIntentId, merchantId: claims.merchantId },
      include: {
        merchant: { select: { name: true } },
        items: { include: { product: true, productVariant: true } },
      },
    });
    const item = intent?.items[0];
    if (!intent || !item || item.productVariantId !== claims.productVariantId) {
      throw this.invalidToken();
    }
    return {
      approval: {
        id: approval.id,
        status: approval.status,
        merchantName: intent.merchant.name,
        purchaseIntentId: intent.id,
        productName: item.product.name,
        productVariantId: item.productVariantId,
        color: item.productVariant.color,
        size: item.productVariant.size,
        quantity: item.quantity,
        approvedAmountMinor: claims.amountMinor,
        currency: claims.currency,
        expiresAt: claims.expiresAt.toISOString(),
      },
    };
  }

  async context(token: string): Promise<{ merchantId: string; approvalRequestId: string }> {
    const { claims } = await this.resolveToken(token);
    return { merchantId: claims.merchantId, approvalRequestId: claims.approvalRequestId };
  }

  async approve(token: string, buyerId: string): Promise<Record<string, unknown>> {
    const { claims, approval } = await this.resolveToken(token);
    if (claims.userId !== buyerId || approval.userId !== buyerId) {
      throw new ForbiddenException({
        code: "APPROVAL_BUYER_MISMATCH",
        message: "This approval capability belongs to a different authenticated buyer.",
      });
    }
    if (
      approval.status !== ApprovalRequestStatus.PENDING &&
      approval.status !== ApprovalRequestStatus.APPROVED
    ) {
      throw new ConflictException({
        code: "APPROVAL_LINK_ALREADY_USED",
        message: "This single-use approval link is no longer available.",
      });
    }

    const tokenHash = hashApprovalToken(token);
    const authorizationId = `auth_${approval.id}_${tokenHash.slice(0, 12)}`;
    const claimed = await this.database.$transaction(
      async (transaction) => {
        const intent = await transaction.purchaseIntent.findFirst({
          where: {
            id: claims.purchaseIntentId,
            merchantId: claims.merchantId,
            userId: buyerId,
            status: IntentStatus.AWAITING_APPROVAL,
          },
          include: { items: true },
        });
        const item = intent?.items[0];
        if (!intent || !item || intent.items.length !== 1 || item.productVariantId !== claims.productVariantId) {
          throw new ConflictException({
            code: "APPROVAL_INTENT_STATE_CHANGED",
            message: "The original purchase intent is no longer eligible for this approval.",
          });
        }
        const variant = await transaction.productVariant.findFirst({
          where: {
            id: claims.productVariantId,
            merchantId: claims.merchantId,
            active: true,
            stock: { gte: item.quantity },
          },
        });
        if (
          !variant ||
          variant.priceMinor !== BigInt(claims.amountMinor) ||
          variant.currency !== claims.currency
        ) {
          throw new ConflictException({
            code: "APPROVAL_QUOTE_CHANGED",
            message: "Product price, currency, or stock changed; generate a new exact approval request.",
          });
        }
        const currentApproval = await transaction.approvalRequest.findFirst({
          where: {
            id: approval.id,
            merchantId: claims.merchantId,
            userId: buyerId,
            tokenHash,
            expiresAt: { gt: new Date() },
          },
        });
        if (
          !currentApproval ||
          (currentApproval.status !== ApprovalRequestStatus.PENDING &&
            currentApproval.status !== ApprovalRequestStatus.APPROVED)
        ) {
          throw new ConflictException({
            code: "APPROVAL_LINK_ALREADY_USED",
            message: "This single-use approval link was already claimed.",
          });
        }
        if (currentApproval.status === ApprovalRequestStatus.APPROVED) {
          const existingAuthorization = await transaction.authorization.findFirst({
            where: {
              id: authorizationId,
              merchantId: claims.merchantId,
              userId: buyerId,
              agentId: intent.agentId,
              productVariantId: claims.productVariantId,
              boundIntentId: claims.purchaseIntentId,
              type: AuthorizationType.ONE_TIME,
              status: AuthorizationStatus.ACTIVE,
              maxAmountMinor: BigInt(claims.amountMinor),
              currency: claims.currency,
              usesRemaining: 1,
              expiresAt: { gt: new Date() },
            },
          });
          if (!existingAuthorization) {
            throw new ConflictException({
              code: "APPROVAL_RESUME_UNAVAILABLE",
              message: "The claimed approval has no matching active authorization; payment was not started.",
            });
          }
          return { intent, item };
        }

        const consumedLink = await transaction.approvalRequest.updateMany({
          where: {
            id: approval.id,
            merchantId: claims.merchantId,
            tokenHash,
            status: ApprovalRequestStatus.PENDING,
          },
          data: { status: ApprovalRequestStatus.APPROVED },
        });
        if (consumedLink.count !== 1) {
          throw new ConflictException({
            code: "APPROVAL_LINK_ALREADY_USED",
            message: "This single-use approval link was claimed concurrently.",
          });
        }
        const exactAuthorization = await transaction.authorization.create({
          data: {
            id: authorizationId,
            merchantId: claims.merchantId,
            userId: buyerId,
            agentId: intent.agentId,
            productVariantId: claims.productVariantId,
            boundIntentId: claims.purchaseIntentId,
            type: AuthorizationType.ONE_TIME,
            status: AuthorizationStatus.ACTIVE,
            maxAmountMinor: BigInt(claims.amountMinor),
            currency: claims.currency,
            maxQuantity: item.quantity,
            subscriptionsAllowed: false,
            usesRemaining: 1,
            expiresAt: claims.expiresAt,
          },
        });
        await this.audit.append(
          {
            merchantId: claims.merchantId,
            purchaseIntentId: claims.purchaseIntentId,
            actorType: ActorType.USER,
            actorId: buyerId,
            eventType: "BUYER_APPROVAL_CLAIMED",
            data: {
              approvalRequestId: approval.id,
              authorizationId: exactAuthorization.id,
              productVariantId: claims.productVariantId,
              exactAmountMinor: claims.amountMinor,
              currency: claims.currency,
              usesRemaining: 1,
              expiresAt: claims.expiresAt.toISOString(),
            },
          },
          transaction,
        );
        return { intent, item };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const quote = await this.quotes.createFreshQuote({
      merchantId: claims.merchantId,
      purchaseIntentId: claims.purchaseIntentId,
      productVariantId: claims.productVariantId,
      quantity: claimed.item.quantity,
    });
    const constraints = claimed.intent.constraints as unknown as SearchConstraints;
    const authorization = await this.authorizations.evaluate({
      merchantId: claims.merchantId,
      userId: buyerId,
      agentId: claimed.intent.agentId,
      purchaseIntentId: claims.purchaseIntentId,
      productVariantId: claims.productVariantId,
      quote,
      constraints,
    });
    const currentAgent = await this.database.agent.findFirst({
      where: { id: claimed.intent.agentId, merchantId: claims.merchantId },
      select: { status: true },
    });
    const policy = await this.policies.evaluate({
      merchantId: claims.merchantId,
      quote,
      constraints,
      authorization: authorization.authorization,
      authorizationReasons: authorization.reasons,
      agentActive: currentAgent?.status === AgentStatus.ACTIVE,
    });
    await this.audit.append({
      merchantId: claims.merchantId,
      purchaseIntentId: claims.purchaseIntentId,
      actorType: ActorType.SYSTEM,
      eventType: "POST_APPROVAL_POLICY_EVALUATED",
      data: policy as unknown as Prisma.InputJsonValue,
    });

    if (policy.outcome !== "ALLOW" || authorization.authorization?.authorizationId !== authorizationId) {
      await this.database.$transaction(async (transaction) => {
        await transaction.authorization.updateMany({
          where: { id: authorizationId, merchantId: claims.merchantId, status: AuthorizationStatus.ACTIVE },
          data: { status: AuthorizationStatus.REVOKED },
        });
        await transaction.approvalRequest.updateMany({
          where: { id: approval.id, merchantId: claims.merchantId, status: ApprovalRequestStatus.APPROVED },
          data: { status: ApprovalRequestStatus.EXPIRED, usedAt: new Date() },
        });
        await this.audit.append(
          {
            merchantId: claims.merchantId,
            purchaseIntentId: claims.purchaseIntentId,
            actorType: ActorType.SYSTEM,
            eventType: "BUYER_APPROVAL_REVALIDATION_FAILED",
            data: { reasons: policy.reasons, amountChargedMinor: 0 },
          },
          transaction,
        );
      });
      throw new ConflictException({
        code: "APPROVAL_REVALIDATION_FAILED",
        message: "Fresh quote or deterministic policy validation failed. ₹0 charged.",
      });
    }

    this.stateMachine.assertTransition("AWAITING_APPROVAL", "APPROVED");
    await this.database.$transaction(
      async (transaction) => {
        const used = await transaction.approvalRequest.updateMany({
          where: { id: approval.id, merchantId: claims.merchantId, status: ApprovalRequestStatus.APPROVED },
          data: { status: ApprovalRequestStatus.USED, usedAt: new Date() },
        });
        const resumed = await transaction.purchaseIntent.updateMany({
          where: {
            id: claims.purchaseIntentId,
            merchantId: claims.merchantId,
            status: IntentStatus.AWAITING_APPROVAL,
          },
          data: {
            status: IntentStatus.APPROVED,
            reasonCode: null,
            authorizationId,
          },
        });
        if (used.count !== 1 || resumed.count !== 1) {
          throw new ConflictException({
            code: "APPROVAL_FINALIZATION_CONFLICT",
            message: "Approval state changed concurrently; payment was not started.",
          });
        }
        await this.audit.append(
          {
            merchantId: claims.merchantId,
            purchaseIntentId: claims.purchaseIntentId,
            actorType: ActorType.USER,
            actorId: buyerId,
            eventType: "BUYER_APPROVAL_CONSUMED",
            data: {
              approvalRequestId: approval.id,
              authorizationId,
              exactAmountMinor: claims.amountMinor,
              currency: claims.currency,
              singleUseLink: true,
            },
          },
          transaction,
        );
        await this.audit.append(
          {
            merchantId: claims.merchantId,
            purchaseIntentId: claims.purchaseIntentId,
            actorType: ActorType.USER,
            actorId: buyerId,
            eventType: "INTENT_STATE_CHANGED",
            data: { from: "AWAITING_APPROVAL", to: "APPROVED", reasonCode: null },
          },
          transaction,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return {
      status: "APPROVED",
      purchaseIntentId: claims.purchaseIntentId,
      approvalRequestId: approval.id,
      authorization: {
        id: authorizationId,
        type: "ONE_TIME",
        status: "ACTIVE",
        productVariantId: claims.productVariantId,
        boundIntentId: claims.purchaseIntentId,
        exactAmountMinor: claims.amountMinor,
        currency: claims.currency,
        usesRemaining: 1,
        expiresAt: claims.expiresAt.toISOString(),
      },
      quote,
      policyDecision: policy,
      amountChargedMinor: 0,
    };
  }

  private async resolveToken(token: string): Promise<{
    claims: ApprovalTokenClaims;
    approval: ApprovalRequest;
  }> {
    let claims: ApprovalTokenClaims;
    try {
      claims = verifyApprovalToken(token, this.config.value.approvalLinkSecret);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("expired")) {
        throw new GoneException({ code: "APPROVAL_LINK_EXPIRED", message: "This approval link has expired." });
      }
      throw this.invalidToken();
    }
    const approval = await this.database.approvalRequest.findUnique({
      where: { id: claims.approvalRequestId },
    });
    if (
      !approval ||
      approval.tokenHash !== hashApprovalToken(token) ||
      approval.merchantId !== claims.merchantId ||
      approval.purchaseIntentId !== claims.purchaseIntentId ||
      approval.userId !== claims.userId ||
      approval.productVariantId !== claims.productVariantId ||
      approval.approvedAmountMinor !== BigInt(claims.amountMinor) ||
      approval.currency !== claims.currency ||
      approval.expiresAt.getTime() !== claims.expiresAt.getTime()
    ) {
      throw this.invalidToken();
    }
    if (approval.expiresAt <= new Date()) {
      throw new GoneException({ code: "APPROVAL_LINK_EXPIRED", message: "This approval link has expired." });
    }
    return { claims, approval };
  }

  private issueStoredToken(input: {
    id: string;
    merchantId: string;
    purchaseIntentId: string;
    userId: string;
    productVariantId: string;
    amountMinor: number;
    currency: string;
    expiresAt: Date;
  }): string {
    const nonce = createHmac("sha256", this.config.value.approvalLinkSecret)
      .update(`approval-nonce:${input.id}`, "utf8")
      .digest("base64url");
    return issueApprovalToken(
      {
        approvalRequestId: input.id,
        purchaseIntentId: input.purchaseIntentId,
        merchantId: input.merchantId,
        userId: input.userId,
        productVariantId: input.productVariantId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        nonce,
        expiresAt: input.expiresAt,
      },
      this.config.value.approvalLinkSecret,
    );
  }

  private linkResponse(
    token: string,
    approval: {
      id: string;
      purchaseIntentId: string;
      productVariantId: string;
      approvedAmountMinor: bigint;
      currency: string;
      expiresAt: Date;
    },
  ): Record<string, unknown> {
    return {
      approvalRequestId: approval.id,
      purchaseIntentId: approval.purchaseIntentId,
      approvalUrl: `${this.config.value.buyerApprovalBaseUrl}/${encodeURIComponent(token)}`,
      productVariantId: approval.productVariantId,
      exactAmountMinor: minorToWire(approval.approvedAmountMinor),
      currency: approval.currency,
      expiresAt: approval.expiresAt.toISOString(),
      singleUse: true,
    };
  }

  private invalidToken(): UnauthorizedException {
    return new UnauthorizedException({
      code: "INVALID_APPROVAL_LINK",
      message: "This approval link is invalid or no longer matches its stored request.",
    });
  }
}
