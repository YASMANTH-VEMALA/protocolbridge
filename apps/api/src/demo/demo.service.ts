import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ActorType,
  AgentStatus,
  ApprovalRequestStatus,
  AuthorizationStatus,
  IntentStatus,
  MerchantStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from "@protocolbridge/database";
import { minorToWire } from "@protocolbridge/types";

import { AuditService } from "../audit/audit.service";
import type { AuthenticatedAgent } from "../auth/auth.types";
import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";

export type GoldenPriceScenario = "BASELINE" | "PRICE_INCREASED";

const golden = {
  merchantId: "mer_solekart",
  agentId: "agt_demo_shopper",
  buyerId: "usr_demo_buyer",
  variantId: "var_runfalcon_black_9",
  baseAuthorizationId: "auth_demo_buyer_2000",
  baselinePriceMinor: 189_900n,
  increasedPriceMinor: 229_900n,
  baselineStock: 12,
} as const;

@Injectable()
export class DemoService {
  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  async setGoldenPrice(
    agent: AuthenticatedAgent,
    scenario: GoldenPriceScenario,
  ): Promise<Record<string, unknown>> {
    this.assertGoldenDemoAccess(agent);
    const priceMinor =
      scenario === "BASELINE" ? golden.baselinePriceMinor : golden.increasedPriceMinor;
    const changed = await this.database.productVariant.updateMany({
      where: { id: golden.variantId, merchantId: golden.merchantId },
      data: { priceMinor, active: true },
    });
    if (changed.count !== 1) {
      throw new NotFoundException({
        code: "GOLDEN_VARIANT_NOT_FOUND",
        message: "The seeded SoleKart golden variant is missing.",
      });
    }
    const variant = await this.database.productVariant.findFirstOrThrow({
      where: { id: golden.variantId, merchantId: golden.merchantId },
    });
    await this.audit.append({
      merchantId: golden.merchantId,
      actorType: ActorType.AGENT,
      actorId: agent.id,
      eventType: "GOLDEN_DEMO_PRICE_CHANGED",
      data: {
        scenario,
        productVariantId: variant.id,
        priceMinor: minorToWire(variant.priceMinor),
        currency: variant.currency,
        variantVersion: variant.version,
      },
    });
    return {
      scenario,
      productVariantId: variant.id,
      priceMinor: minorToWire(variant.priceMinor),
      currency: variant.currency,
      stock: variant.stock,
      variantVersion: variant.version,
    };
  }

