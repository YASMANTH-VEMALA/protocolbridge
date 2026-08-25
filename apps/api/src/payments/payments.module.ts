import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { IntentsModule } from "../intents/intents.module";
import { InventoryModule } from "../inventory/inventory.module";
import { PolicyModule } from "../policy/policy.module";
import { QuoteModule } from "../quote/quote.module";
import { CheckoutVerificationService } from "./checkout-verification.service";
import { AgentPaymentsController } from "./agent-payments.controller";
import { PaymentExecutionService } from "./payment-execution.service";
import { PaymentsController } from "./payments.controller";
import { RAZORPAY_GATEWAY, razorpayGatewayProvider } from "./razorpay-gateway.provider";

@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    IdempotencyModule,
    IntentsModule,
    InventoryModule,
    PolicyModule,
    QuoteModule,
  ],
  controllers: [AgentPaymentsController, PaymentsController],
  providers: [razorpayGatewayProvider, PaymentExecutionService, CheckoutVerificationService],
  exports: [PaymentExecutionService, CheckoutVerificationService, RAZORPAY_GATEWAY],
})
export class PaymentsModule {}
