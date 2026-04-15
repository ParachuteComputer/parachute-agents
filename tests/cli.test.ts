import { expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunLog } from "../src/run-log-sqlite.js";
import { SqliteConversationStore } from "../src/conversation-store-sqlite.js";
import { main } from "../src/cli.js";

const tmp = mkdtempSync(join(tmpdir(), "agents-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  const chunks: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return fn().then(
    (result) => {
      console.log = origLog;
      return { out: chunks.join("\n"), result };
    },
    (err) => {
      console.log = origLog;
      throw err;
    },
  );
}

function setupFixture() {
  const dir = join(tmp, `case-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const agentsDir = join(dir, "agents");
  const dbDir = join(dir, ".agents");
  mkdirSync(agentsDir);
  mkdirSync(dbDir);

  writeFileSync(
    join(agentsDir, "daily.md"),
    `---
name: daily-digest
trigger:
  type: cron
  schedule: "0 9 * * *"
model: test-model
---
body`,
  );
  writeFileSync(
    join(agentsDir, "chat.md"),
    `---
name: general-chat
trigger:
  type: webhook
  source: any
  match: always
model: test-model
---
body`,
  );

  return { dir, agentsDir, dbDir };
}

test("agents list prints both loaded agents with triggers", async () => {
  const { agentsDir, dbDir } = setupFixture();
  const { out } = await captureStdout(() =>
    main(["agents", "list", "--agents-dir", agentsDir, "--db-dir", dbDir]),
  );
  expect(out).toContain("daily-digest");
  expect(out).toContain("cron 0 9 * * *");
  expect(out).toContain("general-chat");
  expect(out).toContain("webhook any/always");
});

test("agents show prints raw markdown for named agent", async () => {
  const { agentsDir, dbDir } = setupFixture();
  const { out } = await captureStdout(() =>
    main(["agents", "show", "daily-digest", "--agents-dir", agentsDir, "--db-dir", dbDir]),
  );
  expect(out).toContain("name: daily-digest");
  expect(out).toContain("schedule:");
});

test("runs list prints newest first with short id and trigger", async () => {
  const { agentsDir, dbDir } = setupFixture();
  const log = new SqliteRunLog(join(dbDir, "runs.db"));
  await log.record({
    id: "aaaaaaaa-old",
    agentName: "general-chat",
    startedAt: 1000,
    endedAt: 1100,
    durationMs: 100,
    input: { text: "hi" },
    output: "hello",
    toolCalls: 0,
    error: null,
    trigger: "webhook",
  });
  await log.record({
    id: "bbbbbbbb-new",
    agentName: "daily-digest",
    startedAt: 2000,
    endedAt: 2300,
    durationMs: 300,
    input: { text: "" },
    output: "digest",
    toolCalls: 2,
    error: null,
    trigger: "cron",
  });
  log.close();

  const { out } = await captureStdout(() =>
    main(["runs", "list", "--agents-dir", agentsDir, "--db-dir", dbDir]),
  );
  const daily = out.indexOf("daily-digest");
  const chat = out.indexOf("general-chat");
  expect(daily).toBeGreaterThan(-1);
  expect(chat).toBeGreaterThan(-1);
  expect(daily).toBeLessThan(chat);
  expect(out).toContain("bbbbbbbb");
  expect(out).toContain("300ms");
});

test("runs show by short id prefix prints full detail", async () => {
  const { agentsDir, dbDir } = setupFixture();
  const log = new SqliteRunLog(join(dbDir, "runs.db"));
  await log.record({
    id: "abc12345-xyz",
    agentName: "x",
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    input: { text: "hello" },
    output: "world",
    toolCalls: 1,
    error: null,
    trigger: "manual",
  });
  log.close();

  const { out } = await captureStdout(() =>
    main(["runs", "show", "abc12345", "--agents-dir", agentsDir, "--db-dir", dbDir]),
  );
  expect(out).toContain("abc12345-xyz");
  expect(out).toContain("world");
  expect(out).toContain("\"text\": \"hello\"");
});

test("convo list + show work against a real sqlite conversation store", async () => {
  const { agentsDir, dbDir } = setupFixture();
  const store = new SqliteConversationStore(join(dbDir, "conversations.db"));
  await store.append("telegram:chat1", { role: "user", content: "first", ts: 100 });
  await store.append("telegram:chat1", { role: "assistant", content: "ack", ts: 200 });
  await store.append("telegram:chat2", { role: "user", content: "other", ts: 50 });
  store.close();

  const listOut = await captureStdout(() =>
    main(["convo", "list", "--agents-dir", agentsDir, "--db-dir", dbDir]),
  );
  expect(listOut.out).toContain("telegram:chat1");
  expect(listOut.out).toContain("telegram:chat2");
  // chat1 had last_ts=200, chat2=50 → chat1 first
  const i1 = listOut.out.indexOf("telegram:chat1");
  const i2 = listOut.out.indexOf("telegram:chat2");
  expect(i1).toBeLessThan(i2);

  const showOut = await captureStdout(() =>
    main(["convo", "show", "telegram:chat1", "--agents-dir", agentsDir, "--db-dir", dbDir]),
  );
  expect(showOut.out).toContain("first");
  expect(showOut.out).toContain("ack");
});

test("convo clear --yes deletes the named conversation only", async () => {
  const { agentsDir, dbDir } = setupFixture();
  const store = new SqliteConversationStore(join(dbDir, "conversations.db"));
  await store.append("c1", { role: "user", content: "a", ts: 1 });
  await store.append("c2", { role: "user", content: "b", ts: 2 });
  store.close();

  const { out } = await captureStdout(() =>
    main(["convo", "clear", "c1", "--yes", "--agents-dir", agentsDir, "--db-dir", dbDir]),
  );
  expect(out).toContain("Deleted 1");

  const store2 = new SqliteConversationStore(join(dbDir, "conversations.db"));
  expect(await store2.history("c1", 10)).toEqual([]);
  expect((await store2.history("c2", 10)).length).toBe(1);
  store2.close();
});

test("convo clear without --yes exits 2 and deletes nothing", async () => {
  const { agentsDir, dbDir } = setupFixture();
  const store = new SqliteConversationStore(join(dbDir, "conversations.db"));
  await store.append("c1", { role: "user", content: "a", ts: 1 });
  store.close();

  const origExit = process.exit;
  const origErr = process.stderr.write.bind(process.stderr);
  let exitCode: number | undefined;
  let stderr = "";
  (process as { exit: (c?: number) => never }).exit = ((c?: number) => {
    exitCode = c;
    throw new Error("__exit__");
  }) as typeof process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await main(["convo", "clear", "c1", "--agents-dir", agentsDir, "--db-dir", dbDir]);
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
  } finally {
    process.exit = origExit;
    process.stderr.write = origErr;
  }

  expect(exitCode).toBe(2);
  expect(stderr).toContain("Refusing to clear");

  const store2 = new SqliteConversationStore(join(dbDir, "conversations.db"));
  expect((await store2.history("c1", 10)).length).toBe(1);
  store2.close();
});

test("unknown flag returns exit code 2", async () => {
  const code = await main(["agents", "list", "--bogus"]);
  expect(code).toBe(2);
});

test("unknown command returns exit code 2", async () => {
  const code = await main(["nope"]);
  expect(code).toBe(2);
});

test("--help prints usage without touching disk", async () => {
  const { out, result } = await captureStdout(() => main(["--help"]));
  expect(result).toBe(0);
  expect(out).toContain("parachute-agent");
  expect(out).toContain("agents list");
  expect(out).toContain("runs list");
});
