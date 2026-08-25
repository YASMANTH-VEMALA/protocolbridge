import { describe, expect, it } from "vitest";

import { parseConfig } from "./index";

const baseEnvironment = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgresql://user:pass@localhost:55432/protocolbridge",
  JWT_SECRET: "a".repeat(32),
  AGENT_CREDENTIAL_PEPPER: "b".repeat(32),
  APPROVAL_LINK_SECRET: "c".repeat(32),
};

describe("parseConfig", () => {
  it("starts in deterministic/degraded mode when optional providers are absent", () => {
    const result = parseConfig(baseEnvironment);
    expect(result.openAi).toBeNull();
    expect(result.razorpay).toBeNull();
  });

  it("rejects a model without an OpenAI API key", () => {
    expect(() => parseConfig({ ...baseEnvironment, OPENAI_MODEL: "configured-model" })).toThrow(
      "OPENAI_API_KEY and OPENAI_MODEL",
    );
  });

  it("rejects incomplete Razorpay configuration", () => {
    expect(() => parseConfig({ ...baseEnvironment, RAZORPAY_KEY_ID: "rzp_test_key" })).toThrow(
      "must be configured together",
    );
  });
});
