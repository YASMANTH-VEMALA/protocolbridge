import "server-only";

const apiUrl = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export interface DemoApiOptions {
  method?: "GET" | "POST";
  body?: unknown;
  agent?: boolean;
  bearer?: string;
}

export async function demoApi(path: string, options: DemoApiOptions = {}): Promise<Response> {
  if (process.env.ENABLE_GOLDEN_DEMO !== "true") {
    return Response.json(
      { error: { code: "GOLDEN_DEMO_DISABLED", message: "Set ENABLE_GOLDEN_DEMO=true to use P1 demo controls." } },
      { status: 503 },
    );
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.agent) {
    const key = process.env.DEMO_AGENT_API_KEY;
    if (!key) {
      return Response.json(
        { error: { code: "DEMO_AGENT_NOT_CONFIGURED", message: "DEMO_AGENT_API_KEY is required server-side." } },
        { status: 503 },
      );
    }
    headers.set("X-Agent-Api-Key", key);
  }
  if (options.bearer) headers.set("Authorization", `Bearer ${options.bearer}`);
  if ((options.method ?? "GET") === "POST") {
    headers.set("Idempotency-Key", `web-${crypto.randomUUID()}`);
  }

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      cache: "no-store",
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
    });
  } catch {
    return Response.json(
      { error: { code: "API_UNREACHABLE", message: `ProtocolBridge API is unavailable at ${apiUrl}.` } },
      { status: 503 },
    );
  }
}

export function demoBuyerCredentials(): { email: string; password: string } | null {
  const email = process.env.DEMO_BUYER_EMAIL;
  const password = process.env.DEMO_BUYER_PASSWORD;
  return email && password ? { email, password } : null;
}
