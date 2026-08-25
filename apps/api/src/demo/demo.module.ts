import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { DemoController } from "./demo.controller";
import { DemoService } from "./demo.service";

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
