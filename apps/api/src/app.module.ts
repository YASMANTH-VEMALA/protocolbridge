import { Module } from "@nestjs/common";

import { AuthModule } from "./auth/auth.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AuditModule } from "./audit/audit.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { CatalogModule } from "./catalog/catalog.module";
import { CoreModule } from "./core.module";
import { DemoModule } from "./demo/demo.module";
import { HealthController } from "./health/health.controller";
import { IntentsModule } from "./intents/intents.module";
import { InventoryModule } from "./inventory/inventory.module";
import { IdempotencyModule } from "./idempotency/idempotency.module";
import { PolicyModule } from "./policy/policy.module";
import { PaymentsModule } from "./payments/payments.module";
import { QuoteModule } from "./quote/quote.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    CoreModule,
    DemoModule,
    AuthModule,
    ApprovalsModule,
    AuditModule,
    CatalogModule,
    AuthorizationModule,
    QuoteModule,
    PolicyModule,
    IntentsModule,
    InventoryModule,
    IdempotencyModule,
    PaymentsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
