import { Controller, Headers, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";

import { AgentAuthGuard } from "../auth/agent-auth.guard";
import type { AgentAuthenticatedRequest } from "../auth/auth.types";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { PaymentExecutionService } from "./payment-execution.service";

@ApiTags("agent commerce")
@ApiSecurity("agent-api-key")
@Controller("agent/intents")
export class AgentPaymentsController {
  constructor(
    private readonly payments: PaymentExecutionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post(":intentId/execute")
  @HttpCode(200)
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: "Refresh quote/policy, reserve inventory, and create a Razorpay Test order" })
  async execute(
    @Req() request: AgentAuthenticatedRequest,
    @Param("intentId") intentId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ): Promise<Record<string, unknown>> {
    const agent = request.authenticatedAgent;
    const path = `/v1/agent/intents/${intentId}/execute`;
    const result = await this.idempotency.execute({
      merchantId: agent.merchantId,
      actorId: agent.id,
      key: idempotencyKey ?? "",
      method: "POST",
      path,
      requestBody: { intentId },
      operation: async () => ({
        statusCode: 200,
        body: await this.payments.execute(agent, intentId),
      }),
    });
    return { ...result.body, idempotencyReplayed: result.replayed };
  }
}
