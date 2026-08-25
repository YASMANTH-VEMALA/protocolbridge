import { describe, expect, it } from "vitest";

import { hashIdempotencyRequest } from "./idempotency.service";

describe("hashIdempotencyRequest", () => {
  it("canonicalizes object keys without changing array order", () => {
    expect(hashIdempotencyRequest({ b: 2, a: [1, 2] })).toBe(
      hashIdempotencyRequest({ a: [1, 2], b: 2 }),
    );
    expect(hashIdempotencyRequest({ a: [1, 2] })).not.toBe(hashIdempotencyRequest({ a: [2, 1] }));
  });
});
