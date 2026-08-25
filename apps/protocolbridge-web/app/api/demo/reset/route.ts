import { demoApi } from "../../../../lib/demo-api";

export function POST(): Promise<Response> {
  return demoApi("/v1/demo/reset", { method: "POST", agent: true });
}
