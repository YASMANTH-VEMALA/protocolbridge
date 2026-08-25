import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";

export interface CreateRazorpayOrderInput {
  amountMinor: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}

export interface CreatedRazorpayOrder {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
}

export interface RazorpayOrderGateway {
  readonly configured: boolean;
  readonly keyId: string | null;
  createOrder(input: CreateRazorpayOrderInput): Promise<CreatedRazorpayOrder>;
}

export class PaymentProviderNotConfiguredError extends Error {
  constructor() {
    super("Razorpay Test Mode credentials are not configured.");
    this.name = "PaymentProviderNotConfiguredError";
  }
}

export class UnconfiguredRazorpayGateway implements RazorpayOrderGateway {
  readonly configured = false;
  readonly keyId = null;

  createOrder(_input: CreateRazorpayOrderInput): Promise<never> {
    void _input;
    return Promise.reject(new PaymentProviderNotConfiguredError());
  }
}

export class TestModeRazorpayGateway implements RazorpayOrderGateway {
  readonly configured = true;
  readonly keyId: string;
  private readonly client: Razorpay;

  constructor(config: { keyId: string; keySecret: string }) {
    if (!config.keyId.startsWith("rzp_test_")) {
      throw new Error("P0 permits Razorpay Test Mode keys only (expected rzp_test_ prefix).");
    }
    this.keyId = config.keyId;
    this.client = new Razorpay({ key_id: config.keyId, key_secret: config.keySecret });
  }

  async createOrder(input: CreateRazorpayOrderInput): Promise<CreatedRazorpayOrder> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
      throw new RangeError("Razorpay order amount must be a nonnegative integer in minor units.");
    }
    const order = await this.client.orders.create({
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    return {
      id: order.id,
      amountMinor: Number(order.amount),
      currency: order.currency,
      status: order.status,
    };
  }
}

export function createRazorpayGateway(config: {
  razorpay: { keyId: string; keySecret: string; webhookSecret: string } | null;
}): RazorpayOrderGateway {
  return config.razorpay
    ? new TestModeRazorpayGateway({
        keyId: config.razorpay.keyId,
        keySecret: config.razorpay.keySecret,
      })
    : new UnconfiguredRazorpayGateway();
}

function verifyHmac(message: Buffer | string, signature: string, secret: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(message).digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function verifyCheckoutSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  return verifyHmac(
    `${input.razorpayOrderId}|${input.razorpayPaymentId}`,
    input.signature,
    input.keySecret,
  );
}

export function verifyWebhookSignature(input: {
  rawBody: Buffer;
  signature: string;
  webhookSecret: string;
}): boolean {
  return verifyHmac(input.rawBody, input.signature, input.webhookSecret);
}
