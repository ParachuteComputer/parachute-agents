import { join } from "node:path";
import { startSelfHosted } from "@openparachute/agents/adapters/node";
import { telegram, discord } from "@openparachute/agents/connectors";

const env = process.env;
function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing env var: ${name}`);
  return value;
}

const { server } = await startSelfHosted({
  agentsDir: join(import.meta.dir, "..", "agents"),
  config: {
    vault: {
      url: required("VAULT_URL"),
      token: required("VAULT_TOKEN"),
    },
    provider: {
      name: env.PROVIDER_NAME ?? "openrouter",
      baseURL: env.PROVIDER_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKey: required("PROVIDER_API_KEY"),
    },
  },
  serve: {
    port: Number(env.PORT ?? 3000),
    webhookPath: "/webhook",
    // Register only the connectors whose bot tokens are set.
    // Matches the README: "optional; endpoint is off if unset".
    connectors: [
      ...(env.TELEGRAM_BOT_TOKEN
        ? [{
            path: "/webhook/telegram",
            connector: telegram,
            config: { botToken: env.TELEGRAM_BOT_TOKEN },
            autoReply: true,
          }]
        : []),
      ...(env.DISCORD_BOT_TOKEN
        ? [{
            path: "/webhook/discord",
            connector: discord,
            config: { botToken: env.DISCORD_BOT_TOKEN },
            autoReply: true,
          }]
        : []),
    ],
  },
});

console.log(`weave-bot-selfhosted listening on :${server.port}`);
