import { expect, test } from "bun:test";
import { MockLanguageModelV1 } from "ai/test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentRunner } from "../src/runner.js";
import { runClaudeBackend, type ClaudeQueryFn } from "../src/backends/claude.js";

// Build a query() replacement that yields a canned stream of SDK messages,
// and captures the call args so we can assert on options/prompt.
function mockQuery(
  steps: SDKMessage[],
  seen: { calls: Array<{ prompt: unknown; options: unknown }> } = { calls: [] },
): { queryFn: ClaudeQueryFn; seen: typeof seen } {
  const queryFn: ClaudeQueryFn = (args) => {
    seen.calls.push({ prompt: args.prompt, options: args.options });
    return (async function* () {
      for (const m of steps) yield m;
    })();
  };
  return { queryFn, seen };
}

function asResult(text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: text,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "s",
  } as SDKMessage;
}

function asAssistantToolUse(): SDKMessage {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "foo", input: {} },
      ],
    } as never,
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000001",
    session_id: "s",
  } as SDKMessage;
}

const echoAgent = `---
name: echo-claude
trigger:
  type: manual
backend: claude
model: claude-sonnet-4-5
---
you are echo`;

test("runClaudeBackend: success result → text, tool_use blocks counted", async () => {
  const { queryFn, seen } = mockQuery([asAssistantToolUse(), asResult("hello world")]);
  const out = await runClaudeBackend({
    auth: { apiKey: "k" },
    agent: {
      frontmatter: {
        name: "x",
        description: "",
        trigger: { type: "manual" },
        model: "claude-sonnet-4-5",
        tools: [],
      },
      systemPrompt: "sys",
      source: "",
    },
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    maxSteps: 5,
    queryFn,
  });
  expect(out.text).toBe("hello world");
  expect(out.toolCalls).toBe(1);
  const opts = seen.calls[0]!.options as {
    systemPrompt: string;
    maxTurns: number;
    env: Record<string, string>;
    permissionMode: string;
    tools: unknown[];
  };
  expect(opts.systemPrompt).toBe("sys");
  expect(opts.maxTurns).toBe(5);
  expect(opts.env.ANTHROPIC_API_KEY).toBe("k");
  expect(opts.permissionMode).toBe("bypassPermissions");
  expect(opts.tools).toEqual([]);
});

test("runClaudeBackend: oauthToken routes to CLAUDE_CODE_OAUTH_TOKEN (apiKey not required)", async () => {
  const { queryFn, seen } = mockQuery([asResult("")]);
  await runClaudeBackend({
    auth: { oauthToken: "oauth-xyz" },
    agent: {
      frontmatter: {
        name: "x",
        description: "",
        trigger: { type: "manual" },
        model: "m",
        tools: [],
      },
      systemPrompt: "",
      source: "",
    },
    system: "",
    messages: [{ role: "user", content: "" }],
    maxSteps: 1,
    queryFn,
  });
  const env = (seen.calls[0]!.options as { env: Record<string, string> }).env;
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-xyz");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("runClaudeBackend: throws when neither apiKey nor oauthToken is set", async () => {
  await expect(
    runClaudeBackend({
      auth: {},
      agent: {
        frontmatter: {
          name: "x",
          description: "",
          trigger: { type: "manual" },
          model: "m",
          tools: [],
        },
        systemPrompt: "",
        source: "",
      },
      system: "",
      messages: [{ role: "user", content: "" }],
      maxSteps: 1,
      queryFn: mockQuery([asResult("")]).queryFn,
    }),
  ).rejects.toThrow(/apiKey.*oauthToken/);
});

test("runClaudeBackend: vault tool → http MCP server with bearer header", async () => {
  const { queryFn, seen } = mockQuery([asResult("ok")]);
  await runClaudeBackend({
    auth: { apiKey: "k" },
    agent: {
      frontmatter: {
        name: "x",
        description: "",
        trigger: { type: "manual" },
        model: "m",
        tools: ["vault"],
      },
      systemPrompt: "",
      source: "",
    },
    system: "",
    messages: [{ role: "user", content: "" }],
    vault: { url: "http://vault.example/mcp", token: "vault-token" },
    maxSteps: 1,
    queryFn,
  });
  const mcp = (seen.calls[0]!.options as { mcpServers: Record<string, unknown> }).mcpServers;
  expect(mcp.vault).toEqual({
    type: "http",
    url: "http://vault.example/mcp",
    headers: { Authorization: "Bearer vault-token" },
  });
});

test("runClaudeBackend: history is folded into the prompt as a transcript", async () => {
  const { queryFn, seen } = mockQuery([asResult("ok")]);
  await runClaudeBackend({
    auth: { apiKey: "k" },
    agent: {
      frontmatter: {
        name: "x",
        description: "",
        trigger: { type: "manual" },
        model: "m",
        tools: [],
      },
      systemPrompt: "",
      source: "",
    },
    system: "",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ],
    maxSteps: 1,
    queryFn,
  });
  const prompt = seen.calls[0]!.prompt as string;
  expect(prompt).toContain("User: first");
  expect(prompt).toContain("Assistant: reply");
  expect(prompt).toContain("Current message:\nsecond");
});

test("runClaudeBackend: SDK error result surfaces as thrown error", async () => {
  const errMsg: SDKMessage = {
    type: "result",
    subtype: "error_max_turns",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 99,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    errors: ["too many turns"],
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "s",
  } as SDKMessage;
  const { queryFn } = mockQuery([errMsg]);
  await expect(
    runClaudeBackend({
      auth: { apiKey: "k" },
      agent: {
        frontmatter: {
          name: "x",
          description: "",
          trigger: { type: "manual" },
          model: "m",
          tools: [],
        },
        systemPrompt: "",
        source: "",
      },
      system: "",
      messages: [{ role: "user", content: "" }],
      maxSteps: 1,
      queryFn,
    }),
  ).rejects.toThrow(/error_max_turns/);
});

test("AgentRunner: frontmatter backend: claude routes through Claude Agent SDK", async () => {
  const { queryFn, seen } = mockQuery([asResult("claude spoke")]);
  const runner = new AgentRunner({
    agents: { "echo.md": echoAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    claudeAuth: { apiKey: "test" },
  });
  const result = await runner.runAgent(
    "echo-claude",
    { text: "ping" },
    { claudeQueryFn: queryFn },
  );
  expect(result.text).toBe("claude spoke");
  expect(seen.calls).toHaveLength(1);
});

test("AgentRunner: vercel-ai stays default and doesn't require claudeAuth", async () => {
  const vercel = `---
name: vercel-default
trigger:
  type: manual
model: some-model
---
sys`;
  const mock = new MockLanguageModelV1({
    doGenerate: async () => ({
      text: "vercel spoke",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1 },
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
  const runner = new AgentRunner({
    agents: { "v.md": vercel },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
  const result = await runner.runAgent("vercel-default", { text: "ping" }, { model: mock });
  expect(result.text).toBe("vercel spoke");
});

test("AgentRunner: claude backend without claudeAuth raises a clear error", async () => {
  const runner = new AgentRunner({
    agents: { "echo.md": echoAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
  await expect(runner.runAgent("echo-claude", { text: "ping" })).rejects.toThrow(/claudeAuth/);
});
