import { AgentRunner, handleWebhook } from "@openparachute/agents";
import extractEvent from "../agents/extract-event.md";

interface Env {
  PROVIDER_NAME: string;
  PROVIDER_BASE_URL: string;
  PROVIDER_API_KEY: string;
  VAULT_URL: string;
  VAULT_TOKEN: string;
}

function buildRunner(env: Env) {
  return new AgentRunner({
    agents: { "extract-event.md": extractEvent },
    vault: { url: env.VAULT_URL, token: env.VAULT_TOKEN },
    provider: {
      name: env.PROVIDER_NAME,
      baseURL: env.PROVIDER_BASE_URL,
      apiKey: env.PROVIDER_API_KEY,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    return handleWebhook(buildRunner(env), request);
  },
} satisfies ExportedHandler<Env>;
