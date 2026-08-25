import { demoApi } from "../../../../../../lib/demo-api";

export async function POST(
  _request: Request,
  context: { params: Promise<{ intentId: string }> },
): Promise<Response> {
  const { intentId } = await context.params;
  return demoApi(`/v1/agent/intents/${encodeURIComponent(intentId)}/execute`, {
    method: "POST",
    agent: true,
  });
}
