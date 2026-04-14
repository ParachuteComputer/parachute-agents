import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { experimental_createMCPClient, type Tool } from "ai";

export interface VaultConfig {
  url: string;
  token: string;
}

/**
 * Thin wrapper around the Parachute Vault MCP. Exposes two shapes:
 * - `.tools()` — AI SDK tool map, ready to hand to `generateText`/`streamText`.
 * - `.raw()` — low-level MCP client for direct tool invocation.
 */
export class Vault {
  constructor(private config: VaultConfig) {}

  async tools(): Promise<Record<string, Tool>> {
    const client = await experimental_createMCPClient({
      transport: {
        type: "sse",
        url: `${this.config.url.replace(/\/$/, "")}`,
        headers: { Authorization: `Bearer ${this.config.token}` },
      },
    });
    return (await client.tools()) as Record<string, Tool>;
  }

  async raw(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.config.token}` },
      },
    });
    const client = new Client({ name: "parachute-agents", version: "0.0.1" });
    await client.connect(transport);
    return client;
  }
}
