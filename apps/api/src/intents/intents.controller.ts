import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { createIntentRequestSchema, minorToWire, type CreateIntentRequest } from "@protocolbridge/types";

import type { AgentAuthenticatedRequest } from "../auth/auth.types";
import { AgentAuthGuard } from "../auth/agent-auth.guard";
import { AuditService } from "../audit/audit.service";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { IntentOrchestrationService } from "./intent-orchestration.service";

@ApiTags("agent commerce")
@ApiSecurity("agent-api-key")
@Controller("agent/intents")
export class IntentsController {
  constructor(
    private readonly orchestration: IntentOrchestrationService,
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: "Resolve, quote, authorize, and policy-check an internal P0 purchase intent" })
  async create(
    @Req() request: AgentAuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createIntentRequestSchema)) input: CreateIntentRequest,
  ): Promise<Record<string, unknown>> {
    const agent = request.authenticatedAgent;
    const result = await this.idempotency.execute({
      merchantId: agent.merchantId,
      actorId: agent.id,
      key: idempotencyKey ?? "",
      method: "POST",
      path: "/v1/agent/intents",
      requestBody: input,
      operation: async () => ({
        statusCode: 201,
        body: await this.orchestration.prepare(agent, input),
      }),
    });
    return { ...result.body, idempotencyReplayed: result.replayed };
  }

  @Get(":intentId")
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: "Read a tenant-scoped intent and its append-only audit timeline" })
  async get(
    @Req() request: AgentAuthenticatedRequest,
    @Param("intentId") intentId: string,
  ): Promise<Record<string, unknown>> {
    const merchantId = request.authenticatedAgent.merchantId;
    const intent = await this.database.purchaseIntent.findFirst({
      where: { id: intentId, merchantId, agentId: request.authenticatedAgent.id },
      include: {
        items: { include: { product: true, productVariant: true } },
        quotes: { orderBy: { version: "desc" } },
        approvalRequest: true,
        authorization: true,
        order: { include: { payments: { orderBy: { attempt: "asc" } } } },
      },
    });
    if (!intent) return { intent: null };
    return {
      intent: {
        id: intent.id,
        requestId: intent.requestId,
        protocol: intent.protocol,
        status: intent.status,
        reasonCode: intent.reasonCode,
        constraints: intent.constraints,
        items: intent.items.map((item) => ({
          productId: item.productId,
          productVariantId: item.productVariantId,
          productName: item.product.name,
          color: item.productVariant.color,
          size: item.productVariant.size,
          quantity: item.quantity,
          discoveredUnitAmountMinor: minorToWire(item.discoveredUnitAmountMinor),
        })),
        quotes: intent.quotes.map((quote) => ({
          id: quote.id,
          version: quote.version,
          status: quote.status,
          totalMinor: minorToWire(quote.totalMinor),
          currency: quote.currency,
          snapshot: quote.snapshot,
          expiresAt: quote.expiresAt.toISOString(),
        })),
        approvalRequest: intent.approvalRequest
          ? {
              id: intent.approvalRequest.id,
              status: intent.approvalRequest.status,
              exactAmountMinor: minorToWire(intent.approvalRequest.approvedAmountMinor),
              currency: intent.approvalRequest.currency,
              productVariantId: intent.approvalRequest.productVariantId,
              expiresAt: intent.approvalRequest.expiresAt.toISOString(),
              usedAt: intent.approvalRequest.usedAt?.toISOString() ?? null,
            }
          : null,
        authorization: intent.authorization
          ? {
              id: intent.authorization.id,
              type: intent.authorization.type,
              status: intent.authorization.status,
              maxAmountMinor: minorToWire(intent.authorization.maxAmountMinor),
              currency: intent.authorization.currency,
              productVariantId: intent.authorization.productVariantId,
              boundIntentId: intent.authorization.boundIntentId,
              usesRemaining: intent.authorization.usesRemaining,
              expiresAt: intent.authorization.expiresAt.toISOString(),
              consumedAt: intent.authorization.consumedAt?.toISOString() ?? null,
            }
          : null,
        order: intent.order
          ? {
              id: intent.order.id,
              status: intent.order.status,
              totalMinor: minorToWire(intent.order.totalMinor),
              currency: intent.order.currency,
              payments: intent.order.payments.map((payment) => ({
                id: payment.id,
                attempt: payment.attempt,
                status: payment.status,
                amountMinor: minorToWire(payment.amountMinor),
                razorpayOrderId: payment.razorpayOrderId,
                razorpayPaymentId: payment.razorpayPaymentId,
              })),
            }
          : null,
      },
      amountChargedMinor:
        intent.order?.payments.find((payment) => payment.status === "CAPTURED")
          ? minorToWire(intent.order.totalMinor)
          : 0,
      auditTimeline: await this.audit.getIntentTimeline(merchantId, intentId),
    };
  }
}
