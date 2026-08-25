import { demoApi } from "../../../../lib/demo-api";

export async function POST(request: Request): Promise<Response> {
  return demoApi("/v1/agent/intents", { method: "POST", agent: true, body: await request.json() });
}
