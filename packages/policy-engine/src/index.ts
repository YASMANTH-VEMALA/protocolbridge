import type {
  AuthorizationSnapshot,
  DecisionReason,
  PolicyDecision,
  QuoteSnapshot,
  SearchConstraints,
} from "@protocolbridge/types";

export interface PolicyRuleInput {
  type: "MAX_AMOUNT_REVIEW" | "MAX_QUANTITY" | "BLOCK_SUBSCRIPTION" | "REQUIRE_ACTIVE_AGENT";
  enabled: boolean;
  config: unknown;
}

export interface PolicyEvaluationInput {
  quote: QuoteSnapshot;
  constraints: SearchConstraints;
  authorization: AuthorizationSnapshot | null;
  authorizationReasons: DecisionReason[];
  agentActive: boolean;
  rules: PolicyRuleInput[];
  now: Date;
}

function configuredInteger(config: unknown, property: string): number | null {
  if (typeof config !== "object" || config === null || !(property in config)) return null;
  const value = (config as Record<string, unknown>)[property];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export class DeterministicPolicyEngine {
  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const reasons: DecisionReason[] = [...input.authorizationReasons];
    const line = input.quote.lines.length === 1 ? input.quote.lines[0] : undefined;
    const exactOneTimeApproval = Boolean(
      line &&
        input.authorizationReasons.length === 0 &&
        input.authorization?.type === "ONE_TIME" &&
        input.authorization.status === "ACTIVE" &&
        input.authorization.boundIntentId === input.quote.purchaseIntentId &&
        input.authorization.productVariantId === line.productVariantId &&
        input.authorization.maxAmountMinor === input.quote.totalMinor &&
        input.authorization.currency === input.quote.currency &&
        input.authorization.maxQuantity >= line.quantity &&
        (input.authorization.usesRemaining ?? 0) > 0 &&
        new Date(input.authorization.expiresAt) > input.now,
    );

    if (new Date(input.quote.expiresAt) <= input.now) reasons.push("QUOTE_EXPIRED");
    for (const line of input.quote.lines) {
      if (line.availableStock < line.quantity) reasons.push("OUT_OF_STOCK");
    }
    if (
      input.constraints.maxAmountMinor !== undefined &&
      input.quote.totalMinor > input.constraints.maxAmountMinor &&
      !exactOneTimeApproval
    ) {
      reasons.push("MAX_AMOUNT_EXCEEDED");
    }
    if (input.constraints.currency !== input.quote.currency) reasons.push("CURRENCY_MISMATCH");
    if (!input.agentActive) reasons.push("AGENT_INACTIVE");

    for (const rule of input.rules) {
      if (!rule.enabled) continue;
      if (rule.type === "REQUIRE_ACTIVE_AGENT" && !input.agentActive) {
        reasons.push("AGENT_INACTIVE");
      }
      if (rule.type === "BLOCK_SUBSCRIPTION" && input.constraints.subscription) {
        reasons.push("SUBSCRIPTION_NOT_ALLOWED");
      }
      if (rule.type === "MAX_QUANTITY") {
        const maxQuantity = configuredInteger(rule.config, "maxQuantity");
        if (maxQuantity !== null && input.constraints.quantity > maxQuantity) {
          reasons.push("MAX_QUANTITY_EXCEEDED");
        }
      }
      if (rule.type === "MAX_AMOUNT_REVIEW") {
        const reviewAboveMinor = configuredInteger(rule.config, "reviewAboveMinor");
        if (
          reviewAboveMinor !== null &&
          input.quote.totalMinor > reviewAboveMinor &&
          !exactOneTimeApproval
        ) {
          reasons.push("MAX_AMOUNT_EXCEEDED");
        }
      }
    }

    const uniqueReasons = [...new Set(reasons)];
    const approvalOnly = uniqueReasons.length > 0 && uniqueReasons.every((reason) => reason === "MAX_AMOUNT_EXCEEDED");
    return {
      outcome: uniqueReasons.length === 0 ? "ALLOW" : approvalOnly ? "AWAITING_APPROVAL" : "BLOCK",
      reasons: uniqueReasons,
      evaluatedAt: input.now.toISOString(),
      authorizationId: input.authorization?.authorizationId ?? null,
      quoteId: input.quote.quoteId,
    };
  }
}
