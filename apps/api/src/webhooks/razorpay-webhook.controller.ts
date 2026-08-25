import type {
  RawBodyRequest} from "@nestjs/common";
import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { RazorpayWebhookIngestionService } from "./razorpay-webhook-ingestion.service";

@ApiTags("webhooks")
@Controller("webhooks/razorpay")
export class RazorpayWebhookController {
  constructor(private readonly ingestion: RazorpayWebhookIngestionService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: "Verify exact webhook bytes and durably enqueue a unique Razorpay event" })
  ingest(
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Headers("x-razorpay-event-id") eventId: string | undefined,
  ): Promise<{ accepted: true; duplicate: boolean }> {
    return this.ingestion.ingest({
      externalEventId: eventId ?? "",
      signature: signature ?? "",
      rawBody: request.rawBody ?? Buffer.alloc(0),
    });
  }
}
