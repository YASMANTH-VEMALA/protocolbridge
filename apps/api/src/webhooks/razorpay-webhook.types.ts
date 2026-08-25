import { z } from "zod";

const entitySchema = z
  .object({
    id: z.string().min(1),
    amount: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    status: z.string().optional(),
    order_id: z.string().nullable().optional(),
    notes: z.record(z.string(), z.unknown()).optional(),
    error_code: z.string().nullable().optional(),
    error_description: z.string().nullable().optional(),
  })
  .passthrough();

export const razorpayWebhookPayloadSchema = z
  .object({
    event: z.string().min(1),
    payload: z.record(
      z.string(),
      z.object({ entity: entitySchema }).passthrough(),
    ),
  })
  .passthrough();

export type RazorpayWebhookPayload = z.infer<typeof razorpayWebhookPayloadSchema>;
export type RazorpayWebhookEntity = z.infer<typeof entitySchema>;

export function paymentEntity(payload: RazorpayWebhookPayload): RazorpayWebhookEntity | null {
  return payload.payload["payment"]?.entity ?? null;
}

export function orderEntity(payload: RazorpayWebhookPayload): RazorpayWebhookEntity | null {
  return payload.payload["order"]?.entity ?? null;
}
