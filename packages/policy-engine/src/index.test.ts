import { describe, expect, it } from "vitest";

import type { AuthorizationSnapshot, QuoteSnapshot, SearchConstraints } from "@protocolbridge/types";

import { DeterministicPolicyEngine } from "./index";

const quote: QuoteSnapshot = {
  quoteId: "quote-1",
  version: 1,
  merchantId: "merchant-1",
  purchaseIntentId: "intent-1",
  subtotalMinor: 189_900,
  totalMinor: 189_900,
  currency: "INR",
  lines: [
    {
      productId: "product-1",
      productVariantId: "variant-1",
      productName: "Adidas Runfalcon",
      variantLabel: "Black / Size 9",
      quantity: 1,
      unitAmountMinor: 189_900,
      lineTotalMinor: 189_900,
      availableStock: 12,
      variantVersion: 1,
    },
  ],
  expiresAt: "2026-08-25T00:02:00.000Z",
  createdAt: "2026-08-25T00:00:00.000Z",
};
const constraints: SearchConstraints = {
  query: "black running shoes",
  category: "running shoes",
  color: "Black",
  size: "9",
  maxAmountMinor: 200_000,
  currency: "INR",
  quantity: 1,
  subscription: false,
};
const authorization: AuthorizationSnapshot = {
  authorizationId: "auth-1",
  type: "MAX_AMOUNT",
  status: "ACTIVE",
  merchantId: "merchant-1",
  userId: "buyer-1",
  agentId: "agent-1",
  productVariantId: null,
  boundIntentId: null,
  maxAmountMinor: 200_000,
  currency: "INR",
  maxQuantity: 1,
  subscriptionsAllowed: false,
  usesRemaining: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const engine = new DeterministicPolicyEngine();

describe("DeterministicPolicyEngine", () => {
  it("allows the ₹1,899 golden quote", () => {
    expect(
      engine.evaluate({
        quote,
        constraints,
        authorization,
        authorizationReasons: [],
        agentActive: true,
        rules: [],
        now: new Date("2026-08-25T00:01:00.000Z"),
      }).outcome,
    ).toBe("ALLOW");
  });

  it("requires approval, rather than payment, for the ₹2,299 quote", () => {
    const result = engine.evaluate({
      quote: { ...quote, subtotalMinor: 229_900, totalMinor: 229_900 },
      constraints,
      authorization,
      authorizationReasons: ["MAX_AMOUNT_EXCEEDED"],
      agentActive: true,
      rules: [],
      now: new Date("2026-08-25T00:01:00.000Z"),
    });
    expect(result).toMatchObject({
      outcome: "AWAITING_APPROVAL",
      reasons: ["MAX_AMOUNT_EXCEEDED"],
    });
  });

  it("allows an exact active ONE_TIME buyer approval for its bound intent only", () => {
    const expensiveQuote = { ...quote, subtotalMinor: 229_900, totalMinor: 229_900 };
    const exactApproval: AuthorizationSnapshot = {
      ...authorization,
      authorizationId: "auth-one-time",
      type: "ONE_TIME",
      productVariantId: "variant-1",
      boundIntentId: "intent-1",
      maxAmountMinor: 229_900,
      usesRemaining: 1,
    };
    expect(
      engine.evaluate({
        quote: expensiveQuote,
        constraints,
        authorization: exactApproval,
        authorizationReasons: [],
        agentActive: true,
        rules: [{ type: "MAX_AMOUNT_REVIEW", enabled: true, config: { reviewAboveMinor: 200_000 } }],
        now: new Date("2026-08-25T00:01:00.000Z"),
      }),
    ).toMatchObject({ outcome: "ALLOW", reasons: [] });
  });

  it("blocks stock failures even if an amount approval could be requested", () => {
    const result = engine.evaluate({
      quote: {
        ...quote,
        lines: [{ ...quote.lines[0]!, availableStock: 0 }],
      },
      constraints,
      authorization,
      authorizationReasons: [],
      agentActive: true,
      rules: [],
      now: new Date("2026-08-25T00:01:00.000Z"),
    });
    expect(result).toMatchObject({ outcome: "BLOCK", reasons: ["OUT_OF_STOCK"] });
  });
});
