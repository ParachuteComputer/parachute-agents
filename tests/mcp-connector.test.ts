import { expect, test, beforeEach } from "bun:test";
import {
  _resetOauthCacheForTests,
  createMcpClient,
  resolveAuthHeader,
  type FetchLike,
  type McpClient,
} from "../src/mcp/connector.js";
import type { McpServerConfig } from "../src/agents.js";
import { parseAgent } from "../src/agents.js";

beforeEach(() => _resetOauthCacheForTests());

const bearerInline: McpServerConfig = {
  name: "gmail",
  url: "https://mcp.gmail.com/mcp",
  auth: { type: "bearer", token: "inline-abc" },
};

const bearerFromEnv: McpServerConfig = {
  name: "gmail",
  url: "https://mcp.gmail.com/mcp",
  auth: { type: "bearer", token_env: "GMAIL_TOKEN" },
};

const oauthConfig: McpServerConfig = {
  name: "gmail",
  url: "https://mcp.gmail.com/mcp",
  auth: {
    type: "oauth",
    client_id_env: "GMAIL_CLIENT_ID",
    client_secret_env: "GMAIL_CLIENT_SECRET",
    token_url: "https://oauth2.googleapis.com/token",
    scope: "mail.read",
  },
};

function fakeFetch(
  calls: Array<{ url: string; body: string }>,
  response: { status?: number; body: unknown } = { body: { access_token: "oauth-tok", expires_in: 3600 } },
): FetchLike {
  return async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const status = response.status ?? 200;
    return new Response(JSON.stringify(response.body), {
      status,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  };
}

test("bearer auth: inline token becomes Authorization header", async () => {
  const header = await resolveAuthHeader(bearerInline, {});
  expect(header).toBe("Bearer inline-abc");
});

test("bearer auth: env token is read from env", async () => {
  const header = await resolveAuthHeader(bearerFromEnv, { GMAIL_TOKEN: "env-xyz" });
  expect(header).toBe("Bearer env-xyz");
});

test("bearer auth: missing env var throws a legible error", async () => {
  await expect(resolveAuthHeader(bearerFromEnv, {})).rejects.toThrow(/GMAIL_TOKEN/);
});

test("bearer auth: neither token nor token_env throws", async () => {
  const bad: McpServerConfig = {
    name: "x",
    url: "https://x",
    auth: { type: "bearer" },
  };
  await expect(resolveAuthHeader(bad, {})).rejects.toThrow(/token/);
});

test("oauth: performs client_credentials grant and uses the returned token", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const header = await resolveAuthHeader(
    oauthConfig,
    { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "csec" },
    fakeFetch(calls),
  );
  expect(header).toBe("Bearer oauth-tok");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
  expect(calls[0]!.body).toContain("grant_type=client_credentials");
  expect(calls[0]!.body).toContain("client_id=cid");
  expect(calls[0]!.body).toContain("client_secret=csec");
  expect(calls[0]!.body).toContain("scope=mail.read");
});

test("oauth: cached token is reused across calls within ttl", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const env = { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "csec" };
  const f = fakeFetch(calls);
  await resolveAuthHeader(oauthConfig, env, f);
  await resolveAuthHeader(oauthConfig, env, f);
  await resolveAuthHeader(oauthConfig, env, f);
  expect(calls).toHaveLength(1);
});

test("oauth: missing client_id env var throws", async () => {
  await expect(
    resolveAuthHeader(oauthConfig, { GMAIL_CLIENT_SECRET: "csec" }, fakeFetch([])),
  ).rejects.toThrow(/GMAIL_CLIENT_ID/);
});

test("oauth: non-ok token response surfaces status + body", async () => {
  const f = fakeFetch([], { status: 401, body: { error: "invalid_client" } });
  await expect(
    resolveAuthHeader(
      oauthConfig,
      { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "csec" },
      f,
    ),
  ).rejects.toThrow(/401/);
});

test("oauth: token response without access_token throws", async () => {
  const f = fakeFetch([], { body: { expires_in: 3600 } });
  await expect(
    resolveAuthHeader(
      oauthConfig,
      { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "csec" },
      f,
    ),
  ).rejects.toThrow(/access_token/);
});

test("createMcpClient: test hook receives resolved Authorization header", async () => {
  let captured = "";
  const fakeClient: McpClient = {
    tools: async () => ({}),
    close: async () => {},
  };
  const c = await createMcpClient(bearerInline, {
    createClient: async (authHeader) => {
      captured = authHeader;
      return fakeClient;
    },
  });
  expect(captured).toBe("Bearer inline-abc");
  expect(c).toBe(fakeClient);
});

test("schema: agent frontmatter accepts mcp tool entries alongside short-form strings", () => {
  const md = `---
name: email-triage
trigger:
  type: manual
model: test-model
tools:
  - vault
  - mcp:
      name: gmail
      url: https://mcp.gmail.com/mcp
      auth:
        type: bearer
        token_env: GMAIL_TOKEN
---
system`;
  const def = parseAgent(md);
  expect(def.frontmatter.tools).toHaveLength(2);
  expect(def.frontmatter.tools[0]).toBe("vault");
  const mcp = def.frontmatter.tools[1];
  expect(typeof mcp === "object" && mcp !== null && "mcp" in mcp).toBe(true);
  if (typeof mcp === "object" && "mcp" in mcp) {
    expect(mcp.mcp.name).toBe("gmail");
    expect(mcp.mcp.auth.type).toBe("bearer");
  }
});

test("schema: file:// url is rejected at parse time", () => {
  const md = `---
name: exfil
trigger:
  type: manual
tools:
  - mcp:
      name: bad
      url: file:///etc/passwd
      auth:
        type: bearer
        token: x
---
body`;
  expect(() => parseAgent(md)).toThrow(/http\(s\)/i);
});

test("schema: oauth token_url must be http(s)", () => {
  const md = `---
name: bad-token-url
trigger:
  type: manual
tools:
  - mcp:
      name: bad
      url: https://mcp.example.com/mcp
      auth:
        type: oauth
        client_id_env: X
        client_secret_env: Y
        token_url: file:///tmp/token
---
body`;
  expect(() => parseAgent(md)).toThrow(/http\(s\)/i);
});

test("schema: bearer with neither token nor token_env fails at load time", () => {
  const md = `---
name: bad-bearer
trigger:
  type: manual
tools:
  - mcp:
      name: bad
      url: https://mcp.example.com/mcp
      auth:
        type: bearer
---
body`;
  expect(() => parseAgent(md)).toThrow(/token/);
});

test("schema: oauth mcp entry parses with client_id_env + token_url", () => {
  const md = `---
name: oauth-agent
trigger:
  type: manual
tools:
  - mcp:
      name: gcal
      url: https://mcp.gcal.com/mcp
      auth:
        type: oauth
        client_id_env: GCAL_CLIENT_ID
        client_secret_env: GCAL_CLIENT_SECRET
        token_url: https://oauth2.googleapis.com/token
---
body`;
  const def = parseAgent(md);
  const entry = def.frontmatter.tools[0];
  if (typeof entry === "object" && entry !== null && "mcp" in entry) {
    expect(entry.mcp.auth.type).toBe("oauth");
    if (entry.mcp.auth.type === "oauth") {
      expect(entry.mcp.auth.client_id_env).toBe("GCAL_CLIENT_ID");
      expect(entry.mcp.auth.token_url).toBe("https://oauth2.googleapis.com/token");
    }
  } else {
    throw new Error("expected mcp entry");
  }
});
