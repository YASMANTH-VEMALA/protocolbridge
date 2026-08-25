import { createHmac, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashAgentApiKey } from "@protocolbridge/auth";
import { parseConfig } from "@protocolbridge/config";
import { AgentStatus, AuthorizationStatus, MerchantStatus, PaymentStatus } from "@protocolbridge/database";
import type { RazorpayOrderGateway } from "@protocolbridge/razorpay";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { AppConfigService } from "../src/config/app-config.service";
import { PrismaService } from "../src/database/prisma.service";
import { RAZORPAY_GATEWAY } from "../src/payments/razorpay-gateway.provider";
import { RazorpayWebhookProcessorService } from "../src/webhooks/razorpay-webhook-processor.service";

const agentApiKey = "pb_test_solekart_agent_2026";
const razorpayKeySecret = "integration-test-razorpay-secret";
const webhookSecret = "integration-test-webhook-secret";

const testConfig = parseConfig({
  ...process.env,
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_integration",
  RAZORPAY_KEY_SECRET: razorpayKeySecret,
  RAZORPAY_WEBHOOK_SECRET: webhookSecret,
});

let providerOrderCounter = 0;
const fakeGateway: RazorpayOrderGateway = {
  configured: true,
  keyId: testConfig.razorpay!.keyId,
  createOrder: async (input) => ({
    id: `order_test_${++providerOrderCounter}_${randomUUID().slice(0, 8)}`,
    amountMinor: input.amountMinor,
    currency: input.currency,
    status: "created",
  }),
};

async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for asynchronous webhook processing.");
}

