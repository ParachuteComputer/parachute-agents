import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { experimental_createMCPClient, type Tool } from "ai";
import type { McpBearerAuth, McpOauthAuth, McpServerConfig } from "../agents.js";

/**
 * A connected MCP client ready for `generateText`. Same shape the AI SDK returns
 * from `experimental_createMCPClient`, narrowed to the methods the runner calls.
 */
export interface McpClient {
  tools(): Promise<Record<string, Tool>>;
  close(): Promise<void>;
}

/**
 * Fetch implementation override — injectable for tests. Defaults to global fetch.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Module-level OAuth token cache. Keyed by `<name>:<client_id>`. Kept simple —
 * shared across runs in one process, refreshed automatically when expired.
 * For CF Workers with many isolates this is a non-issue (each isolate has its
 * own cache); in long-lived Bun servers this avoids re-auth on every run.
 */
interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const oauthCache = new Map<string, CachedToken>();

/**
 * Clear the OAuth token cache. Used by tests to avoid cross-test bleed.
 */
export function _resetOauthCacheForTests(): void {
  oauthCache.clear();
}

async function resolveBearerToken(auth: McpBearerAuth, env: NodeJS.ProcessEnv): Promise<string> {
  if (auth.token) return auth.token;
  if (auth.token_env) {
    const v = env[auth.token_env];
    if (!v) throw new Error(`bearer auth: env var \`${auth.token_env}\` is unset`);
    return v;
  }
  throw new Error("bearer auth: neither `token` nor `token_env` provided");
}

async function resolveOauthToken(
  serverName: string,
  auth: McpOauthAuth,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): Promise<string> {
  const clientId = env[auth.client_id_env];
  const clientSecret = env[auth.client_secret_env];
  if (!clientId) throw new Error(`oauth: env var \`${auth.client_id_env}\` is unset`);
  if (!clientSecret) throw new Error(`oauth: env var \`${auth.client_secret_env}\` is unset`);

  const cacheKey = `${serverName}:${clientId}`;
  const cached = oauthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.accessToken;
  }

  // RFC 6749 client_credentials grant. Intentionally minimal — if we need
  // authorization_code/PKCE, that's a follow-up.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (auth.scope) body.set("scope", auth.scope);

  const res = await fetchImpl(auth.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`oauth token exchange failed: ${res.status} ${text}`.trim());
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("oauth token exchange returned no access_token");
  }
  const ttlMs = (data.expires_in ?? 3600) * 1000;
  oauthCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + ttlMs,
  });
  return data.access_token;
}

/**
 * Resolve a bearer token string for the given MCP config. Exported for tests.
 */
export async function resolveAuthHeader(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const auth = config.auth;
  if (auth.type === "bearer") {
    return `Bearer ${await resolveBearerToken(auth, env)}`;
  }
  return `Bearer ${await resolveOauthToken(config.name, auth, env, fetchImpl)}`;
}

/**
 * Build a connected MCP client for `config`. Uses StreamableHTTP transport
 * (same as vault). Caller owns the lifecycle — call `close()` when done.
 *
 * Overridable transport factory keeps tests from touching real sockets.
 */
export async function createMcpClient(
  config: McpServerConfig,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetch?: FetchLike;
    /** Test hook: return a pre-connected client in place of the real SDK wiring. */
    createClient?: (authHeader: string) => Promise<McpClient>;
  } = {},
): Promise<McpClient> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? fetch;
  const authHeader = await resolveAuthHeader(config, env, fetchImpl);

  if (opts.createClient) return opts.createClient(authHeader);

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: { Authorization: authHeader },
    },
  });
  const client = await experimental_createMCPClient({ transport });
  return {
    tools: async () => (await client.tools()) as Record<string, Tool>,
    close: () => client.close(),
  };
}
