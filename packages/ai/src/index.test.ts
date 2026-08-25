import { describe, expect, it } from "vitest";

import {
  DeterministicIntentResolver,
  type IntentResolver,
  ResilientIntentResolver,
} from "./index";

describe("intent resolvers", () => {
  it("extracts the seeded judging scenario without an OpenAI key", async () => {
    const result = await new DeterministicIntentResolver().resolve(
      "Buy black running shoes, size 9, under ₹2,000.",
    );
    expect(result).toMatchObject({
      category: "running shoes",
      color: "Black",
      size: "9",
      maxAmountMinor: 200_000,
      currency: "INR",
      quantity: 1,
      subscription: false,
    });
  });

  it("falls back when the configured provider fails", async () => {
    const failing: IntentResolver = {
      providerName: "failing-provider",
      resolve: () => Promise.reject(new Error("provider unavailable")),
    };
    const resolver = new ResilientIntentResolver(failing, new DeterministicIntentResolver());
    const result = await resolver.resolve("black running shoes size 9 under INR 2000");
    expect(result.maxAmountMinor).toBe(200_000);
  });
});
