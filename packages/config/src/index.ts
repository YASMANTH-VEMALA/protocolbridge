import { config as loadDotEnv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    DATABASE_URL: z.string().url().startsWith("postgresql://"),
    JWT_SECRET: z.string().min(32),
    AGENT_CREDENTIAL_PEPPER: z.string().min(32),
    APPROVAL_LINK_SECRET: z.string().min(32),
    BUYER_APPROVAL_BASE_URL: z.string().url().default("http://localhost:3000/approve"),
    CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001,http://localhost:3002"),
    OPENAI_API_KEY: optionalTrimmedString,
    OPENAI_MODEL: optionalTrimmedString,
    RAZORPAY_KEY_ID: optionalTrimmedString,
    RAZORPAY_KEY_SECRET: optionalTrimmedString,
    RAZORPAY_WEBHOOK_SECRET: optionalTrimmedString,
  })
  .superRefine((value, context) => {
    const openAiCount = Number(Boolean(value.OPENAI_API_KEY)) + Number(Boolean(value.OPENAI_MODEL));
    if (openAiCount === 1) {
      context.addIssue({
        code: "custom",
        path: [value.OPENAI_API_KEY ? "OPENAI_MODEL" : "OPENAI_API_KEY"],
        message: "OPENAI_API_KEY and OPENAI_MODEL must be configured together.",
      });
    }

    const razorpayCount = [
      value.RAZORPAY_KEY_ID,
      value.RAZORPAY_KEY_SECRET,
      value.RAZORPAY_WEBHOOK_SECRET,
    ].filter(Boolean).length;
    if (razorpayCount !== 0 && razorpayCount !== 3) {
      context.addIssue({
        code: "custom",
        path: ["RAZORPAY_KEY_ID"],
        message:
          "RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET must be configured together.",
      });
    }
  });

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  agentCredentialPepper: string;
  approvalLinkSecret: string;
  buyerApprovalBaseUrl: string;
  corsOrigins: string[];
  openAi: { apiKey: string; model: string } | null;
  razorpay: { keyId: string; keySecret: string; webhookSecret: string } | null;
}

export function loadWorkspaceEnvironment(): void {
  loadDotEnv({
    path: resolve(__dirname, "../../../.env"),
    quiet: true,
  });
}

export function parseConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid ProtocolBridge configuration: ${z.prettifyError(parsed.error)}`);
  }

  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    jwtSecret: value.JWT_SECRET,
    agentCredentialPepper: value.AGENT_CREDENTIAL_PEPPER,
    approvalLinkSecret: value.APPROVAL_LINK_SECRET,
    buyerApprovalBaseUrl: value.BUYER_APPROVAL_BASE_URL.replace(/\/$/, ""),
    corsOrigins: value.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    openAi:
      value.OPENAI_API_KEY && value.OPENAI_MODEL
        ? { apiKey: value.OPENAI_API_KEY, model: value.OPENAI_MODEL }
        : null,
    razorpay:
      value.RAZORPAY_KEY_ID && value.RAZORPAY_KEY_SECRET && value.RAZORPAY_WEBHOOK_SECRET
        ? {
            keyId: value.RAZORPAY_KEY_ID,
            keySecret: value.RAZORPAY_KEY_SECRET,
            webhookSecret: value.RAZORPAY_WEBHOOK_SECRET,
          }
        : null,
  };
}
