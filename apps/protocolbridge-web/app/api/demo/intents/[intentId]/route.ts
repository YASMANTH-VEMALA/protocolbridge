import { demoApi } from "../../../../../lib/demo-api";

export async function GET(
  _request: Request,
  context: { params: Promise<{ intentId: string }> },
): Promise<Response> {
  const { intentId } = await context.params;
  return demoApi(`/v1/agent/intents/${encodeURIComponent(intentId)}`, { agent: true });
}
