import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TestModeRazorpayGateway,
  UnconfiguredRazorpayGateway,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "./index";

describe("Razorpay safety boundary", () => {
  it("refuses live-mode credentials", () => {
    expect(
      () => new TestModeRazorpayGateway({ keyId: "rzp_live_forbidden", keySecret: "secret" }),
    ).toThrow("Test Mode");
  });

  it("fails closed when credentials are absent", async () => {
    await expect(
      new UnconfiguredRazorpayGateway().createOrder({
        amountMinor: 189_900,
        currency: "INR",
        receipt: "receipt-1",
        notes: {},
      }),
    ).rejects.toThrow("not configured");
  });

  it("verifies checkout signatures using the stored order id", () => {
    const keySecret = "test-secret";
    const signature = createHmac("sha256", keySecret)
      .update("order_123|pay_456")
      .digest("hex");
    expect(
      verifyCheckoutSignature({
        razorpayOrderId: "order_123",
        razorpayPaymentId: "pay_456",
        signature,
        keySecret,
      }),
    ).toBe(true);
    expect(
      verifyCheckoutSignature({
        razorpayOrderId: "order_tampered",
        razorpayPaymentId: "pay_456",
        signature,
        keySecret,
      }),
    ).toBe(false);
  });

  it("verifies the exact webhook bytes", () => {
    const rawBody = Buffer.from('{"event":"payment.captured"}', "utf8");
    const webhookSecret = "webhook-secret";
    const signature = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    expect(verifyWebhookSignature({ rawBody, signature, webhookSecret })).toBe(true);
    expect(
      verifyWebhookSignature({
        rawBody: Buffer.from('{ "event":"payment.captured"}', "utf8"),
        signature,
        webhookSecret,
      }),
    ).toBe(false);
  });
});
