import { Module } from "@nestjs/common";

import { AuthorizationModule } from "../authorization/authorization.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { CatalogModule } from "../catalog/catalog.module";
import { PolicyModule } from "../policy/policy.module";
import { QuoteModule } from "../quote/quote.module";
import { IntentOrchestrationService } from "./intent-orchestration.service";
import { IntentStateService } from "./intent-state.service";
import { IntentsController } from "./intents.controller";

@Module({
  imports: [
    AuditModule,
    AuthModule,
    CatalogModule,
    IdempotencyModule,
    QuoteModule,
    AuthorizationModule,
    PolicyModule,
  ],
  controllers: [IntentsController],
  providers: [IntentOrchestrationService, IntentStateService],
  exports: [IntentOrchestrationService, IntentStateService],
})
export class IntentsModule {}
