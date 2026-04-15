import { expect, test } from "bun:test";
import { MockLanguageModelV1 } from "ai/test";
import { AgentRunner } from "../src/runner.js";
import { MemoryCursorStore } from "../src/cursor-store.js";
import type { VaultNote, VaultQuery } from "../src/vault-watcher.js";
import type { VaultTrigger } from "../src/agents.js";

const capturedAgent = `---
name: captured-triage
trigger:
  type: vault
  on_event: created
  filter:
    tags: [captured]
    not_tags: [processed]
  poll_seconds: 30
model: test-model
---
system`;

function makeNote(id: string, createdAt: number, tags: string[] = ["captured"]): VaultNote {
  return {
    id,
    path: `Captured/${id}`,
    tags,
    createdAt,
    updatedAt: createdAt,
  };
}

function silentModel() {
  return new MockLanguageModelV1({
    doGenerate: async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1 },
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

function setup(options: {
  queryNotes: (q: VaultQuery) => Promise<VaultNote[]>;
  cursorStore?: MemoryCursorStore;
  autoStart?: boolean;
}) {
  const cursorStore = options.cursorStore ?? new MemoryCursorStore();
  const runner = new AgentRunner({
    agents: { "captured.md": capturedAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    vaultWatcher: {
      cursorStore,
      queryNotes: options.queryNotes,
      autoStart: options.autoStart ?? false,
    },
  });
  return { runner, cursorStore, watcher: runner.vaultWatcher()! };
}

function vaultTrigger(): VaultTrigger {
  return {
    type: "vault",
    on_event: "created",
    filter: { tags: ["captured"], not_tags: ["processed"] },
    poll_seconds: 30,
  };
}

test("vault watcher: new note matching filter fires the agent", async () => {
  const note = makeNote("n1", 1000);
  const queryCalls: VaultQuery[] = [];
  const { watcher, cursorStore, runner } = setup({
    queryNotes: async (q) => {
      queryCalls.push(q);
      return [note];
    },
  });

  // Avoid a real provider call — use an override model for the run.
  const originalRun = runner.runAgent.bind(runner);
  const runInputs: unknown[] = [];
  (runner as unknown as { runAgent: typeof runner.runAgent }).runAgent = ((
    name: string,
    input: Parameters<typeof runner.runAgent>[1],
    opts: Parameters<typeof runner.runAgent>[2] = {},
  ) => {
    runInputs.push(input);
    return originalRun(name, input, { ...opts, model: silentModel() });
  }) as typeof runner.runAgent;

  const fired = await watcher.pollOnce("captured-triage", vaultTrigger());
  expect(fired).toBe(1);
  expect(queryCalls[0]!.tags).toEqual(["captured"]);
  expect(queryCalls[0]!.notTags).toEqual(["processed"]);
  expect(await cursorStore.get("captured-triage")).toBe("1000");

  const runs = await runner.runs({});
  expect(runs).toHaveLength(1);
  expect(runs[0]!.trigger).toBe("vault");
  expect(runInputs[0]).toMatchObject({
    source: "vault",
    meta: { noteId: "n1", event: "created" },
  });
});

test("vault watcher: with an existing cursor, only later notes fire", async () => {
  const cursorStore = new MemoryCursorStore();
  await cursorStore.set("captured-triage", "1500");

  const notes = [makeNote("old", 1000), makeNote("new", 2000), makeNote("newer", 3000)];
  const { watcher, runner } = setup({
    queryNotes: async () => notes,
    cursorStore,
  });
  const originalRun = runner.runAgent.bind(runner);
  const firedNames: string[] = [];
  (runner as unknown as { runAgent: typeof runner.runAgent }).runAgent = ((
    name: string,
    input: Parameters<typeof runner.runAgent>[1],
    opts: Parameters<typeof runner.runAgent>[2] = {},
  ) => {
    const meta = (input.meta ?? {}) as { noteId?: string };
    firedNames.push(meta.noteId ?? "?");
    return originalRun(name, input, { ...opts, model: silentModel() });
  }) as typeof runner.runAgent;

  const fired = await watcher.pollOnce("captured-triage", vaultTrigger());
  expect(fired).toBe(2);
  // Oldest-first so the cursor advances monotonically.
  expect(firedNames).toEqual(["new", "newer"]);
  expect(await cursorStore.get("captured-triage")).toBe("3000");
});

test("vault watcher: a note with createdAt === cursor is not re-fired", async () => {
  // Belt-and-suspenders: the watcher filters client-side with `> since` even
  // if the vault's `date_from` is inclusive, so boundary notes don't repeat.
  const cursorStore = new MemoryCursorStore();
  await cursorStore.set("captured-triage", "1500");
  const notes = [makeNote("boundary", 1500), makeNote("after", 1501)];
  const { runner, watcher } = setup({ queryNotes: async () => notes, cursorStore });
  const fired: string[] = [];
  const originalRun = runner.runAgent.bind(runner);
  (runner as unknown as { runAgent: typeof runner.runAgent }).runAgent = ((
    name: string,
    input: Parameters<typeof runner.runAgent>[1],
    opts: Parameters<typeof runner.runAgent>[2] = {},
  ) => {
    fired.push(((input.meta ?? {}) as { noteId?: string }).noteId ?? "?");
    return originalRun(name, input, { ...opts, model: silentModel() });
  }) as typeof runner.runAgent;

  await watcher.pollOnce("captured-triage", vaultTrigger());
  expect(fired).toEqual(["after"]);
  expect(await cursorStore.get("captured-triage")).toBe("1501");
});

test("vault watcher: query parameters propagate the filter + cursor", async () => {
  const cursorStore = new MemoryCursorStore();
  await cursorStore.set("captured-triage", "500");
  const queryCalls: VaultQuery[] = [];
  const { watcher } = setup({
    queryNotes: async (q) => {
      queryCalls.push(q);
      return [];
    },
    cursorStore,
  });
  await watcher.pollOnce("captured-triage", vaultTrigger());
  expect(queryCalls).toHaveLength(1);
  expect(queryCalls[0]).toMatchObject({
    tags: ["captured"],
    notTags: ["processed"],
    since: 500,
    event: "created",
  });
});

test("vault watcher: a failing agent doesn't advance the cursor and the loop continues", async () => {
  const cursorStore = new MemoryCursorStore();
  const notes = [makeNote("first", 1000), makeNote("second", 2000)];
  const runner = new AgentRunner({
    agents: { "captured.md": capturedAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    vaultWatcher: {
      cursorStore,
      queryNotes: async () => notes,
      autoStart: false,
    },
  });
  const watcher = runner.vaultWatcher()!;

  // Make the run throw by patching runAgent.
  let calls = 0;
  (runner as unknown as { runAgent: typeof runner.runAgent }).runAgent = (async () => {
    calls++;
    throw new Error("agent blew up");
  }) as typeof runner.runAgent;

  const logs: string[] = [];
  (watcher as unknown as { config: { logger: (m: string) => void } }).config.logger =
    (m: string) => logs.push(m);

  // First poll: fails on `first`, cursor not advanced, subsequent notes not processed.
  const fired1 = await watcher.pollOnce("captured-triage", vaultTrigger());
  expect(fired1).toBe(0);
  expect(calls).toBe(1);
  expect(await cursorStore.get("captured-triage")).toBeNull();
  expect(logs.some((m) => m.includes("agent blew up"))).toBe(true);

  // Second poll happens and tries again — proves the loop isn't wedged.
  const fired2 = await watcher.pollOnce("captured-triage", vaultTrigger());
  expect(fired2).toBe(0);
  expect(calls).toBe(2);
});

test("vault watcher: start()/stop() drive per-agent intervals with configured poll_seconds", () => {
  type Tick = { fn: () => void; ms: number };
  const ticks: Tick[] = [];
  let nextHandle = 0;
  const cleared: number[] = [];
  const runner = new AgentRunner({
    agents: { "captured.md": capturedAgent },
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
    vaultWatcher: {
      queryNotes: async () => [],
      autoStart: false,
    },
  });
  const watcher = runner.vaultWatcher()!;
  (watcher as unknown as { config: { setInterval: unknown; clearInterval: unknown } }).config
    .setInterval = (fn: () => void, ms: number) => {
    ticks.push({ fn, ms });
    return ++nextHandle as unknown as ReturnType<typeof setInterval>;
  };
  (watcher as unknown as { config: { setInterval: unknown; clearInterval: unknown } }).config
    .clearInterval = (h: ReturnType<typeof setInterval>) => {
    cleared.push(h as unknown as number);
  };

  watcher.start();
  expect(ticks).toHaveLength(1);
  expect(ticks[0]!.ms).toBe(30_000);

  // idempotent
  watcher.start();
  expect(ticks).toHaveLength(1);

  watcher.stop();
  expect(cleared).toEqual([1]);
});
