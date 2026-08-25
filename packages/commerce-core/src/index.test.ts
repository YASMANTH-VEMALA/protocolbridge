import { describe, expect, it } from "vitest";

import { InvalidIntentTransitionError, PurchaseStateMachine } from "./index";

describe("PurchaseStateMachine", () => {
  const machine = new PurchaseStateMachine();

  it("supports the verified preparation path", () => {
    expect(machine.canTransition("RECEIVED", "RESOLVING")).toBe(true);
    expect(machine.canTransition("RESOLVING", "QUOTED")).toBe(true);
    expect(machine.canTransition("QUOTED", "POLICY_CHECK")).toBe(true);
    expect(machine.canTransition("POLICY_CHECK", "APPROVED")).toBe(true);
  });

  it("cannot skip directly from an unverified request to payment", () => {
    expect(() => machine.assertTransition("RECEIVED", "PAYMENT_PROCESSING")).toThrow(
      InvalidIntentTransitionError,
    );
  });

  it("makes completed and blocked intents terminal", () => {
    expect(machine.canTransition("COMPLETED", "APPROVED")).toBe(false);
    expect(machine.canTransition("BLOCKED", "PAYMENT_PROCESSING")).toBe(false);
  });
});
