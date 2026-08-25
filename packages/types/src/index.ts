import { z } from "zod";

export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const minorAmountSchema = z.number().int().nonnegative().safe();

export const moneySchema = z.object({
  amountMinor: minorAmountSchema,
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;

export const protocolKindSchema = z.enum(["INTERNAL", "ACP", "AP2", "X402", "UAP"]);
export type ProtocolKindContract = z.infer<typeof protocolKindSchema>;

export const searchConstraintsSchema = z.object({
  query: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  color: z.string().trim().min(1).max(100).optional(),
  size: z.string().trim().min(1).max(50).optional(),
  maxAmountMinor: minorAmountSchema.optional(),
  currency: currencySchema.default("INR"),
  quantity: z.number().int().min(1).max(100).default(1),
  subscription: z.boolean().default(false),
});
export type SearchConstraints = z.infer<typeof searchConstraintsSchema>;

export const createIntentRequestSchema = z.object({
  requestId: z.string().trim().min(8).max(128),
  buyerId: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(2_000),
  protocol: protocolKindSchema.default("INTERNAL"),
});
export type CreateIntentRequest = z.infer<typeof createIntentRequestSchema>;

export const universalCommerceIntentSchema = z.object({
  version: z.literal("1.0"),
  intentId: z.string().min(1),
  requestId: z.string().min(1),
  protocol: protocolKindSchema,
  merchantId: z.string().min(1),
  buyerId: z.string().min(1),
  agentId: z.string().min(1),
  constraints: searchConstraintsSchema,
  requestedAt: z.string().datetime(),
});
export type UniversalCommerceIntent = z.infer<typeof universalCommerceIntentSchema>;

export const resolvedVariantSchema = z.object({
  merchantId: z.string().min(1),
  productId: z.string().min(1),
  productVariantId: z.string().min(1),
  productName: z.string().min(1),
  brand: z.string().min(1),
  category: z.string().min(1),
  sku: z.string().min(1),
  color: z.string().min(1),
  size: z.string().min(1),
  unitAmountMinor: minorAmountSchema,
  currency: currencySchema,
  availableStock: z.number().int().nonnegative(),
  variantVersion: z.number().int().positive(),
});
export type ResolvedVariant = z.infer<typeof resolvedVariantSchema>;

export const authorizationSnapshotSchema = z.object({
  authorizationId: z.string().min(1),
  type: z.enum(["MAX_AMOUNT", "ONE_TIME"]),
  status: z.enum(["ACTIVE", "CONSUMED", "EXPIRED", "REVOKED"]),
  merchantId: z.string().min(1),
  userId: z.string().min(1),
  agentId: z.string().nullable(),
  productVariantId: z.string().nullable(),
  boundIntentId: z.string().nullable(),
  maxAmountMinor: minorAmountSchema,
  currency: currencySchema,
  maxQuantity: z.number().int().positive(),
  subscriptionsAllowed: z.boolean(),
  usesRemaining: z.number().int().nonnegative().nullable(),
  expiresAt: z.string().datetime(),
});
export type AuthorizationSnapshot = z.infer<typeof authorizationSnapshotSchema>;

export const quoteLineSchema = z.object({
  productId: z.string().min(1),
  productVariantId: z.string().min(1),
  productName: z.string().min(1),
  variantLabel: z.string().min(1),
  quantity: z.number().int().positive(),
  unitAmountMinor: minorAmountSchema,
  lineTotalMinor: minorAmountSchema,
  availableStock: z.number().int().nonnegative(),
  variantVersion: z.number().int().positive(),
});
export type QuoteLine = z.infer<typeof quoteLineSchema>;

export const quoteSnapshotSchema = z.object({
  quoteId: z.string().min(1),
  version: z.number().int().positive(),
  merchantId: z.string().min(1),
  purchaseIntentId: z.string().min(1),
  subtotalMinor: minorAmountSchema,
  totalMinor: minorAmountSchema,
  currency: currencySchema,
  lines: z.array(quoteLineSchema).min(1),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;

export const decisionReasonSchema = z.enum([
  "AUTHORIZATION_NOT_FOUND",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_REVOKED",
  "AUTHORIZATION_CONSUMED",
  "MAX_AMOUNT_EXCEEDED",
  "AMOUNT_BOUNDARY_MISMATCH",
  "CURRENCY_MISMATCH",
  "MAX_QUANTITY_EXCEEDED",
  "PRODUCT_BOUNDARY_MISMATCH",
  "INTENT_BOUNDARY_MISMATCH",
  "SUBSCRIPTION_NOT_ALLOWED",
  "OUT_OF_STOCK",
  "PRODUCT_NOT_FOUND",
  "AGENT_INACTIVE",
  "QUOTE_EXPIRED",
  "QUOTE_CHANGED",
  "PAYMENT_NOT_CONFIGURED",
]);
export type DecisionReason = z.infer<typeof decisionReasonSchema>;

export const policyDecisionSchema = z.object({
  outcome: z.enum(["ALLOW", "AWAITING_APPROVAL", "BLOCK"]),
  reasons: z.array(decisionReasonSchema),
  evaluatedAt: z.string().datetime(),
  authorizationId: z.string().nullable(),
  quoteId: z.string().min(1),
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const checkoutActionSchema = z.object({
  provider: z.literal("RAZORPAY"),
  keyId: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  internalOrderId: z.string().min(1),
  paymentId: z.string().min(1),
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  name: z.literal("SoleKart via ProtocolBridge"),
  description: z.string().min(1),
});
export type CheckoutAction = z.infer<typeof checkoutActionSchema>;

export function minorToWire(value: bigint): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new RangeError("Minor-unit amount cannot be represented safely on the JSON wire.");
  }
  return numberValue;
}

export function wireToMinor(value: number): bigint {
  return BigInt(minorAmountSchema.parse(value));
}
