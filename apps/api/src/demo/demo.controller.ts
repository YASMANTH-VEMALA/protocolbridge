import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { AgentAuthGuard } from "../auth/agent-auth.guard";
import type { AgentAuthenticatedRequest } from "../auth/auth.types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { DemoService, type GoldenPriceScenario } from "./demo.service";

const priceScenarioSchema = z.object({ scenario: z.enum(["BASELINE", "PRICE_INCREASED"]) });

@ApiTags("golden demo")
@ApiSecurity("agent-api-key")
@Controller("demo")
@UseGuards(AgentAuthGuard)
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post("price")
  @HttpCode(200)
  @ApiOperation({ summary: "Set the seeded golden variant to ₹1,899 or ₹2,299 (non-production only)" })
  async setPrice(
    @Req() request: AgentAuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(priceScenarioSchema)) input: { scenario: GoldenPriceScenario },
  ): Promise<Record<string, unknown>> {
    const agent = request.authenticatedAgent;
    const result = await this.idempotency.execute({
      merchantId: agent.merchantId,
      actorId: agent.id,
      key: idempotencyKey ?? "",
      method: "POST",
      path: "/v1/demo/price",
      requestBody: input,
      operation: async () => ({ statusCode: 200, body: await this.demo.setGoldenPrice(agent, input.scenario) }),
    });
    return { ...result.body, idempotencyReplayed: result.replayed };
  }

  @Post("reset")
  @HttpCode(200)
  @ApiOperation({ summary: "Reset only the seeded golden data while preserving append-only audit history" })
  async reset(
    @Req() request: AgentAuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ): Promise<Record<string, unknown>> {
    const agent = request.authenticatedAgent;
    const result = await this.idempotency.execute({
      merchantId: agent.merchantId,
      actorId: agent.id,
      key: idempotencyKey ?? "",
      method: "POST",
      path: "/v1/demo/reset",
      requestBody: { scope: "SOLEKART_GOLDEN_DATA" },
      operation: async () => ({ statusCode: 200, body: await this.demo.reset(agent) }),
    });
    return { ...result.body, idempotencyReplayed: result.replayed };
  }
}