describe("ProtocolBridge P0 + P1 golden financial-safety slice", () => {
  let app: INestApplication;
  let database: PrismaService;
  let processor: RazorpayWebhookProcessorService;
  let buyerToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue({ value: testConfig })
      .overrideProvider(RAZORPAY_GATEWAY)
      .useValue(fakeGateway)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix("v1");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    database = app.get(PrismaService);
    processor = app.get(RazorpayWebhookProcessorService);

    await database.productVariant.update({
      where: { id: "var_runfalcon_black_9" },
      data: { priceMinor: 189_900n, stock: 12, active: true },
    });
    await database.authorization.update({
      where: { id: "auth_demo_buyer_2000" },
      data: {
        status: AuthorizationStatus.ACTIVE,
        maxAmountMinor: 200_000n,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    await database.agent.update({
      where: { id: "agt_demo_shopper" },
      data: { status: AgentStatus.ACTIVE },
    });
    await database.merchant.update({
      where: { id: "mer_solekart" },
      data: { status: MerchantStatus.ACTIVE },
    });

    const login = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "buyer@protocolbridge.local", password: "DemoPass!2026" })
      .expect(201);
    buyerToken = login.body.accessToken as string;
  });

  afterAll(async () => {
    await database.productVariant.update({
      where: { id: "var_runfalcon_black_9" },
      data: { priceMinor: 189_900n, stock: 12, active: true },
    });
    await app.close();
  });

  it("completes the ₹1,899 flow, deduplicates events, and ignores an out-of-order failure", async () => {
    const requestId = `success-${randomUUID()}`;
    const idempotencyKey = `create-${randomUUID()}`;
    const body = {
      requestId,
      buyerId: "usr_demo_buyer",
      prompt: "Buy black running shoes, size 9, under ₹2,000.",
    };
    const created = await request(app.getHttpServer())
      .post("/v1/agent/intents")
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", idempotencyKey)
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({
      status: "APPROVED",
      amountChargedMinor: 0,
      quote: { totalMinor: 189_900, currency: "INR" },
      policyDecision: { outcome: "ALLOW", reasons: [] },
    });
    const intentId = created.body.universalIntent.intentId as string;

    const replay = await request(app.getHttpServer())
      .post("/v1/agent/intents")
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", idempotencyKey)
      .send(body)
      .expect(201);
    expect(replay.body.universalIntent.intentId).toBe(intentId);
    expect(replay.body.idempotencyReplayed).toBe(true);

    await request(app.getHttpServer())
      .post("/v1/agent/intents")
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", idempotencyKey)
      .send({ ...body, prompt: "tampered request" })
      .expect(409);

    const executed = await request(app.getHttpServer())
      .post(`/v1/agent/intents/${intentId}/execute`)
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", `execute-${randomUUID()}`)
      .expect(200);
    expect(executed.body).toMatchObject({
      status: "PAYMENT_PROCESSING",
      amountChargedMinor: 0,
      checkout: { provider: "RAZORPAY", amountMinor: 189_900, currency: "INR" },
    });
    const paymentId = executed.body.checkout.paymentId as string;
    const razorpayOrderId = executed.body.checkout.razorpayOrderId as string;
    const razorpayPaymentId = `pay_test_${randomUUID().slice(0, 12)}`;
    const checkoutSignature = createHmac("sha256", razorpayKeySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");
    const verified = await request(app.getHttpServer())
      .post("/v1/payments/razorpay/verify")
      .set("Authorization", `Bearer ${buyerToken}`)
      .set("Idempotency-Key", `verify-${randomUUID()}`)
      .send({
        paymentId,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature: checkoutSignature,
      })
      .expect(200);
    expect(verified.body).toMatchObject({
      paymentId,
      status: "AUTHORIZED",
      finalConfirmation: "PENDING_VERIFIED_WEBHOOK",
    });

    const capturedPayload = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: razorpayPaymentId,
            amount: 189_900,
            currency: "INR",
            status: "captured",
            order_id: razorpayOrderId,
            notes: { internalPaymentId: paymentId },
          },
        },
      },
    };
    const capturedRaw = JSON.stringify(capturedPayload);
    const capturedSignature = createHmac("sha256", webhookSecret).update(capturedRaw).digest("hex");
    const capturedEventId = `evt_${randomUUID()}`;
    await request(app.getHttpServer())
      .post("/v1/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Event-Id", capturedEventId)
      .set("X-Razorpay-Signature", capturedSignature)
      .send(capturedRaw)
      .expect(202);
    await processor.drainOnce();
    await eventually(async () => {
      const payment = await database.payment.findUnique({ where: { id: paymentId } });
      return payment?.status === PaymentStatus.CAPTURED;
    });

    const duplicate = await request(app.getHttpServer())
      .post("/v1/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Event-Id", capturedEventId)
      .set("X-Razorpay-Signature", capturedSignature)
      .send(capturedRaw)
      .expect(202);
    expect(duplicate.body).toEqual({ accepted: true, duplicate: true });

    const failedPayload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: razorpayPaymentId,
            amount: 189_900,
            currency: "INR",
            status: "failed",
            order_id: razorpayOrderId,
            error_code: "LATE_FAILURE",
            error_description: "Out-of-order test event",
          },
        },
      },
    };
    const failedRaw = JSON.stringify(failedPayload);
    await request(app.getHttpServer())
      .post("/v1/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Event-Id", `evt_${randomUUID()}`)
      .set("X-Razorpay-Signature", createHmac("sha256", webhookSecret).update(failedRaw).digest("hex"))
      .send(failedRaw)
      .expect(202);
    await processor.drainOnce();
    await eventually(async () => {
      const ignored = await database.auditEvent.findFirst({
        where: { purchaseIntentId: intentId, eventType: "OUT_OF_ORDER_PAYMENT_FAILURE_IGNORED" },
      });
      return Boolean(ignored);
    });

    const final = await database.purchaseIntent.findUnique({
      where: { id: intentId },
      include: { order: { include: { payments: true } } },
    });
    expect(final?.status).toBe("COMPLETED");
    expect(final?.order?.status).toBe("CONFIRMED");
    expect(final?.order?.payments[0]?.status).toBe("CAPTURED");
    expect((await database.productVariant.findUnique({ where: { id: "var_runfalcon_black_9" } }))?.stock).toBe(11);
  });

  it("changes to ₹2,299, awaits approval, and creates no payment artifacts", async () => {
    await database.productVariant.update({
      where: { id: "var_runfalcon_black_9" },
      data: { priceMinor: 229_900n },
    });
    try {
      const blocked = await request(app.getHttpServer())
        .post("/v1/agent/intents")
        .set("X-Agent-Api-Key", agentApiKey)
        .set("Idempotency-Key", `price-change-${randomUUID()}`)
        .send({
          requestId: `price-change-${randomUUID()}`,
          buyerId: "usr_demo_buyer",
          prompt: "Buy black running shoes, size 9, under ₹2,000.",
        })
        .expect(201);
      expect(blocked.body).toMatchObject({
        status: "AWAITING_APPROVAL",
        amountChargedMinor: 0,
        quote: { totalMinor: 229_900 },
        policyDecision: {
          outcome: "AWAITING_APPROVAL",
          reasons: ["MAX_AMOUNT_EXCEEDED"],
        },
      });
      const intentId = blocked.body.universalIntent.intentId as string;
      expect(await database.payment.count({ where: { purchaseIntentId: intentId } })).toBe(0);
      expect(await database.order.count({ where: { purchaseIntentId: intentId } })).toBe(0);
      const timeline = await database.auditEvent.findMany({
        where: { purchaseIntentId: intentId },
        orderBy: { createdAt: "asc" },
      });
      expect(timeline.some((event) => event.eventType === "POLICY_EVALUATED")).toBe(true);
      expect(timeline.some((event) => JSON.stringify(event.data).includes("MAX_AMOUNT_EXCEEDED"))).toBe(true);
    } finally {
      await database.productVariant.update({
        where: { id: "var_runfalcon_black_9" },
        data: { priceMinor: 189_900n },
      });
    }
  });

  it("runs the signed approval flow, resumes the original intent, and consumes ONE_TIME authority", async () => {
    const beforeAuditCount = await database.auditEvent.count({ where: { merchantId: "mer_solekart" } });
    await request(app.getHttpServer())
      .post("/v1/demo/reset")
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", `reset-${randomUUID()}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          ready: true,
          scenario: "BASELINE",
          priceMinor: 189_900,
          stock: 12,
          auditEventsDeleted: 0,
        });
      });
    expect(await database.auditEvent.count({ where: { merchantId: "mer_solekart" } })).toBeGreaterThan(
      beforeAuditCount,
    );

    await request(app.getHttpServer())
      .post("/v1/demo/price")
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", `price-${randomUUID()}`)
      .send({ scenario: "PRICE_INCREASED" })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ scenario: "PRICE_INCREASED", priceMinor: 229_900 });
      });

    const created = await request(app.getHttpServer())
      .post("/v1/agent/intents")
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", `approval-create-${randomUUID()}`)
      .send({
        requestId: `approval-${randomUUID()}`,
        buyerId: "usr_demo_buyer",
        prompt: "Buy black running shoes, size 9, under ₹2,000.",
      })
      .expect(201);
    expect(created.body).toMatchObject({
      status: "AWAITING_APPROVAL",
      amountChargedMinor: 0,
      quote: { totalMinor: 229_900 },
      policyDecision: { outcome: "AWAITING_APPROVAL", reasons: ["MAX_AMOUNT_EXCEEDED"] },
    });
    const intentId = created.body.universalIntent.intentId as string;
    expect(await database.order.count({ where: { purchaseIntentId: intentId } })).toBe(0);
    expect(await database.payment.count({ where: { purchaseIntentId: intentId } })).toBe(0);

    const link = await request(app.getHttpServer())
      .post(`/v1/agent/intents/${intentId}/approval-link`)
      .set("X-Agent-Api-Key", agentApiKey)
      .expect(200);
    expect(link.body).toMatchObject({
      purchaseIntentId: intentId,
      productVariantId: "var_runfalcon_black_9",
      exactAmountMinor: 229_900,
      currency: "INR",
      singleUse: true,
    });
    const approvalUrl = new URL(link.body.approvalUrl as string);
    const token = decodeURIComponent(approvalUrl.pathname.split("/").at(-1)!);
    const storedApproval = await database.approvalRequest.findUniqueOrThrow({
      where: { purchaseIntentId: intentId },
    });
    expect(storedApproval.tokenHash).not.toContain(token);
    expect(storedApproval.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    await request(app.getHttpServer())
      .get(`/v1/approvals/${encodeURIComponent(`${token.slice(0, -1)}x`)}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/v1/approvals/${encodeURIComponent(token)}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.approval).toMatchObject({
          status: "PENDING",
          merchantName: "SoleKart",
          productName: "Adidas Runfalcon",
          color: "Black",
          size: "9",
          approvedAmountMinor: 229_900,
        });
      });

    const approvalIdempotencyKey = `approve-${randomUUID()}`;
    const approved = await request(app.getHttpServer())
      .post(`/v1/approvals/${encodeURIComponent(token)}/approve`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .set("Idempotency-Key", approvalIdempotencyKey)
      .expect(200);
    expect(approved.body).toMatchObject({
      status: "APPROVED",
      purchaseIntentId: intentId,
      amountChargedMinor: 0,
      authorization: {
        type: "ONE_TIME",
        status: "ACTIVE",
        productVariantId: "var_runfalcon_black_9",
        boundIntentId: intentId,
        exactAmountMinor: 229_900,
        usesRemaining: 1,
      },
      policyDecision: { outcome: "ALLOW", reasons: [] },
    });
    const authorizationId = approved.body.authorization.id as string;
    const approvalReplay = await request(app.getHttpServer())
      .post(`/v1/approvals/${encodeURIComponent(token)}/approve`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .set("Idempotency-Key", approvalIdempotencyKey)
      .expect(200);
    expect(approvalReplay.body.idempotencyReplayed).toBe(true);
    await request(app.getHttpServer())
      .post(`/v1/approvals/${encodeURIComponent(token)}/approve`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .set("Idempotency-Key", `approve-again-${randomUUID()}`)
      .expect(409);

    const executed = await request(app.getHttpServer())
      .post(`/v1/agent/intents/${intentId}/execute`)
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", `approval-execute-${randomUUID()}`)
      .expect(200);
    expect(executed.body).toMatchObject({
      status: "PAYMENT_PROCESSING",
      amountChargedMinor: 0,
      checkout: { amountMinor: 229_900, currency: "INR" },
      policyDecision: { outcome: "ALLOW", reasons: [] },
    });
    const paymentId = executed.body.checkout.paymentId as string;
    const razorpayOrderId = executed.body.checkout.razorpayOrderId as string;
    const razorpayPaymentId = `pay_approval_${randomUUID().slice(0, 12)}`;
    const checkoutSignature = createHmac("sha256", razorpayKeySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");
    await request(app.getHttpServer())
      .post("/v1/payments/razorpay/verify")
      .set("Authorization", `Bearer ${buyerToken}`)
      .set("Idempotency-Key", `approval-verify-${randomUUID()}`)
      .send({ paymentId, razorpayOrderId, razorpayPaymentId, razorpaySignature: checkoutSignature })
      .expect(200);

    const capturedPayload = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: razorpayPaymentId,
            amount: 229_900,
            currency: "INR",
            status: "captured",
            order_id: razorpayOrderId,
            notes: { internalPaymentId: paymentId },
          },
        },
      },
    };
    const capturedRaw = JSON.stringify(capturedPayload);
    await request(app.getHttpServer())
      .post("/v1/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Event-Id", `evt_${randomUUID()}`)
      .set("X-Razorpay-Signature", createHmac("sha256", webhookSecret).update(capturedRaw).digest("hex"))
      .send(capturedRaw)
      .expect(202);
    await processor.drainOnce();
    await eventually(async () => {
      const authorization = await database.authorization.findUnique({ where: { id: authorizationId } });
      return authorization?.status === "CONSUMED";
    });

    const oneTimeAuthorization = await database.authorization.findUniqueOrThrow({
      where: { id: authorizationId },
    });
    expect(oneTimeAuthorization).toMatchObject({
      status: "CONSUMED",
      usesRemaining: 0,
      boundIntentId: intentId,
      productVariantId: "var_runfalcon_black_9",
      maxAmountMinor: 229_900n,
    });
    expect(oneTimeAuthorization.consumedAt).not.toBeNull();
    expect((await database.approvalRequest.findUniqueOrThrow({ where: { purchaseIntentId: intentId } })).status).toBe(
      "USED",
    );
    const final = await request(app.getHttpServer())
      .get(`/v1/agent/intents/${intentId}`)
      .set("X-Agent-Api-Key", agentApiKey)
      .expect(200);
    expect(final.body).toMatchObject({
      amountChargedMinor: 229_900,
      intent: {
        status: "COMPLETED",
        order: { status: "CONFIRMED", payments: [{ status: "CAPTURED" }] },
        approvalRequest: { status: "USED", exactAmountMinor: 229_900 },
        authorization: { type: "ONE_TIME", status: "CONSUMED", usesRemaining: 0 },
      },
    });
    const eventTypes = (final.body.auditTimeline as { eventType: string }[]).map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "BUYER_APPROVAL_LINK_CREATED",
        "BUYER_APPROVAL_CLAIMED",
        "POST_APPROVAL_POLICY_EVALUATED",
        "BUYER_APPROVAL_CONSUMED",
        "QUOTE_REFRESHED_BEFORE_EXECUTION",
        "CHECKOUT_SIGNATURE_VERIFIED",
        "PAYMENT_CAPTURED_ORDER_CONFIRMED",
      ]),
    );

    await request(app.getHttpServer())
      .post("/v1/demo/reset")
      .set("X-Agent-Api-Key", agentApiKey)
      .set("Idempotency-Key", `final-reset-${randomUUID()}`)
      .expect(200);
    const restored = await database.productVariant.findUniqueOrThrow({ where: { id: "var_runfalcon_black_9" } });
    expect(restored).toMatchObject({ priceMinor: 189_900n, stock: 12, active: true });
  });

  it("prevents cross-tenant reads and database mutation of audit events", async () => {
    const otherMerchantId = "mer_integration_isolation";
    const otherAgentId = "agt_integration_isolation";
    const otherKey = "pb_test_other_tenant_agent_2026";
    await database.merchant.upsert({
      where: { id: otherMerchantId },
      create: { id: otherMerchantId, slug: "integration-isolation", name: "Isolation Merchant" },
      update: { status: MerchantStatus.ACTIVE },
    });
    await database.agent.upsert({
      where: { id: otherAgentId },
      create: { id: otherAgentId, merchantId: otherMerchantId, name: "Isolation Agent" },
      update: { status: AgentStatus.ACTIVE },
    });
    await database.agentCredential.upsert({
      where: { id: "agc_integration_isolation" },
      create: {
        id: "agc_integration_isolation",
        merchantId: otherMerchantId,
        agentId: otherAgentId,
        keyPrefix: otherKey.slice(0, 12),
        secretHash: hashAgentApiKey(otherKey, testConfig.agentCredentialPepper),
      },
      update: {
        secretHash: hashAgentApiKey(otherKey, testConfig.agentCredentialPepper),
        revokedAt: null,
      },
    });
    const soleKartIntent = await database.purchaseIntent.findFirst({
      where: { merchantId: "mer_solekart" },
      orderBy: { createdAt: "desc" },
    });
    expect(soleKartIntent).not.toBeNull();
    const crossTenant = await request(app.getHttpServer())
      .get(`/v1/agent/intents/${soleKartIntent!.id}`)
      .set("X-Agent-Api-Key", otherKey)
      .expect(200);
    expect(crossTenant.body).toEqual({ intent: null });

    const audit = await database.auditEvent.findFirst({
      where: { merchantId: "mer_solekart" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit).not.toBeNull();
    await expect(
      database.auditEvent.update({ where: { id: audit!.id }, data: { eventType: "TAMPERED" } }),
    ).rejects.toThrow();
  });
});
