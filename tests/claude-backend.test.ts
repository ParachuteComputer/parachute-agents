import { expect, test } from "bun:test";
import { MockLanguageModelV1 } from "ai/test";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRunner } from "../src/runner.js";
import { runClaudeBackend, type ClaudeTool } from "../src/backends/claude.js";

// Mock an Anthropic client by implementing the one method we call. The SDK
// types are huge; cast the shape we care about and keep the mock tight.
interface MsgCreateArgs {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
}
function mockClient(
  steps: Array<Partial<Anthropic.Message> & { content: Anthropic.ContentBlock[] }>,
  seen: { calls: MsgCreateArgs[] } = { calls: [] },
) {
  let i = 0;
  const client = {
    messages: {
      create: async (args: MsgCreateArgs) => {
        // Snapshot the args so later mutations to the shared `turns` array
        // inside the backend don't retroactively change what we captured.
        seen.calls.push({ ...args, messages: [...args.messages] });
        const step = steps[i++];
        if (!step) throw new Error(`mockClient: exhausted after ${i - 1} calls`);
        return {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: args.model,
          stop_reason: step.stop_reason ?? "end_turn",
          usage: step.usage ?? { input_tokens: 1, output_tokens: 1 },
          content: step.content,
        } as Anthropic.Message;
      },
    },
  };
  return { client: client as unknown as Anthropic, seen };
}

const echoAgent = `---
name: echo-claude
trigger:
  type: manual
backend: claude
model: claude-sonnet-4-5
---
you are echo`;

test("runClaudeBackend: single-turn end_turn returns text and zero tool calls", async () => {
  const { client, seen } = mockClient([
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello world", citations: null } as Anthropic.TextBlock],
    },
  ]);
  const result = await runClaudeBackend({
    auth: {},
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
    maxSteps: 8,
    tools: [],
    client,
  });
  expect(result.text).toBe("hello world");
  expect(result.toolCalls).toBe(0);
  expect(seen.calls).toHaveLength(1);
  expect(seen.calls[0]!.system).toBe("sys");
  expect(seen.calls[0]!.tools).toBeUndefined();
});

test("runClaudeBackend: tool_use → tool_result → final text counts tool calls", async () => {
  const tool: ClaudeTool = {
    name: "add",
    description: "add two",
    input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    execute: async (args) => {
      const { a, b } = args as { a: number; b: number };
      return String(a + b);
    },
  };
  const { client, seen } = mockClient([
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "I'll compute it.", citations: null } as Anthropic.TextBlock,
        {
          type: "tool_use",
          id: "toolu_1",
          name: "add",
          input: { a: 2, b: 3 },
        } as Anthropic.ToolUseBlock,
      ],
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "answer is 5", citations: null } as Anthropic.TextBlock],
    },
  ]);
  const result = await runClaudeBackend({
    auth: {},
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
    messages: [{ role: "user", content: "what is 2+3?" }],
    maxSteps: 8,
    tools: [tool],
    client,
  });
  expect(result.text).toBe("answer is 5");
  expect(result.toolCalls).toBe(1);
  expect(seen.calls).toHaveLength(2);
  // After tool execution the client must receive the tool_result as a user turn.
  const secondCall = seen.calls[1]!;
  const lastTurn = secondCall.messages[secondCall.messages.length - 1]!;
  expect(lastTurn.role).toBe("user");
  const blocks = lastTurn.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
  expect(blocks[0]!.type).toBe("tool_result");
  expect(blocks[0]!.tool_use_id).toBe("toolu_1");
  expect(blocks[0]!.content).toBe("5");
});

test("runClaudeBackend: tool execution error surfaces as is_error tool_result", async () => {
  const tool: ClaudeTool = {
    name: "fail",
    description: "always throws",
    input_schema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("boom");
    },
  };
  const { client, seen } = mockClient([
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_err",
          name: "fail",
          input: {},
        } as Anthropic.ToolUseBlock,
      ],
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "recovered", citations: null } as Anthropic.TextBlock],
    },
  ]);
  const result = await runClaudeBackend({
    auth: {},
    agent: {
      frontmatter: {
        name: "x",
        description: "",
        trigger: { type: "manual" },
        model: "claude-sonnet-4-5",
        tools: [],
      },
      systemPrompt: "",
      source: "",
    },
    system: "",
    messages: [{ role: "user", content: "try the tool" }],
    maxSteps: 8,
    tools: [tool],
    client,
  });
  expect(result.toolCalls).toBe(1);
  expect(result.text).toBe("recovered");
  const blocks = seen.calls[1]!.messages[seen.calls[1]!.messages.length - 1]!.content as Array<{
    is_error?: boolean;
    content?: string;
  }>;
  expect(blocks[0]!.is_error).toBe(true);
  expect(blocks[0]!.content).toContain("boom");
});

test("runClaudeBackend: maxSteps caps the tool-use loop", async () => {
  const tool: ClaudeTool = {
    name: "loop",
    description: "",
    input_schema: { type: "object", properties: {} },
    execute: async () => "x",
  };
  const forever = Array.from({ length: 10 }, () => ({
    stop_reason: "tool_use" as const,
    content: [
      {
        type: "tool_use" as const,
        id: `toolu_${Math.random()}`,
        name: "loop",
        input: {},
      } as Anthropic.ToolUseBlock,
    ],
  }));
  const { client } = mockClient(forever);
  const result = await runClaudeBackend({
    auth: {},
    agent: {
      frontmatter: {
        name: "x",
        description: "",
        trigger: { type: "manual" },
        model: "claude-sonnet-4-5",
        tools: [],
      },
      systemPrompt: "",
      source: "",
    },
    system: "",
    messages: [{ role: "user", content: "go forever" }],
    maxSteps: 3,
    tools: [tool],
    client,
  });
  expect(result.toolCalls).toBe(3);
});

test("AgentRunner: frontmatter backend: claude routes through the Claude path", async () => {
  let claudeCalls = 0;
  const { client } = mockClient([
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "claude spoke", citations: null } as Anthropic.TextBlock],
    },
  ]);
  // Wrap the client so we can count invocations.
  const tracked = {
    messages: {
      create: async (args: MsgCreateArgs) => {
        claudeCalls++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (client.messages as any).create(args);
      },
    },
  } as unknown as Anthropic;

  const runner = new AgentRunner({
    agents: { "echo.md": echoAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    claudeAuth: { apiKey: "test" },
  });

  const result = await runner.runAgent(
    "echo-claude",
    { text: "ping" },
    { anthropicClient: tracked },
  );
  expect(result.text).toBe("claude spoke");
  expect(claudeCalls).toBe(1);
});

test("AgentRunner: vercel-ai stays the default and never touches Claude auth", async () => {
  const vercel = `---
name: vercel-default
trigger:
  type: manual
model: some-model
---
system`;
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
    // deliberately NO claudeAuth — vercel path shouldn't need it
  });
  const result = await runner.runAgent("vercel-default", { text: "ping" }, { model: mock });
  expect(result.text).toBe("vercel spoke");
});

test("AgentRunner: claude backend without claudeAuth raises a clear error", async () => {
  const runner = new AgentRunner({
    agents: { "echo.md": echoAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
  await expect(runner.runAgent("echo-claude", { text: "ping" })).rejects.toThrow(
    /claudeAuth/,
  );
});