  async reset(agent: AuthenticatedAgent): Promise<Record<string, unknown>> {
    this.assertGoldenDemoAccess(agent);
    const now = new Date();
    const result = await this.database.$transaction(
      async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT id FROM "ProductVariant"
          WHERE id = ${golden.variantId} AND "merchantId" = ${golden.merchantId}
          FOR UPDATE
        `);
        const openIntents = await transaction.purchaseIntent.findMany({
          where: {
            merchantId: golden.merchantId,
            agentId: golden.agentId,
            status: {
              in: [
                IntentStatus.RECEIVED,
                IntentStatus.RESOLVING,
                IntentStatus.QUOTED,
                IntentStatus.POLICY_CHECK,
                IntentStatus.APPROVED,
                IntentStatus.AWAITING_APPROVAL,
                IntentStatus.PAYMENT_PROCESSING,
              ],
            },
          },
          select: { id: true, status: true },
        });
        await transaction.inventoryReservation.updateMany({
          where: { merchantId: golden.merchantId, status: ReservationStatus.ACTIVE },
          data: { status: ReservationStatus.RELEASED },
        });
        await transaction.payment.updateMany({
          where: {
            merchantId: golden.merchantId,
            status: { in: [PaymentStatus.CREATED, PaymentStatus.AUTHORIZED] },
          },
          data: {
            status: PaymentStatus.FAILED,
            failureCode: "DEMO_RESET",
            failureDescription: "The explicit non-production golden demo reset canceled this attempt.",
          },
        });
        await transaction.order.updateMany({
          where: { merchantId: golden.merchantId, status: OrderStatus.PENDING_PAYMENT },
          data: { status: OrderStatus.CANCELED },
        });
        await transaction.approvalRequest.updateMany({
          where: {
            merchantId: golden.merchantId,
            status: { in: [ApprovalRequestStatus.PENDING, ApprovalRequestStatus.APPROVED] },
          },
          data: { status: ApprovalRequestStatus.EXPIRED, usedAt: now },
        });
        await transaction.authorization.updateMany({
          where: {
            merchantId: golden.merchantId,
            id: { not: golden.baseAuthorizationId },
            type: "ONE_TIME",
            status: AuthorizationStatus.ACTIVE,
          },
          data: { status: AuthorizationStatus.REVOKED },
        });
        for (const intent of openIntents) {
          await transaction.purchaseIntent.update({
            where: { id: intent.id },
            data: { status: IntentStatus.CANCELED, reasonCode: "DEMO_RESET" },
          });
          await this.audit.append(
            {
              merchantId: golden.merchantId,
              purchaseIntentId: intent.id,
              actorType: ActorType.AGENT,
              actorId: agent.id,
              eventType: "GOLDEN_DEMO_INTENT_CANCELED",
              data: { from: intent.status, to: "CANCELED", reasonCode: "DEMO_RESET", amountChargedMinor: 0 },
            },
            transaction,
          );
        }
        await transaction.authorization.update({
          where: { id: golden.baseAuthorizationId },
          data: {
            merchantId: golden.merchantId,
            userId: golden.buyerId,
            agentId: golden.agentId,
            productVariantId: null,
            boundIntentId: null,
            type: "MAX_AMOUNT",
            status: AuthorizationStatus.ACTIVE,
            maxAmountMinor: 200_000n,
            currency: "INR",
            maxQuantity: 1,
            subscriptionsAllowed: false,
            usesRemaining: null,
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            consumedAt: null,
          },
        });
        await transaction.productVariant.update({
          where: { id: golden.variantId },
          data: {
            priceMinor: golden.baselinePriceMinor,
            stock: golden.baselineStock,
            currency: "INR",
            active: true,
          },
        });
        await transaction.agent.update({
          where: { id: golden.agentId },
          data: { status: AgentStatus.ACTIVE },
        });
        await transaction.merchant.update({
          where: { id: golden.merchantId },
          data: { status: MerchantStatus.ACTIVE },
        });
        await this.audit.append(
          {
            merchantId: golden.merchantId,
            actorType: ActorType.AGENT,
            actorId: agent.id,
            eventType: "GOLDEN_DEMO_RESET",
            data: {
              productVariantId: golden.variantId,
              priceMinor: minorToWire(golden.baselinePriceMinor),
              stock: golden.baselineStock,
              baseAuthorizationAmountMinor: 200_000,
              canceledIntentCount: openIntents.length,
              auditEventsDeleted: 0,
            },
          },
          transaction,
        );
        return { canceledIntentCount: openIntents.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return {
      ready: true,
      scenario: "BASELINE",
      merchantId: golden.merchantId,
      agentId: golden.agentId,
      buyerId: golden.buyerId,
      productVariantId: golden.variantId,
      priceMinor: minorToWire(golden.baselinePriceMinor),
      currency: "INR",
      stock: golden.baselineStock,
      baseAuthorizationAmountMinor: 200_000,
      canceledIntentCount: result.canceledIntentCount,
      auditEventsDeleted: 0,
    };
  }

  private assertGoldenDemoAccess(agent: AuthenticatedAgent): void {
    if (
      this.config.value.nodeEnv === "production" ||
      agent.merchantId !== golden.merchantId ||
      agent.id !== golden.agentId
    ) {
      throw new ForbiddenException({
        code: "GOLDEN_DEMO_ENDPOINT_DISABLED",
        message: "Golden demo controls are non-production and restricted to the seeded SoleKart agent.",
      });
    }
  }
}
