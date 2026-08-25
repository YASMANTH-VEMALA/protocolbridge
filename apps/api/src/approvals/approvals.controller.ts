import { Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";

import { AgentAuthGuard } from "../auth/agent-auth.guard";
import type { AgentAuthenticatedRequest, UserAuthenticatedRequest } from "../auth/auth.types";
import { UserAuthGuard } from "../auth/user-auth.guard";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { ApprovalService } from "./approval.service";

@ApiTags("buyer approvals")
@Controller()
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post("agent/intents/:intentId/approval-link")
  @HttpCode(200)
  @UseGuards(AgentAuthGuard)
  @ApiSecurity("agent-api-key")
  @ApiOperation({ summary: "Create or replay an exact, signed, single-use buyer approval link" })
  createLink(
    @Req() request: AgentAuthenticatedRequest,
    @Param("intentId") intentId: string,
  ): Promise<Record<string, unknown>> {
    return this.approvals.createLink(request.authenticatedAgent, intentId);
  }

  @Get("approvals/:token")
  @ApiOperation({ summary: "Inspect the exact product and amount bound to an approval capability" })
  inspect(@Param("token") token: string): Promise<Record<string, unknown>> {
    return this.approvals.inspect(token);
  }

  @Post("approvals/:token/approve")
  @HttpCode(200)
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Exchange a single-use link for an exact intent-bound ONE_TIME authorization" })
  async approve(
    @Req() request: UserAuthenticatedRequest,
    @Param("token") token: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ): Promise<Record<string, unknown>> {
    const context = await this.approvals.context(token);
    const result = await this.idempotency.execute({
      merchantId: context.merchantId,
      actorId: request.authenticatedUser.id,
      key: idempotencyKey ?? "",
      method: "POST",
      path: `/v1/approvals/${context.approvalRequestId}/approve`,
      requestBody: { approvalRequestId: context.approvalRequestId },
      operation: async () => ({
        statusCode: 200,
        body: await this.approvals.approve(token, request.authenticatedUser.id),
      }),
    });
    return { ...result.body, idempotencyReplayed: result.replayed };
  }
}
