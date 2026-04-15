import { expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRunLog, type AgentRun, type RunTrigger } from "../src/run-log.js";
import { SqliteRunLog } from "../src/run-log-sqlite.js";

const tmp = mkdtempSync(join(tmpdir(), "agents-runs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let uid = 0;
function mkRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const startedAt = overrides.startedAt ?? ++uid;
  return {
    id: `id-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    agentName: "a",
    startedAt,
    endedAt: startedAt + 10,
    durationMs: 10,
    input: { text: "hi" },
    output: "ok",
    toolCalls: 0,
    error: null,
    trigger: "manual" as RunTrigger,
    ...overrides,
  };
}

test("memory: list returns newest first", async () => {
  const log = new MemoryRunLog();
  await log.record(mkRun({ startedAt: 1 }));
  await log.record(mkRun({ startedAt: 3 }));
  await log.record(mkRun({ startedAt: 2 }));
  const rows = await log.list({});
  expect(rows.map((r) => r.startedAt)).toEqual([3, 2, 1]);
});

test("memory: filter by agent / since / limit", async () => {
  const log = new MemoryRunLog();
  await log.record(mkRun({ agentName: "a", startedAt: 10 }));
  await log.record(mkRun({ agentName: "b", startedAt: 20 }));
  await log.record(mkRun({ agentName: "a", startedAt: 30 }));
  await log.record(mkRun({ agentName: "a", startedAt: 40 }));

  expect((await log.list({ agent: "a" })).map((r) => r.startedAt)).toEqual([40, 30, 10]);
  expect((await log.list({ since: 25 })).map((r) => r.startedAt)).toEqual([40, 30]);
  expect((await log.list({ agent: "a", limit: 2 })).map((r) => r.startedAt)).toEqual([40, 30]);
});

test("memory: cap drops oldest per agent, untouched across agents", async () => {
  const log = new MemoryRunLog({ capPerAgent: 2 });
  await log.record(mkRun({ agentName: "a", startedAt: 1 }));
  await log.record(mkRun({ agentName: "a", startedAt: 2 }));
  await log.record(mkRun({ agentName: "b", startedAt: 3 }));
  await log.record(mkRun({ agentName: "a", startedAt: 4 }));
  const a = await log.list({ agent: "a" });
  const b = await log.list({ agent: "b" });
  expect(a.map((r) => r.startedAt)).toEqual([4, 2]);
  expect(b.map((r) => r.startedAt)).toEqual([3]);
});

test("memory: get by id / get missing returns null", async () => {
  const log = new MemoryRunLog();
  const r = mkRun();
  await log.record(r);
  expect((await log.get(r.id))?.id).toBe(r.id);
  expect(await log.get("nope")).toBeNull();
});

test("memory: clear({agent}) / clear({before}) match sqlite semantics", async () => {
  const log = new MemoryRunLog();
  await log.record(mkRun({ agentName: "a", startedAt: 10 }));
  await log.record(mkRun({ agentName: "b", startedAt: 20 }));
  await log.record(mkRun({ agentName: "a", startedAt: 30 }));
  expect(await log.clear({ agent: "a" })).toBe(2);
  expect((await log.list({})).map((r) => r.agentName)).toEqual(["b"]);

  const log2 = new MemoryRunLog();
  await log2.record(mkRun({ startedAt: 10 }));
  await log2.record(mkRun({ startedAt: 20 }));
  await log2.record(mkRun({ startedAt: 30 }));
  expect(await log2.clear({ before: 25 })).toBe(2);
  expect((await log2.list({})).map((r) => r.startedAt)).toEqual([30]);
});

test("sqlite: record + list newest first", async () => {
  const log = new SqliteRunLog(join(tmp, "order.db"));
  await log.record(mkRun({ startedAt: 10 }));
  await log.record(mkRun({ startedAt: 30 }));
  await log.record(mkRun({ startedAt: 20 }));
  const rows = await log.list({});
  expect(rows.map((r) => r.startedAt)).toEqual([30, 20, 10]);
  log.close();
});

test("sqlite: filter combinations", async () => {
  const log = new SqliteRunLog(join(tmp, "filter.db"));
  await log.record(mkRun({ agentName: "a", startedAt: 10 }));
  await log.record(mkRun({ agentName: "b", startedAt: 20 }));
  await log.record(mkRun({ agentName: "a", startedAt: 30 }));
  await log.record(mkRun({ agentName: "a", startedAt: 40 }));

  expect((await log.list({ agent: "a" })).map((r) => r.startedAt)).toEqual([40, 30, 10]);
  expect((await log.list({ since: 25 })).map((r) => r.startedAt)).toEqual([40, 30]);
  expect((await log.list({ agent: "a", limit: 2 })).map((r) => r.startedAt)).toEqual([40, 30]);
  log.close();
});

test("sqlite: clear({agent}) only deletes that agent", async () => {
  const log = new SqliteRunLog(join(tmp, "clear-agent.db"));
  await log.record(mkRun({ agentName: "a", startedAt: 1 }));
  await log.record(mkRun({ agentName: "b", startedAt: 2 }));
  const removed = await log.clear({ agent: "a" });
  expect(removed).toBe(1);
  expect((await log.list({})).map((r) => r.agentName)).toEqual(["b"]);
  log.close();
});

test("sqlite: clear({before}) deletes older rows only", async () => {
  const log = new SqliteRunLog(join(tmp, "clear-before.db"));
  await log.record(mkRun({ startedAt: 10 }));
  await log.record(mkRun({ startedAt: 20 }));
  await log.record(mkRun({ startedAt: 30 }));
  const removed = await log.clear({ before: 25 });
  expect(removed).toBe(2);
  expect((await log.list({})).map((r) => r.startedAt)).toEqual([30]);
  log.close();
});

test("sqlite: persists across reopen", async () => {
  const path = join(tmp, "persist.db");
  const a = new SqliteRunLog(path);
  const r = mkRun({ startedAt: 42 });
  await a.record(r);
  a.close();
  const b = new SqliteRunLog(path);
  expect((await b.get(r.id))?.startedAt).toBe(42);
  b.close();
});

test("sqlite: preserves input object via JSON round-trip", async () => {
  const log = new SqliteRunLog(join(tmp, "input.db"));
  await log.record(
    mkRun({
      startedAt: 1,
      input: { text: "hello", source: "telegram", conversationId: "telegram:42" },
    }),
  );
  const rows = await log.list({});
  expect(rows[0]!.input).toEqual({
    text: "hello",
    source: "telegram",
    conversationId: "telegram:42",
  });
  log.close();
});
