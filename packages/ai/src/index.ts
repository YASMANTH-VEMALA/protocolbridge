import type { SearchConstraints } from "@protocolbridge/types";
import { searchConstraintsSchema } from "@protocolbridge/types";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

export interface IntentResolver {
  readonly providerName: string;
  resolve(prompt: string): Promise<SearchConstraints>;
}

const extractedConstraintsSchema = z.object({
  query: z.string().min(1).max(500),
  category: z.string().min(1).max(100).nullable(),
  brand: z.string().min(1).max(100).nullable(),
  color: z.string().min(1).max(100).nullable(),
  size: z.string().min(1).max(50).nullable(),
  maxAmountMinor: z.number().int().nonnegative().safe().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  quantity: z.number().int().min(1).max(100),
  subscription: z.boolean(),
});

export class OpenAIIntentResolver implements IntentResolver {
  readonly providerName = "openai";
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    if (!apiKey.trim() || !model.trim()) {
      throw new Error("OpenAIIntentResolver requires configured OPENAI_API_KEY and OPENAI_MODEL values.");
    }
    this.client = new OpenAI({ apiKey });
  }

  async resolve(prompt: string): Promise<SearchConstraints> {
    const response = await this.client.responses.parse({
      model: this.model,
      input: [
        {
          role: "system",
          content:
            "Extract shopping search constraints only. Convert rupee amounts to integer paise. Do not select products, infer stock, approve policy, or decide payment outcomes.",
        },
        { role: "user", content: prompt },
      ],
      text: {
        format: zodTextFormat(extractedConstraintsSchema, "commerce_search_constraints"),
      },
    });

    if (!response.output_parsed) {
      throw new Error("OpenAI returned no parsed commerce constraints.");
    }
    const value = response.output_parsed;
    return searchConstraintsSchema.parse({
      query: value.query,
      ...(value.category === null ? {} : { category: value.category }),
      ...(value.brand === null ? {} : { brand: value.brand }),
      ...(value.color === null ? {} : { color: value.color }),
      ...(value.size === null ? {} : { size: value.size }),
      ...(value.maxAmountMinor === null ? {} : { maxAmountMinor: value.maxAmountMinor }),
      currency: value.currency,
      quantity: value.quantity,
      subscription: value.subscription,
    });
  }
}

const colors = ["black", "white", "blue", "red", "green", "grey", "gray", "brown"] as const;
const brands = ["adidas", "nike", "puma"] as const;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export class DeterministicIntentResolver implements IntentResolver {
  readonly providerName = "deterministic";

  async resolve(prompt: string): Promise<SearchConstraints> {
    const normalized = prompt.trim().toLowerCase();
    if (!normalized) {
      throw new Error("A non-empty shopping request is required.");
    }

    const color = colors.find((candidate) => normalized.includes(candidate));
    const brand = brands.find((candidate) => normalized.includes(candidate));
    const sizeMatch = /\bsize\s*(?:is\s*|[:=-]\s*)?([a-z0-9.]+)\b/i.exec(prompt);
    const amountMatch =
      /(?:under|below|less\s+than|up\s+to|maximum|max)\s*(?:of\s*)?(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(
        prompt,
      );
    const quantityMatch = /\b([1-9][0-9]?)\s*(?:pairs?|units?)\b/i.exec(prompt);
    const rupees = amountMatch?.[1] ? Number(amountMatch[1].replaceAll(",", "")) : undefined;
    const maxAmountMinor =
      rupees === undefined || !Number.isFinite(rupees) ? undefined : Math.round(rupees * 100);

    return searchConstraintsSchema.parse({
      query: normalized,
      ...(normalized.includes("running") ? { category: "running shoes" } : {}),
      ...(brand ? { brand: titleCase(brand) } : {}),
      ...(color ? { color: color === "gray" ? "Grey" : titleCase(color) } : {}),
      ...(sizeMatch?.[1] ? { size: sizeMatch[1] } : {}),
      ...(maxAmountMinor === undefined ? {} : { maxAmountMinor }),
      currency: "INR",
      quantity: quantityMatch?.[1] ? Number(quantityMatch[1]) : 1,
      subscription: /\b(subscription|recurring|every\s+(?:week|month|year))\b/i.test(prompt),
    });
  }
}

export class ResilientIntentResolver implements IntentResolver {
  readonly providerName: string;

  constructor(
    private readonly primary: IntentResolver | null,
    private readonly fallback: IntentResolver,
  ) {
    this.providerName = primary
      ? `${primary.providerName}_with_${fallback.providerName}_fallback`
      : fallback.providerName;
  }

  async resolve(prompt: string): Promise<SearchConstraints> {
    if (this.primary) {
      try {
        return await this.primary.resolve(prompt);
      } catch {
        // The LLM is intentionally non-authoritative; deterministic parsing preserves the golden path.
      }
    }
    return this.fallback.resolve(prompt);
  }
}

export function createIntentResolver(config: {
  openAi: { apiKey: string; model: string } | null;
}): IntentResolver {
  const fallback = new DeterministicIntentResolver();
  const primary = config.openAi
    ? new OpenAIIntentResolver(config.openAi.apiKey, config.openAi.model)
    : null;
  return new ResilientIntentResolver(primary, fallback);
}
