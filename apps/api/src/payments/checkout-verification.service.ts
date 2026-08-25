import { ConflictException, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ActorType, PaymentStatus } from "@protocolbridge/database";
import { verifyCheckoutSignature } from "@protocolbridge/razorpay";

import { AuditService } from "../audit/audit.service";
import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";

export interface VerifyCheckoutInput {
  paymentId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

@Injectable()
export class CheckoutVerificationService {
  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  async getContext(paymentId: string, userId: string): Promise<{ merchantId: string }> {
    const payment = await this.database.payment.findUnique({
      where: { id: paymentId },
      include: { order: { select: { buyerId: true } } },
    });
    if (!payment || payment.order.buyerId !== userId) {
      throw new ForbiddenException({
        code: "PAYMENT_ACCESS_DENIED",
        message: "The payment is not owned by the authenticated buyer.",
      });
    }
    return { merchantId: payment.merchantId };
  }

  async verify(userId: string, input: VerifyCheckoutInput): Promise<Record<string, unknown>> {
    const razorpay = this.config.value.razorpay;
    if (!razorpay) {
      throw new ServiceUnavailableException({
        code: "PAYMENT_NOT_CONFIGURED",
        message: "Razorpay Test Mode verification is not configured.",
      });
    }
    const payment = await this.database.payment.findUnique({
      where: { id: input.paymentId },
      include: { order: true },
    });
    if (!payment || payment.order.buyerId !== userId) {
      throw new ForbiddenException({
        code: "PAYMENT_ACCESS_DENIED",
        message: "The payment is not owned by the authenticated buyer.",
      });
    }
    if (!payment.razorpayOrderId || payment.razorpayOrderId !== input.razorpayOrderId) {
      throw new UnauthorizedException({
        code: "RAZORPAY_ORDER_MISMATCH",
        message: "Checkout returned a provider order that does not match the stored payment.",
      });
    }
    if (
      !verifyCheckoutSignature({
        razorpayOrderId: payment.razorpayOrderId,
        razorpayPaymentId: input.razorpayPaymentId,
        signature: input.razorpaySignature,
        keySecret: razorpay.keySecret,
      })
    ) {
      throw new UnauthorizedException({
        code: "INVALID_CHECKOUT_SIGNATURE",
        message: "Razorpay checkout signature verification failed.",
      });
    }
    if (
      payment.razorpayPaymentId &&
      payment.razorpayPaymentId !== input.razorpayPaymentId
    ) {
      throw new ConflictException({
        code: "PAYMENT_IDENTIFIER_CONFLICT",
        message: "A different provider payment is already bound to this attempt.",
      });
    }

    await this.database.$transaction(async (transaction) => {
      await transaction.payment.update({
        where: { id: payment.id },
        data: {
          razorpayPaymentId: input.razorpayPaymentId,
          checkoutSignature: input.razorpaySignature,
          ...(payment.status === PaymentStatus.CREATED ? { status: PaymentStatus.AUTHORIZED } : {}),
        },
      });
      await this.audit.append(
        {
          merchantId: payment.merchantId,
          ...(payment.purchaseIntentId ? { purchaseIntentId: payment.purchaseIntentId } : {}),
          orderId: payment.orderId,
          actorType: ActorType.USER,
          actorId: userId,
          eventType: "CHECKOUT_SIGNATURE_VERIFIED",
          data: {
            paymentId: payment.id,
            razorpayOrderId: payment.razorpayOrderId,
            razorpayPaymentId: input.razorpayPaymentId,
            finalPaymentStatus: "PENDING_WEBHOOK_CONFIRMATION",
          },
        },
        transaction,
      );
    });
    return {
      paymentId: payment.id,
      status: "AUTHORIZED",
      orderStatus: payment.order.status,
      finalConfirmation: "PENDING_VERIFIED_WEBHOOK",
    };
  }
}
