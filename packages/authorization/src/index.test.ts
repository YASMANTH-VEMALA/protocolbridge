import { describe, expect, it } from "vitest";

import type { AuthorizationSnapshot } from "@protocolbridge/types";

import { DeterministicAuthorizationEngine } from "./index";

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

const engine = new DeterministicAuthorizationEngine();

describe("DeterministicAuthorizationEngine", () => {
  it("allows the seeded quote boundary", () => {
    expect(
      engine.evaluate({
        authorization,
        merchantId: "merchant-1",
        userId: "buyer-1",
        agentId: "agent-1",
        purchaseIntentId: "intent-1",
        productVariantId: "variant-1",
        totalMinor: 189_900,
        currency: "INR",
        quantity: 1,
        subscription: false,
        now: new Date("2026-08-25T00:00:00.000Z"),
      }).valid,
    ).toBe(true);
  });

  it("does not permit a price above the bounded amount", () => {
    const result = engine.evaluate({
      authorization,
      merchantId: "merchant-1",
      userId: "buyer-1",
      agentId: "agent-1",
      purchaseIntentId: "intent-1",
      productVariantId: "variant-1",
      totalMinor: 229_900,
      currency: "INR",
      quantity: 1,
      subscription: false,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ valid: false, reasons: ["MAX_AMOUNT_EXCEEDED"] });
  });

  it("binds one-time grants to exactly one intent and variant", () => {
    const oneTime: AuthorizationSnapshot = {
      ...authorization,
      type: "ONE_TIME",
      usesRemaining: 1,
      boundIntentId: "intent-1",
      productVariantId: "variant-1",
      maxAmountMinor: 229_900,
    };
    const result = engine.evaluate({
      authorization: oneTime,
      merchantId: "merchant-1",
      userId: "buyer-1",
      agentId: "agent-1",
      purchaseIntentId: "intent-2",
      productVariantId: "variant-2",
      totalMinor: 229_900,
      currency: "INR",
      quantity: 1,
      subscription: false,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining(["PRODUCT_BOUNDARY_MISMATCH", "INTENT_BOUNDARY_MISMATCH"]),
    );
  });

  it("requires an exact amount for a one-time authorization", () => {
    const result = engine.evaluate({
      authorization: {
        ...authorization,
        type: "ONE_TIME",
        usesRemaining: 1,
        boundIntentId: "intent-1",
        productVariantId: "variant-1",
        maxAmountMinor: 229_900,
      },
      merchantId: "merchant-1",
      userId: "buyer-1",
      agentId: "agent-1",
      purchaseIntentId: "intent-1",
      productVariantId: "variant-1",
      totalMinor: 189_900,
      currency: "INR",
      quantity: 1,
      subscription: false,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(result.reasons).toContain("AMOUNT_BOUNDARY_MISMATCH");
  });
});
