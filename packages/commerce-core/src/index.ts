export type PurchaseIntentState =
  | "RECEIVED"
  | "RESOLVING"
  | "QUOTED"
  | "POLICY_CHECK"
  | "APPROVED"
  | "AWAITING_APPROVAL"
  | "BLOCKED"
  | "PAYMENT_PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED";

const allowedTransitions: Readonly<Record<PurchaseIntentState, readonly PurchaseIntentState[]>> = {
  RECEIVED: ["RESOLVING", "CANCELED", "FAILED"],
  RESOLVING: ["QUOTED", "BLOCKED", "FAILED"],
  QUOTED: ["POLICY_CHECK", "FAILED"],
  POLICY_CHECK: ["APPROVED", "AWAITING_APPROVAL", "BLOCKED", "FAILED"],
  APPROVED: ["PAYMENT_PROCESSING", "AWAITING_APPROVAL", "BLOCKED", "FAILED", "CANCELED"],
  AWAITING_APPROVAL: ["APPROVED", "CANCELED", "EXPIRED"],
  BLOCKED: [],
  PAYMENT_PROCESSING: ["COMPLETED", "APPROVED", "FAILED", "CANCELED"],
  COMPLETED: [],
  FAILED: [],
  CANCELED: [],
  EXPIRED: [],
};

export class InvalidIntentTransitionError extends Error {
  constructor(from: PurchaseIntentState, to: PurchaseIntentState) {
    super(`Invalid purchase intent transition: ${from} -> ${to}`);
    this.name = "InvalidIntentTransitionError";
  }
}

export class PurchaseStateMachine {
  canTransition(from: PurchaseIntentState, to: PurchaseIntentState): boolean {
    return allowedTransitions[from].includes(to);
  }

  assertTransition(from: PurchaseIntentState, to: PurchaseIntentState): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidIntentTransitionError(from, to);
    }
  }
}
