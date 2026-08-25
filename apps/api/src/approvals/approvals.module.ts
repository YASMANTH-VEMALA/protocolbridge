import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { PolicyModule } from "../policy/policy.module";
import { QuoteModule } from "../quote/quote.module";
import { ApprovalService } from "./approval.service";
import { ApprovalsController } from "./approvals.controller";

@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule, IdempotencyModule, PolicyModule, QuoteModule],
  controllers: [ApprovalsController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
