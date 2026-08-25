import type { AuthorizationSnapshot, DecisionReason } from "@protocolbridge/types";

export interface AuthorizationCheckInput {
  authorization: AuthorizationSnapshot | null;
  merchantId: string;
  userId: string;
  agentId: string;
  purchaseIntentId: string;
  productVariantId: string;
  totalMinor: number;
  currency: string;
  quantity: number;
  subscription: boolean;
  now: Date;
}

export interface AuthorizationCheckResult {
  valid: boolean;
  authorization: AuthorizationSnapshot | null;
  reasons: DecisionReason[];
}

export class DeterministicAuthorizationEngine {
  evaluate(input: AuthorizationCheckInput): AuthorizationCheckResult {
    const authorization = input.authorization;
    if (!authorization) {
      return { valid: false, authorization: null, reasons: ["AUTHORIZATION_NOT_FOUND"] };
    }

    const reasons: DecisionReason[] = [];
    if (
      authorization.merchantId !== input.merchantId ||
      authorization.userId !== input.userId ||
      (authorization.agentId !== null && authorization.agentId !== input.agentId)
    ) {
      reasons.push("AUTHORIZATION_NOT_FOUND");
    }
    if (authorization.status === "REVOKED") reasons.push("AUTHORIZATION_REVOKED");
    if (authorization.status === "CONSUMED") reasons.push("AUTHORIZATION_CONSUMED");
    if (authorization.status === "EXPIRED" || new Date(authorization.expiresAt) <= input.now) {
      reasons.push("AUTHORIZATION_EXPIRED");
    }
    if (authorization.currency !== input.currency) reasons.push("CURRENCY_MISMATCH");
    if (authorization.maxAmountMinor < input.totalMinor) reasons.push("MAX_AMOUNT_EXCEEDED");
    if (authorization.maxQuantity < input.quantity) reasons.push("MAX_QUANTITY_EXCEEDED");
    if (input.subscription && !authorization.subscriptionsAllowed) {
      reasons.push("SUBSCRIPTION_NOT_ALLOWED");
    }
    if (
      authorization.productVariantId !== null &&
      authorization.productVariantId !== input.productVariantId
    ) {
      reasons.push("PRODUCT_BOUNDARY_MISMATCH");
    }
    if (
      authorization.boundIntentId !== null &&
      authorization.boundIntentId !== input.purchaseIntentId
    ) {
      reasons.push("INTENT_BOUNDARY_MISMATCH");
    }
    if (
      authorization.type === "ONE_TIME" &&
      (authorization.usesRemaining === null || authorization.usesRemaining < 1)
    ) {
      reasons.push("AUTHORIZATION_CONSUMED");
    }
    if (authorization.type === "ONE_TIME") {
      if (authorization.productVariantId === null) reasons.push("PRODUCT_BOUNDARY_MISMATCH");
      if (authorization.boundIntentId === null) reasons.push("INTENT_BOUNDARY_MISMATCH");
      if (authorization.maxAmountMinor !== input.totalMinor) reasons.push("AMOUNT_BOUNDARY_MISMATCH");
    }

    return {
      valid: reasons.length === 0,
      authorization,
      reasons: [...new Set(reasons)],
    };
  }
}
