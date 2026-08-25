import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ActorType, AgentStatus, IntentStatus, OrderChannel, OrderStatus, PaymentStatus, Prisma } from "@protocolbridge/database";
import type { RazorpayOrderGateway } from "@protocolbridge/razorpay";
import type { CheckoutAction, PolicyDecision, SearchConstraints } from "@protocolbridge/types";
import { randomUUID } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import type { AuthenticatedAgent } from "../auth/auth.types";
import { AuthorizationService } from "../authorization/authorization.service";
import { PrismaService } from "../database/prisma.service";
import { IntentStateService } from "../intents/intent-state.service";
import { InventoryReservationService } from "../inventory/inventory-reservation.service";
import { PolicyService } from "../policy/policy.service";
import { QuoteService } from "../quote/quote.service";
import { RAZORPAY_GATEWAY } from "./razorpay-gateway.provider";

export type ExecuteIntentResult =
  | {
      status: "PAYMENT_PROCESSING";
      checkout: CheckoutAction;
      policyDecision: PolicyDecision;
      amountChargedMinor: 0;
    }
  | {
      status: "AWAITING_APPROVAL" | "BLOCKED";
      checkout: null;
      policyDecision: PolicyDecision;
      amountChargedMinor: 0;
    };

@Injectable()
export class PaymentExecutionService {
  constructor(
    private readonly database: PrismaService,
    private readonly quotes: QuoteService,
    private readonly authorizations: AuthorizationService,
    private readonly policies: PolicyService,
    private readonly reservations: InventoryReservationService,
    private readonly states: IntentStateService,
    private readonly audit: AuditService,
    @Inject(RAZORPAY_GATEWAY) private readonly gateway: RazorpayOrderGateway,
  ) {}

