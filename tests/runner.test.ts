import { expect, test } from "bun:test";
import { MockLanguageModelV1 } from "ai/test";
import type { LanguageModelV1CallOptions } from "@ai-sdk/provider";
import { AgentRunner } from "../src/runner.js";
import { MemoryConversationStore } from "../src/conversation-store.js";

const extractEvent = `---
name: extract-event
trigger:
  type: webhook
  source: telegram
  match: contains_url
model: test-model
---
system`;

const generalChat = `---
name: general-chat
trigger:
  type: webhook
  source: any
  match: always
model: test-model
---
system`;

const otherChat = `---
name: other-chat
trigger:
  type: webhook
  source: any
  match: always
model: test-model
---
system`;

function runner(agents: Record<string, string>) {
  return new AgentRunner({
    agents,
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
}

test("URL payload → specific matcher wins", () => {
  const r = runner({ "extract.md": extractEvent, "general.md": generalChat });
  const hit = r.matchWebhook({ text: "check https://example.com", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("extract-event");
});

test("plain payload → catch-all fires", () => {
  const r = runner({ "extract.md": extractEvent, "general.md": generalChat });
  const hit = r.matchWebhook({ text: "hi there", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("general-chat");
});

test("reversed load order: URL payload still routes to specific matcher", () => {
  const r = runner({ "general.md": generalChat, "extract.md": extractEvent });
  const hit = r.matchWebhook({ text: "https://example.com", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("extract-event");
});

test("two always agents: first-loaded wins", () => {
  const r = runner({ "general.md": generalChat, "other.md": otherChat });
  const hit = r.matchWebhook({ text: "hi", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("general-chat");
});

function makeMock(capture: { calls: LanguageModelV1CallOptions[] }, reply: string) {
  return new MockLanguageModelV1({
    doGenerate: async (opts) => {
      capture.calls.push(opts);
      return {
        text: reply,
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

test("runAgent with conversationId: loads prior turns and appends new pair", async () => {
  const store = new MemoryConversationStore();
  await store.append("telegram:chat1", { role: "user", content: "first", ts: 1 });
  await store.append("telegram:chat1", { role: "assistant", content: "ack", ts: 2 });

  const capture = { calls: [] as LanguageModelV1CallOptions[] };
  const r = new AgentRunner({
    agents: { "general.md": generalChat },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    conversationStore: store,
    providerOverride: () => makeMock(capture, "second response"),
  });

  const result = await r.runAgent(
    "general-chat",
    { text: "second" },
    { conversationId: "telegram:chat1" },
  );

  expect(result.text).toBe("second response");
  expect(capture.calls).toHaveLength(1);
  const prompt = capture.calls[0]!.prompt;
  const userTurns = prompt.filter((p) => p.role === "user");
  const assistantTurns = prompt.filter((p) => p.role === "assistant");
  expect(userTurns).toHaveLength(2);
  expect(assistantTurns).toHaveLength(1);

  const history = await store.history("telegram:chat1", 10);
  expect(history.map((t) => `${t.role}:${t.content}`)).toEqual([
    "user:first",
    "assistant:ack",
    "user:second",
    "assistant:second response",
  ]);
});

test("runAgent without conversationId: no history loaded, no turns appended", async () => {
  const store = new MemoryConversationStore();
  const capture = { calls: [] as LanguageModelV1CallOptions[] };
  const r = new AgentRunner({
    agents: { "general.md": generalChat },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    conversationStore: store,
    providerOverride: () => makeMock(capture, "ok"),
  });

  await r.runAgent("general-chat", { text: "hi" });

  const prompt = capture.calls[0]!.prompt;
  expect(prompt.filter((p) => p.role === "user")).toHaveLength(1);
  expect(prompt.filter((p) => p.role === "assistant")).toHaveLength(0);
  expect(await store.history("anything", 10)).toEqual([]);
});
