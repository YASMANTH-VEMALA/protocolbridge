import { demoApi, demoBuyerCredentials } from "../../../../lib/demo-api";

export async function POST(): Promise<Response> {
  const credentials = demoBuyerCredentials();
  if (!credentials) {
    return Response.json(
      { error: { code: "DEMO_BUYER_NOT_CONFIGURED", message: "Demo buyer credentials are required server-side." } },
      { status: 503 },
    );
  }
  return demoApi("/v1/auth/login", { method: "POST", body: credentials });
}
