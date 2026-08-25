import { ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@protocolbridge/database";
import { verifyWebhookSignature } from "@protocolbridge/razorpay";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";
import { razorpayWebhookPayloadSchema } from "./razorpay-webhook.types";

@Injectable()
export class RazorpayWebhookIngestionService {
  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async ingest(input: {
    externalEventId: string;
    signature: string;
    rawBody: Buffer;
  }): Promise<{ accepted: true; duplicate: boolean }> {
    const razorpay = this.config.value.razorpay;
    if (!razorpay) {
      throw new ServiceUnavailableException({
        code: "PAYMENT_NOT_CONFIGURED",
        message: "Razorpay webhook verification is not configured.",
      });
    }
    if (!input.externalEventId || input.externalEventId.length > 200) {
      throw new ConflictException({
        code: "INVALID_WEBHOOK_EVENT_ID",
        message: "A valid X-Razorpay-Event-Id header is required.",
      });
    }
    if (
      !verifyWebhookSignature({
        rawBody: input.rawBody,
        signature: input.signature,
        webhookSecret: razorpay.webhookSecret,
      })
    ) {
      throw new UnauthorizedException({
        code: "INVALID_WEBHOOK_SIGNATURE",
        message: "Razorpay webhook signature verification failed.",
      });
    }

    let unknownPayload: unknown;
    try {
      unknownPayload = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      throw new ConflictException({
        code: "INVALID_WEBHOOK_JSON",
        message: "The verified webhook body is not valid JSON.",
      });
    }
    const payload = razorpayWebhookPayloadSchema.parse(unknownPayload);
    try {
      await this.database.webhookEvent.create({
        data: {
          provider: "RAZORPAY",
          externalEventId: input.externalEventId,
          eventType: payload.event,
          signature: input.signature,
          payload: payload as unknown as Prisma.InputJsonValue,
          status: "RECEIVED",
        },
      });
      return { accepted: true, duplicate: false };
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { accepted: true, duplicate: true };
      }
      throw error;
    }
  }
}
