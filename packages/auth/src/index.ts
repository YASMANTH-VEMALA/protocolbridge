import { Algorithm, hash, verify } from "@node-rs/argon2";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { z } from "zod";

export interface UserTokenClaims {
  userId: string;
  globalRole: "BUYER" | "SUPER_ADMIN";
}

export interface ApprovalTokenClaims {
  approvalRequestId: string;
  purchaseIntentId: string;
  merchantId: string;
  userId: string;
  productVariantId: string;
  amountMinor: number;
  currency: string;
  nonce: string;
  expiresAt: Date;
}

const tokenPayloadSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(["BUYER", "SUPER_ADMIN"]),
  iss: z.literal("protocolbridge"),
  aud: z.literal("protocolbridge-api"),
});

const approvalTokenPayloadSchema = z.object({
  v: z.literal(1),
  approvalRequestId: z.string().min(1),
  purchaseIntentId: z.string().min(1),
  merchantId: z.string().min(1),
  userId: z.string().min(1),
  productVariantId: z.string().min(1),
  amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  nonce: z.string().min(32),
  exp: z.number().int().positive(),
});

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, { algorithm: Algorithm.Argon2id });
  } catch {
    return false;
  }
}

export function hashAgentApiKey(apiKey: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${apiKey}`, "utf8").digest("hex");
}

export function issueUserToken(claims: UserTokenClaims, secret: string): string {
  return jwt.sign(
    { role: claims.globalRole },
    secret,
    {
      algorithm: "HS256",
      subject: claims.userId,
      issuer: "protocolbridge",
      audience: "protocolbridge-api",
      expiresIn: "30m",
    },
  );
}

export function verifyUserToken(token: string, secret: string): UserTokenClaims {
  const raw = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "protocolbridge",
    audience: "protocolbridge-api",
  }) as JwtPayload;
  const payload = tokenPayloadSchema.parse(raw);
  return { userId: payload.sub, globalRole: payload.role };
}

/**
 * Approval links are capability URLs, but they still require the matching buyer
 * login before an authorization is issued. The full token is hashed at rest.
 */
export function issueApprovalToken(
  claims: Omit<ApprovalTokenClaims, "nonce"> & { nonce?: string },
  secret: string,
): string {
  const payload = {
    v: 1 as const,
    approvalRequestId: claims.approvalRequestId,
    purchaseIntentId: claims.purchaseIntentId,
    merchantId: claims.merchantId,
    userId: claims.userId,
    productVariantId: claims.productVariantId,
    amountMinor: claims.amountMinor,
    currency: claims.currency,
    nonce: claims.nonce ?? randomBytes(24).toString("base64url"),
    exp: Math.floor(claims.expiresAt.getTime() / 1_000),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyApprovalToken(
  token: string,
  secret: string,
  now = new Date(),
): ApprovalTokenClaims {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) throw new Error("Invalid approval token format.");
  const expected = createHmac("sha256", secret).update(encodedPayload, "utf8").digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("Invalid approval token signature.");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid approval token signature.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid approval token payload.");
  }
  const payload = approvalTokenPayloadSchema.parse(raw);
  const expiresAt = new Date(payload.exp * 1_000);
  if (expiresAt.getTime() <= now.getTime()) throw new Error("Approval token has expired.");
  return {
    approvalRequestId: payload.approvalRequestId,
    purchaseIntentId: payload.purchaseIntentId,
    merchantId: payload.merchantId,
    userId: payload.userId,
    productVariantId: payload.productVariantId,
    amountMinor: payload.amountMinor,
    currency: payload.currency,
    nonce: payload.nonce,
    expiresAt,
  };
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