  async execute(agent: AuthenticatedAgent, intentId: string): Promise<ExecuteIntentResult> {
    const intent = await this.database.purchaseIntent.findFirst({
      where: { id: intentId, merchantId: agent.merchantId, agentId: agent.id },
      include: { items: true },
    });
    if (!intent) {
      throw new ConflictException({
        code: "INTENT_NOT_FOUND",
        message: "The purchase intent does not exist in the authenticated merchant tenant.",
      });
    }
    if (intent.status === IntentStatus.PAYMENT_PROCESSING) {
      throw new ConflictException({
        code: "PAYMENT_ALREADY_IN_PROGRESS",
        message: "This intent already has a payment attempt in progress.",
      });
    }
    if (intent.status !== IntentStatus.APPROVED) {
      throw new ConflictException({
        code: "INTENT_NOT_APPROVED",
        message: `Intent status ${intent.status} cannot start payment.`,
      });
    }
    const item = intent.items[0];
    if (!item || intent.items.length !== 1) {
      throw new ConflictException({
        code: "UNSUPPORTED_CART_SHAPE",
        message: "P0 payment execution requires exactly one resolved intent item.",
      });
    }
    const constraints = intent.constraints as unknown as SearchConstraints;

    // This is deliberately a new database-backed quote immediately before execution.
    const quote = await this.quotes.createFreshQuote({
      merchantId: agent.merchantId,
      purchaseIntentId: intent.id,
      productVariantId: item.productVariantId,
      quantity: item.quantity,
    });
    await this.audit.append({
      merchantId: agent.merchantId,
      purchaseIntentId: intent.id,
      actorType: ActorType.SYSTEM,
      eventType: "QUOTE_REFRESHED_BEFORE_EXECUTION",
      data: quote as unknown as Prisma.InputJsonValue,
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
      eventType: "PRE_PAYMENT_POLICY_EVALUATED",
      data: policyDecision as unknown as Prisma.InputJsonValue,
    });

    if (policyDecision.outcome !== "ALLOW") {
      const status = policyDecision.outcome === "BLOCK" ? "BLOCKED" : "AWAITING_APPROVAL";
      await this.states.transition({
        merchantId: agent.merchantId,
        intentId: intent.id,
        from: "APPROVED",
        to: status,
        reasonCode: policyDecision.reasons[0] ?? null,
      });
      await this.reservations.releaseForIntent(agent.merchantId, intent.id);
      return { status, checkout: null, policyDecision, amountChargedMinor: 0 };
    }

    if (!authorization.authorization) {
      throw new ConflictException({
        code: "AUTHORIZATION_NOT_FOUND",
        message: "An allowed payment must be backed by a current bounded authorization.",
      });
    }
    await this.database.purchaseIntent.updateMany({
      where: { id: intent.id, merchantId: agent.merchantId, status: IntentStatus.APPROVED },
      data: { authorizationId: authorization.authorization.authorizationId },
    });

    if (!this.gateway.configured || !this.gateway.keyId) {
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        actorType: ActorType.SYSTEM,
        eventType: "PAYMENT_PROVIDER_NOT_CONFIGURED",
        data: { provider: "RAZORPAY", amountChargedMinor: 0 },
      });
      throw new ServiceUnavailableException({
        code: "PAYMENT_NOT_CONFIGURED",
        message: "Razorpay Test Mode credentials are required to create a payment order. ₹0 charged.",
      });
    }

    const reservation = await this.reservations.reserve({
      merchantId: agent.merchantId,
      purchaseIntentId: intent.id,
      quote,
    });
    const prepared = await this.prepareInternalAttempt({
      merchantId: agent.merchantId,
      intentId: intent.id,
      buyerId: intent.userId,
      quote,
      reservationId: reservation.id,
    });

    try {
      const providerOrder = await this.gateway.createOrder({
        amountMinor: quote.totalMinor,
        currency: quote.currency,
        receipt: `pb_${prepared.paymentId}`,
        notes: {
          internalPaymentId: prepared.paymentId,
          internalOrderId: prepared.orderId,
          purchaseIntentId: intent.id,
          merchantId: agent.merchantId,
        },
      });
      if (
        providerOrder.amountMinor !== quote.totalMinor ||
        providerOrder.currency !== quote.currency
      ) {
        throw new Error("Razorpay returned an order whose amount or currency did not match the quote.");
      }
      await this.database.payment.update({
        where: { id: prepared.paymentId },
        data: { razorpayOrderId: providerOrder.id },
      });
      await this.states.transition({
        merchantId: agent.merchantId,
        intentId: intent.id,
        from: "APPROVED",
        to: "PAYMENT_PROCESSING",
        actorType: ActorType.SYSTEM,
      });
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        orderId: prepared.orderId,
        actorType: ActorType.SYSTEM,
        eventType: "RAZORPAY_ORDER_CREATED",
        data: {
          paymentId: prepared.paymentId,
          razorpayOrderId: providerOrder.id,
          amountMinor: quote.totalMinor,
          currency: quote.currency,
          mode: "TEST",
        },
      });
      return {
        status: "PAYMENT_PROCESSING",
        checkout: {
          provider: "RAZORPAY",
          keyId: this.gateway.keyId,
          razorpayOrderId: providerOrder.id,
          internalOrderId: prepared.orderId,
          paymentId: prepared.paymentId,
          amountMinor: quote.totalMinor,
          currency: quote.currency,
          name: "SoleKart via ProtocolBridge",
          description: quote.lines[0]?.productName ?? "Verified purchase",
        },
        policyDecision,
        amountChargedMinor: 0,
      };
    } catch {
      await this.database.payment.updateMany({
        where: { id: prepared.paymentId, merchantId: agent.merchantId, status: PaymentStatus.CREATED },
        data: {
          status: PaymentStatus.FAILED,
          failureCode: "RAZORPAY_ORDER_CREATION_FAILED",
          failureDescription: "Razorpay Test Mode order creation did not complete.",
        },
      });
      await this.reservations.releaseForIntent(agent.merchantId, intent.id);
      await this.audit.append({
        merchantId: agent.merchantId,
        purchaseIntentId: intent.id,
        orderId: prepared.orderId,
        actorType: ActorType.SYSTEM,
        eventType: "RAZORPAY_ORDER_CREATION_FAILED",
        data: { paymentId: prepared.paymentId, amountChargedMinor: 0 },
      });
      throw new BadGatewayException({
        code: "RAZORPAY_ORDER_CREATION_FAILED",
        message: "Razorpay Test Mode order creation failed. ₹0 charged.",
      });
    }
  }

  private async prepareInternalAttempt(input: {
    merchantId: string;
    intentId: string;
    buyerId: string;
    quote: Awaited<ReturnType<QuoteService["createFreshQuote"]>>;
    reservationId: string;
  }): Promise<{ orderId: string; paymentId: string }> {
    return this.database.$transaction(
      async (transaction) => {
        let order = await transaction.order.findUnique({
          where: { purchaseIntentId: input.intentId },
        });
        if (order && (order.merchantId !== input.merchantId || order.status !== OrderStatus.PENDING_PAYMENT)) {
          throw new ConflictException({
            code: "ORDER_STATE_CONFLICT",
            message: "The existing order cannot accept another payment attempt.",
          });
        }
        const line = input.quote.lines[0]!;
        if (!order) {
          order = await transaction.order.create({
            data: {
              merchantId: input.merchantId,
              buyerId: input.buyerId,
              purchaseIntentId: input.intentId,
              orderNumber: `PB-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
              channel: OrderChannel.AGENT,
              status: OrderStatus.PENDING_PAYMENT,
              totalMinor: BigInt(input.quote.totalMinor),
              currency: input.quote.currency,
              items: {
                create: {
                  productId: line.productId,
                  productVariantId: line.productVariantId,
                  productName: line.productName,
                  variantLabel: line.variantLabel,
                  quantity: line.quantity,
                  unitAmountMinor: BigInt(line.unitAmountMinor),
                  lineTotalMinor: BigInt(line.lineTotalMinor),
                },
              },
            },
          });
        } else {
          await transaction.orderItem.deleteMany({ where: { orderId: order.id } });
          order = await transaction.order.update({
            where: { id: order.id },
            data: {
              totalMinor: BigInt(input.quote.totalMinor),
              currency: input.quote.currency,
              items: {
                create: {
                  productId: line.productId,
                  productVariantId: line.productVariantId,
                  productName: line.productName,
                  variantLabel: line.variantLabel,
                  quantity: line.quantity,
                  unitAmountMinor: BigInt(line.unitAmountMinor),
                  lineTotalMinor: BigInt(line.lineTotalMinor),
                },
              },
            },
          });
        }
        const attemptCount = await transaction.payment.count({ where: { orderId: order.id } });
        const payment = await transaction.payment.create({
          data: {
            merchantId: input.merchantId,
            orderId: order.id,
            purchaseIntentId: input.intentId,
            status: PaymentStatus.CREATED,
            amountMinor: BigInt(input.quote.totalMinor),
            currency: input.quote.currency,
            attempt: attemptCount + 1,
          },
        });
        const attached = await transaction.inventoryReservation.updateMany({
          where: {
            id: input.reservationId,
            merchantId: input.merchantId,
            purchaseIntentId: input.intentId,
            status: "ACTIVE",
          },
          data: { orderId: order.id },
        });
        if (attached.count !== 1) throw new Error("Inventory reservation changed before order creation.");
        await this.audit.append(
          {
            merchantId: input.merchantId,
            purchaseIntentId: input.intentId,
            orderId: order.id,
            actorType: ActorType.SYSTEM,
            eventType: "INTERNAL_PAYMENT_ATTEMPT_CREATED",
            data: {
              paymentId: payment.id,
              attempt: payment.attempt,
              amountMinor: input.quote.totalMinor,
              currency: input.quote.currency,
            },
          },
          transaction,
        );
        return { orderId: order.id, paymentId: payment.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
