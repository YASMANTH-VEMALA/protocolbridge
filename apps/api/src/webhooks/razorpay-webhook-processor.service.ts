import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { Injectable, Logger } from "@nestjs/common";
import {
  ActorType,
  AuthorizationStatus,
  AuthorizationType,
  IntentStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ReservationStatus,
  WebhookStatus,
} from "@protocolbridge/database";

import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../database/prisma.service";
import {
  orderEntity,
  paymentEntity,
  razorpayWebhookPayloadSchema,
  type RazorpayWebhookEntity,
  type RazorpayWebhookPayload,
} from "./razorpay-webhook.types";

interface LockedPaymentRow {
  id: string;
  merchantId: string;
  orderId: string;
  purchaseIntentId: string | null;
  status: PaymentStatus;
  amountMinor: bigint;
  currency: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
}

@Injectable()
export class RazorpayWebhookProcessorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RazorpayWebhookProcessorService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.database.webhookEvent.updateMany({
      where: {
        status: WebhookStatus.PROCESSING,
        updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
      },
      data: { status: WebhookStatus.RECEIVED },
    });
    this.timer = setInterval(() => void this.drainOnce(), 500);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drainOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const event = await this.database.webhookEvent.findFirst({
        where: {
          provider: "RAZORPAY",
          status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
          attempts: { lt: 5 },
        },
        orderBy: { receivedAt: "asc" },
      });
      if (!event) return;
      const claimed = await this.database.webhookEvent.updateMany({
        where: { id: event.id, status: event.status, attempts: event.attempts },
        data: { status: WebhookStatus.PROCESSING, attempts: { increment: 1 }, lastError: null },
      });
      if (claimed.count !== 1) return;

      try {
        const payload = razorpayWebhookPayloadSchema.parse(event.payload);
        await this.processPayload(payload);
        await this.database.webhookEvent.update({
          where: { id: event.id },
          data: { status: WebhookStatus.PROCESSED, processedAt: new Date(), lastError: null },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message.slice(0, 1_000) : "Unknown webhook error";
        await this.database.webhookEvent.update({
          where: { id: event.id },
          data: { status: WebhookStatus.FAILED, lastError: message },
        });
        this.logger.error(`Webhook ${event.externalEventId} failed: ${message}`);
      }
    } finally {
      this.running = false;
    }
  }

  private async processPayload(payload: RazorpayWebhookPayload): Promise<void> {
    const payment = paymentEntity(payload);
    if (payload.event === "payment.captured" || payload.event === "order.paid") {
      if (!payment) throw new Error(`${payload.event} did not contain a payment entity.`);
      await this.applyCaptured(payment, orderEntity(payload));
      return;
    }
    if (payload.event === "payment.authorized") {
      if (!payment) throw new Error("payment.authorized did not contain a payment entity.");
      await this.applyAuthorized(payment);
      return;
    }
    if (payload.event === "payment.failed") {
      if (!payment) throw new Error("payment.failed did not contain a payment entity.");
      await this.applyFailed(payment);
    }
    // Other verified Razorpay events are intentionally acknowledged but unsupported in P0.
  }

  private async findInternalPayment(entity: RazorpayWebhookEntity): Promise<{ id: string }> {
    const byPayment = await this.database.payment.findUnique({
      where: { razorpayPaymentId: entity.id },
      select: { id: true },
    });
    if (byPayment) return byPayment;
    if (entity.order_id) {
      const byOrder = await this.database.payment.findUnique({
        where: { razorpayOrderId: entity.order_id },
        select: { id: true },
      });
      if (byOrder) return byOrder;
    }
    const internalPaymentId = entity.notes?.["internalPaymentId"];
    if (typeof internalPaymentId === "string") {
      const byNote = await this.database.payment.findUnique({
        where: { id: internalPaymentId },
        select: { id: true },
      });
      if (byNote) return byNote;
    }
    throw new Error("Webhook could not be reconciled to an internal payment.");
  }

  private async applyAuthorized(entity: RazorpayWebhookEntity): Promise<void> {
    const internal = await this.findInternalPayment(entity);
    await this.database.$transaction(async (transaction) => {
      const payment = await transaction.payment.findUnique({ where: { id: internal.id } });
      if (!payment) throw new Error("Internal payment disappeared during authorization reconciliation.");
      this.assertProviderAmounts(payment.amountMinor, payment.currency, entity);
      this.assertProviderIdentifiers(payment, entity);
      if (payment.status !== PaymentStatus.CAPTURED) {
        await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.AUTHORIZED,
            razorpayPaymentId: entity.id,
            ...(entity.order_id ? { razorpayOrderId: entity.order_id } : {}),
          },
        });
      }
      await this.audit.append(
        {
          merchantId: payment.merchantId,
          ...(payment.purchaseIntentId ? { purchaseIntentId: payment.purchaseIntentId } : {}),
          orderId: payment.orderId,
          actorType: ActorType.WEBHOOK,
          eventType:
            payment.status === PaymentStatus.CAPTURED
              ? "OUT_OF_ORDER_AUTHORIZATION_IGNORED"
              : "PAYMENT_AUTHORIZED",
          data: { paymentId: payment.id, razorpayPaymentId: entity.id },
        },
        transaction,
      );
    });
  }

  private async applyCaptured(
    entity: RazorpayWebhookEntity,
    providerOrder: RazorpayWebhookEntity | null,
  ): Promise<void> {
    const internal = await this.findInternalPayment(entity);
    await this.database.$transaction(
      async (transaction) => {
        const locked = await transaction.$queryRaw<LockedPaymentRow[]>(Prisma.sql`
          SELECT id, "merchantId", "orderId", "purchaseIntentId", status,
                 "amountMinor", currency, "razorpayOrderId", "razorpayPaymentId"
          FROM "Payment" WHERE id = ${internal.id} FOR UPDATE
        `);
        const payment = locked[0];
        if (!payment) throw new Error("Internal payment disappeared during capture reconciliation.");
        this.assertProviderAmounts(payment.amountMinor, payment.currency, entity);
        this.assertProviderIdentifiers(payment, entity);
        if (providerOrder?.amount !== undefined && providerOrder.amount !== Number(payment.amountMinor)) {
          throw new Error("Provider order amount does not match the internal payment amount.");
        }
        if (payment.status === PaymentStatus.CAPTURED) {
          await this.audit.append(
            {
              merchantId: payment.merchantId,
              ...(payment.purchaseIntentId ? { purchaseIntentId: payment.purchaseIntentId } : {}),
              orderId: payment.orderId,
              actorType: ActorType.WEBHOOK,
              eventType: "DUPLICATE_CAPTURE_IGNORED",
              data: { paymentId: payment.id, razorpayPaymentId: entity.id },
            },
            transaction,
          );
          return;
        }

        const reservation = await transaction.inventoryReservation.findFirst({
          where: {
            merchantId: payment.merchantId,
            orderId: payment.orderId,
            status: ReservationStatus.ACTIVE,
          },
        });
        if (!reservation) {
          throw new Error("Captured payment has no active inventory reservation; operator reconciliation required.");
        }
        await transaction.$queryRaw(Prisma.sql`
          SELECT id FROM "ProductVariant"
          WHERE id = ${reservation.productVariantId} AND "merchantId" = ${payment.merchantId}
          FOR UPDATE
        `);
        const decremented = await transaction.productVariant.updateMany({
          where: {
            id: reservation.productVariantId,
            merchantId: payment.merchantId,
            stock: { gte: reservation.quantity },
          },
          data: { stock: { decrement: reservation.quantity } },
        });
        if (decremented.count !== 1) {
          throw new Error("Captured payment inventory cannot be decremented; operator reconciliation required.");
        }

        await transaction.inventoryReservation.update({
          where: { id: reservation.id },
          data: { status: ReservationStatus.CONVERTED },
        });
        await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.CAPTURED,
            razorpayPaymentId: entity.id,
            ...(entity.order_id ? { razorpayOrderId: entity.order_id } : {}),
          },
        });
        await transaction.order.update({
          where: { id: payment.orderId },
          data: { status: OrderStatus.CONFIRMED },
        });
        if (payment.purchaseIntentId) {
          await transaction.purchaseIntent.updateMany({
            where: {
              id: payment.purchaseIntentId,
              merchantId: payment.merchantId,
              status: IntentStatus.PAYMENT_PROCESSING,
            },
            data: { status: IntentStatus.COMPLETED, reasonCode: null },
          });
          const intent = await transaction.purchaseIntent.findFirst({
            where: { id: payment.purchaseIntentId, merchantId: payment.merchantId },
            select: { authorizationId: true },
          });
          if (intent?.authorizationId) {
            const authorization = await transaction.authorization.findFirst({
              where: { id: intent.authorizationId, merchantId: payment.merchantId },
            });
            if (authorization?.type === AuthorizationType.ONE_TIME) {
              const consumed = await transaction.authorization.updateMany({
                where: {
                  id: authorization.id,
                  merchantId: payment.merchantId,
                  status: AuthorizationStatus.ACTIVE,
                  usesRemaining: { gt: 0 },
                  OR: [{ boundIntentId: null }, { boundIntentId: payment.purchaseIntentId }],
                },
                data: {
                  status: AuthorizationStatus.CONSUMED,
                  usesRemaining: { decrement: 1 },
                  consumedAt: new Date(),
                },
              });
              if (consumed.count !== 1) {
                throw new Error("One-time authorization could not be consumed atomically.");
              }
            }
          }
        }
        await this.audit.append(
          {
            merchantId: payment.merchantId,
            ...(payment.purchaseIntentId ? { purchaseIntentId: payment.purchaseIntentId } : {}),
            orderId: payment.orderId,
            actorType: ActorType.WEBHOOK,
            eventType: "PAYMENT_CAPTURED_ORDER_CONFIRMED",
            data: {
              paymentId: payment.id,
              razorpayPaymentId: entity.id,
              amountMinor: Number(payment.amountMinor),
              currency: payment.currency,
              reservationId: reservation.id,
              inventoryDecremented: reservation.quantity,
            },
          },
          transaction,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async applyFailed(entity: RazorpayWebhookEntity): Promise<void> {
    const internal = await this.findInternalPayment(entity);
    await this.database.$transaction(async (transaction) => {
      const payment = await transaction.payment.findUnique({ where: { id: internal.id } });
      if (!payment) throw new Error("Internal payment disappeared during failure reconciliation.");
      this.assertProviderAmounts(payment.amountMinor, payment.currency, entity);
      this.assertProviderIdentifiers(payment, entity);
      if (payment.status !== PaymentStatus.CAPTURED) {
        await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.FAILED,
            razorpayPaymentId: entity.id,
            ...(entity.order_id ? { razorpayOrderId: entity.order_id } : {}),
            failureCode: entity.error_code ?? "PAYMENT_FAILED",
            failureDescription: entity.error_description?.slice(0, 1_000) ?? "Razorpay reported payment failure.",
          },
        });
        await transaction.inventoryReservation.updateMany({
          where: {
            merchantId: payment.merchantId,
            orderId: payment.orderId,
            status: ReservationStatus.ACTIVE,
          },
          data: { status: ReservationStatus.RELEASED },
        });
        if (payment.purchaseIntentId) {
          await transaction.purchaseIntent.updateMany({
            where: {
              id: payment.purchaseIntentId,
              merchantId: payment.merchantId,
              status: IntentStatus.PAYMENT_PROCESSING,
            },
            data: { status: IntentStatus.APPROVED, reasonCode: "PAYMENT_FAILED" },
          });
        }
      }
      await this.audit.append(
        {
          merchantId: payment.merchantId,
          ...(payment.purchaseIntentId ? { purchaseIntentId: payment.purchaseIntentId } : {}),
          orderId: payment.orderId,
          actorType: ActorType.WEBHOOK,
          eventType:
            payment.status === PaymentStatus.CAPTURED
              ? "OUT_OF_ORDER_PAYMENT_FAILURE_IGNORED"
              : "PAYMENT_FAILED_RESERVATION_RELEASED",
          data: {
            paymentId: payment.id,
            razorpayPaymentId: entity.id,
            failureCode: entity.error_code ?? "PAYMENT_FAILED",
          },
        },
        transaction,
      );
    });
  }

  private assertProviderAmounts(amountMinor: bigint, currency: string, entity: RazorpayWebhookEntity): void {
    if (entity.amount === undefined || entity.amount !== Number(amountMinor) || entity.currency !== currency) {
      throw new Error("Webhook payment amount or currency does not match the internal payment.");
    }
  }

  private assertProviderIdentifiers(
    payment: { razorpayOrderId: string | null; razorpayPaymentId: string | null },
    entity: RazorpayWebhookEntity,
  ): void {
    if (payment.razorpayOrderId && entity.order_id !== payment.razorpayOrderId) {
      throw new Error("Webhook provider order id does not match the internal payment.");
    }
    if (payment.razorpayPaymentId && payment.razorpayPaymentId !== entity.id) {
      throw new Error("Webhook provider payment id conflicts with the internal payment.");
    }
  }
}
