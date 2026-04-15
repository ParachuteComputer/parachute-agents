import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUiApp, snapshotJson } from "../src/ui/server.js";
import { buildSnapshot, type UiPaths } from "../src/ui/state.js";
import { SqliteRunLog } from "../src/run-log-sqlite.js";
import { SqliteConversationStore } from "../src/conversation-store-sqlite.js";
import type { AgentRun } from "../src/run-log.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mkFixture(): UiPaths {
  const root = mkdtempSync(join(tmpdir(), "ui-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const agentsDir = join(root, "agents");
  const dbDir = join(root, ".agents");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  return { agentsDir, dbDir };
}

const sampleAgent = `---
name: daily-digest
description: a sample
trigger:
  type: cron
  schedule: "0 9 * * *"
model: test-model
---

System prompt body.
`;

const brokenAgent = `---
name: broken
trigger:
  type: unknown
model: x
---

oops`;

function writeAgent(paths: UiPaths, file: string, src: string) {
  writeFileSync(join(paths.agentsDir, file), src);
}

function recordRun(paths: UiPaths, partial: Partial<AgentRun> & { agentName: string }) {
  const log = new SqliteRunLog(join(paths.dbDir, "runs.db"));
  try {
    const now = Date.now();
    const run: AgentRun = {
      id: partial.id ?? crypto.randomUUID(),
      agentName: partial.agentName,
      startedAt: partial.startedAt ?? now,
      endedAt: partial.endedAt ?? now + 50,
      durationMs: partial.durationMs ?? 50,
      input: partial.input ?? { text: "hello" },
      output: partial.output ?? "ok",
      toolCalls: partial.toolCalls ?? 0,
      error: partial.error ?? null,
      trigger: partial.trigger ?? "manual",
    };
    // Record expects start<=end, matches our defaults.
    // SqliteRunLog recomputes durationMs from start/end difference on read.
    void log.record(run);
    return run;
  } finally {
    log.close();
  }
}

test("buildSnapshot: lists agents with last-run data, orphans, and parse errors", async () => {
  const paths = mkFixture();
  writeAgent(paths, "daily.md", sampleAgent);
  writeAgent(paths, "broken.md", brokenAgent);
  const r = recordRun(paths, { agentName: "daily-digest", trigger: "cron" });
  recordRun(paths, { agentName: "ghost-agent", trigger: "manual" });

  const snap = await buildSnapshot(paths);
  const daily = snap.agents.find((c) => c.name === "daily-digest");
  expect(daily).toBeDefined();
  expect(daily!.parseError).toBeNull();
  expect(daily!.lastRun?.id).toBe(r.id);

  const broken = snap.agents.find((c) => c.path === "broken.md");
  expect(broken).toBeDefined();
  expect(broken!.parseError).toContain("trigger");

  expect(snap.orphanedRunAgents).toContain("ghost-agent");
});

test("dashboard HTML renders cards and resolves links", async () => {
  const paths = mkFixture();
  writeAgent(paths, "daily.md", sampleAgent);
  recordRun(paths, {
    agentName: "daily-digest",
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    trigger: "cron",
  });

  const app = buildUiApp({ paths });
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("daily-digest");
  expect(html).toContain("cron 0 9 * * *");
  expect(html).toContain("/agents/daily-digest");
  // Short id for the run appears in the card's tail.
  expect(html).toContain("aaaaaaaa");
});

test("agent detail page shows system prompt and recent runs", async () => {
  const paths = mkFixture();
  writeAgent(paths, "daily.md", sampleAgent);
  recordRun(paths, { agentName: "daily-digest", trigger: "cron" });

  const app = buildUiApp({ paths });
  const res = await app.request("/agents/daily-digest");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("System prompt body.");
  expect(html).toContain("recent runs");
});

test("agent detail: unknown agent → 404", async () => {
  const paths = mkFixture();
  const app = buildUiApp({ paths });
  const res = await app.request("/agents/nope");
  expect(res.status).toBe(404);
});

test("run detail page renders input, output, error", async () => {
  const paths = mkFixture();
  writeAgent(paths, "daily.md", sampleAgent);
  const good = recordRun(paths, {
    agentName: "daily-digest",
    input: { text: "golden-input-marker" },
    output: "here is the digest",
    trigger: "cron",
  });
  const bad = recordRun(paths, {
    agentName: "daily-digest",
    input: { text: "boom" },
    output: null,
    error: "model refused",
    trigger: "manual",
  });

  const app = buildUiApp({ paths });
  const okRes = await app.request(`/runs/${good.id}`);
  expect(okRes.status).toBe(200);
  const okHtml = await okRes.text();
  expect(okHtml).toContain("golden-input-marker");
  expect(okHtml).toContain("here is the digest");

  const failRes = await app.request(`/runs/${bad.id}`);
  expect(failRes.status).toBe(200);
  const failHtml = await failRes.text();
  expect(failHtml).toContain("model refused");
  expect(failHtml).toContain("failed");
});

test("run detail: short-id prefix match works", async () => {
  const paths = mkFixture();
  writeAgent(paths, "daily.md", sampleAgent);
  const r = recordRun(paths, { agentName: "daily-digest" });
  const app = buildUiApp({ paths });
  const res = await app.request(`/runs/${r.id.slice(0, 8)}`);
  expect(res.status).toBe(200);
});

test("conversations list + detail", async () => {
  const paths = mkFixture();
  const store = new SqliteConversationStore(join(paths.dbDir, "conversations.db"));
  try {
    await store.appendBatch("thread-1", [
      { role: "user", content: "hello", ts: 1000 },
      { role: "assistant", content: "hi there", ts: 2000 },
    ]);
  } finally {
    store.close();
  }

  const app = buildUiApp({ paths });
  const list = await app.request("/conversations");
  expect(list.status).toBe(200);
  expect(await list.text()).toContain("thread-1");

  const detail = await app.request("/conversations/thread-1");
  expect(detail.status).toBe(200);
  const html = await detail.text();
  expect(html).toContain("hello");
  expect(html).toContain("hi there");
});

test("api/snapshot returns JSON matching snapshotJson()", async () => {
  const paths = mkFixture();
  writeAgent(paths, "daily.md", sampleAgent);
  recordRun(paths, { agentName: "daily-digest", trigger: "cron" });

  const app = buildUiApp({ paths });
  const res = await app.request("/api/snapshot");
  expect(res.status).toBe(200);
  const body = (await res.json()) as ReturnType<typeof snapshotJson>;
  expect(body).toHaveProperty("agents");
  const daily = (body as { agents: Array<{ name: string }> }).agents.find(
    (a) => a.name === "daily-digest",
  );
  expect(daily).toBeDefined();
});

test("empty state: no agents dir, no dbs → dashboard still 200s with empty message", async () => {
  const paths = mkFixture();
  rmSync(paths.agentsDir, { recursive: true, force: true });
  const app = buildUiApp({ paths });
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("No agents found");
});
