import { describe, expect, it } from "vitest";

import {
  createIntentRequestSchema,
  minorToWire,
  universalCommerceIntentSchema,
  wireToMinor,
} from "./index";

describe("shared commerce contracts", () => {
  it("keeps money as integer minor units", () => {
    expect(wireToMinor(189_900)).toBe(189_900n);
    expect(minorToWire(229_900n)).toBe(229_900);
    expect(() => wireToMinor(18.99)).toThrow();
  });

  it("defaults only the internal P0 source protocol", () => {
    const request = createIntentRequestSchema.parse({
      requestId: "request-0001",
      buyerId: "buyer-1",
      prompt: "Buy black running shoes, size 9, under ₹2,000.",
    });
    expect(request.protocol).toBe("INTERNAL");
  });

  it("validates a UniversalCommerceIntent independently of the LLM", () => {
    const parsed = universalCommerceIntentSchema.parse({
      version: "1.0",
      intentId: "intent-1",
      requestId: "request-0001",
      protocol: "INTERNAL",
      merchantId: "merchant-1",
      buyerId: "buyer-1",
      agentId: "agent-1",
      constraints: {
        query: "black running shoes",
        color: "Black",
        size: "9",
        maxAmountMinor: 200_000,
      },
      requestedAt: "2026-08-25T00:00:00.000Z",
    });
    expect(parsed.constraints.currency).toBe("INR");
  });
});
