import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { RazorpayWebhookIngestionService } from "./razorpay-webhook-ingestion.service";
import { RazorpayWebhookProcessorService } from "./razorpay-webhook-processor.service";

@Module({
  imports: [AuditModule],
  controllers: [RazorpayWebhookController],
  providers: [RazorpayWebhookIngestionService, RazorpayWebhookProcessorService],
  exports: [RazorpayWebhookIngestionService, RazorpayWebhookProcessorService],
})
export class WebhooksModule {}
