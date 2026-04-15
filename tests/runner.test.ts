import { expect, test } from "bun:test";
import { MockLanguageModelV1 } from "ai/test";
import type { LanguageModelV1CallOptions } from "@ai-sdk/provider";
import { AgentRunner } from "../src/runner.js";
import { MemoryConversationStore } from "../src/conversation-store.js";
import type { Scheduler } from "../src/scheduler.js";

const cronAgent = `---
name: daily-digest
trigger:
  type: cron
  schedule: "0 9 * * *"
model: test-model
---
system`;

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
  });

  const result = await r.runAgent(
    "general-chat",
    { text: "second" },
    { conversationId: "telegram:chat1", model: makeMock(capture, "second response") },
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
  });

  await r.runAgent("general-chat", { text: "hi" }, { model: makeMock(capture, "ok") });

  const prompt = capture.calls[0]!.prompt;
  expect(prompt.filter((p) => p.role === "user")).toHaveLength(1);
  expect(prompt.filter((p) => p.role === "assistant")).toHaveLength(0);
  expect(await store.history("anything", 10)).toEqual([]);
});

function fakeScheduler() {
  const calls: Array<{ id: string; cron: string }> = [];
  const scheduler: Scheduler = {
    schedule: (id, cron, _handler) => {
      calls.push({ id, cron });
    },
    cancel: () => {},
    cancelAll: () => {},
  };
  return { scheduler, calls };
}

test("runner with scheduler: cron agents auto-register", () => {
  const { scheduler, calls } = fakeScheduler();
  new AgentRunner({
    agents: { "digest.md": cronAgent, "general.md": generalChat },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    scheduler,
  });
  expect(calls).toEqual([{ id: "daily-digest", cron: "0 9 * * *" }]);
});

test("runner without scheduler: cron agents load but don't register", () => {
  const { scheduler, calls } = fakeScheduler();
  const r = new AgentRunner({
    agents: { "digest.md": cronAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
  expect(r.agents().has("daily-digest")).toBe(true);
  expect(calls).toHaveLength(0);
  void scheduler;
});

test("successful run is recorded with output and no error", async () => {
  const capture = { calls: [] as LanguageModelV1CallOptions[] };
  const r = new AgentRunner({
    agents: { "general.md": generalChat },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
  await r.runAgent("general-chat", { text: "hi" }, { model: makeMock(capture, "hello back") });
  const runs = await r.runs({});
  expect(runs).toHaveLength(1);
  expect(runs[0]!.output).toBe("hello back");
  expect(runs[0]!.error).toBeNull();
  expect(runs[0]!.agentName).toBe("general-chat");
  expect(runs[0]!.trigger).toBe("manual");
  expect(runs[0]!.durationMs).toBeGreaterThanOrEqual(0);
});

test("failing run is still recorded with error set and output null", async () => {
  const r = new AgentRunner({
    agents: { "general.md": generalChat },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
  const exploding = new MockLanguageModelV1({
    doGenerate: async () => {
      throw new Error("boom");
    },
  });
  await expect(
    r.runAgent("general-chat", { text: "hi" }, { model: exploding }),
  ).rejects.toThrow("boom");
  const runs = await r.runs({});
  expect(runs).toHaveLength(1);
  expect(runs[0]!.output).toBeNull();
  expect(runs[0]!.error).toBe("boom");
  expect(runs[0]!.trigger).toBe("manual");
});

test("trigger option is stamped on the recorded run", async () => {
  const capture = { calls: [] as LanguageModelV1CallOptions[] };
  const r = new AgentRunner({
    agents: { "general.md": generalChat },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
  await r.runAgent(
    "general-chat",
    { text: "hi" },
    { model: makeMock(capture, "a"), trigger: "webhook" },
  );
  await r.runAgent(
    "general-chat",
    { text: "hi" },
    { model: makeMock(capture, "b"), trigger: "cron" },
  );
  const runs = await r.runs({});
  expect(runs).toHaveLength(2);
  expect(runs.map((x) => x.trigger).sort()).toEqual(["cron", "webhook"]);
});
