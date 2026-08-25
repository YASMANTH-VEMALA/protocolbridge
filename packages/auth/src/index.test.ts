import { describe, expect, it } from "vitest";

import {
  hashApprovalToken,
  hashAgentApiKey,
  hashPassword,
  issueApprovalToken,
  issueUserToken,
  verifyApprovalToken,
  verifyPassword,
  verifyUserToken,
} from "./index";

describe("authentication primitives", () => {
  it("hashes passwords with Argon2id", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    await expect(verifyPassword(encoded, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(encoded, "wrong password")).resolves.toBe(false);
  });

  it("binds agent hashes to the server-side pepper", () => {
    expect(hashAgentApiKey("key", "pepper-one")).not.toEqual(hashAgentApiKey("key", "pepper-two"));
  });

  it("issues constrained HS256 user tokens", () => {
    const secret = "s".repeat(32);
    const token = issueUserToken({ userId: "user-1", globalRole: "BUYER" }, secret);
    expect(verifyUserToken(token, secret)).toEqual({ userId: "user-1", globalRole: "BUYER" });
    expect(() => verifyUserToken(token, "x".repeat(32))).toThrow();
  });

  it("signs, validates, hashes, and expires approval capabilities", () => {
    const secret = "a".repeat(32);
    const expiresAt = new Date("2030-01-01T00:10:00.000Z");
    const token = issueApprovalToken(
      {
        approvalRequestId: "approval-1",
        purchaseIntentId: "intent-1",
        merchantId: "merchant-1",
        userId: "buyer-1",
        productVariantId: "variant-1",
        amountMinor: 229_900,
        currency: "INR",
        nonce: "n".repeat(32),
        expiresAt,
      },
      secret,
    );
    expect(verifyApprovalToken(token, secret, new Date("2030-01-01T00:00:00.000Z"))).toMatchObject({
      approvalRequestId: "approval-1",
      amountMinor: 229_900,
      expiresAt,
    });
    expect(hashApprovalToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyApprovalToken(`${token.slice(0, -1)}x`, secret)).toThrow();
    expect(() => verifyApprovalToken(token, secret, expiresAt)).toThrow("expired");
  });
});
