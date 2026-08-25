import { Module } from "@nestjs/common";

import { AgentAuthGuard } from "./agent-auth.guard";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { RbacGuard } from "./rbac";
import { UserAuthGuard } from "./user-auth.guard";

@Module({
  controllers: [AuthController],
  providers: [AuthService, UserAuthGuard, AgentAuthGuard, RbacGuard],
  exports: [UserAuthGuard, AgentAuthGuard, RbacGuard, AuthService],
})
export class AuthModule {}
