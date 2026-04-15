import { expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryConversationStore } from "../src/conversation-store.js";
import { SqliteConversationStore } from "../src/conversation-store-sqlite.js";

const tmp = mkdtempSync(join(tmpdir(), "agents-conv-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("memory: append then history returns in order", async () => {
  const s = new MemoryConversationStore();
  await s.append("c1", { role: "user", content: "hi", ts: 1 });
  await s.append("c1", { role: "assistant", content: "hey", ts: 2 });
  const h = await s.history("c1", 10);
  expect(h.map((t) => t.content)).toEqual(["hi", "hey"]);
});

test("memory: limit returns most recent N", async () => {
  const s = new MemoryConversationStore();
  for (let i = 0; i < 5; i++) await s.append("c1", { role: "user", content: `m${i}`, ts: i });
  const h = await s.history("c1", 2);
  expect(h.map((t) => t.content)).toEqual(["m3", "m4"]);
});

test("memory: clear empties the conversation", async () => {
  const s = new MemoryConversationStore();
  await s.append("c1", { role: "user", content: "hi", ts: 1 });
  await s.clear("c1");
  expect(await s.history("c1", 10)).toEqual([]);
});

test("sqlite: append then history returns in order", async () => {
  const s = new SqliteConversationStore(join(tmp, "order.db"));
  await s.append("c1", { role: "user", content: "hi", ts: 1 });
  await s.append("c1", { role: "assistant", content: "hey", ts: 2 });
  const h = await s.history("c1", 10);
  expect(h.map((t) => t.content)).toEqual(["hi", "hey"]);
  s.close();
});

test("sqlite: limit returns most recent N", async () => {
  const s = new SqliteConversationStore(join(tmp, "limit.db"));
  for (let i = 0; i < 5; i++) await s.append("c1", { role: "user", content: `m${i}`, ts: i });
  const h = await s.history("c1", 2);
  expect(h.map((t) => t.content)).toEqual(["m3", "m4"]);
  s.close();
});

test("sqlite: clear empties the conversation", async () => {
  const s = new SqliteConversationStore(join(tmp, "clear.db"));
  await s.append("c1", { role: "user", content: "hi", ts: 1 });
  await s.clear("c1");
  expect(await s.history("c1", 10)).toEqual([]);
  s.close();
});

test("sqlite: persists across new instance pointing at same file", async () => {
  const path = join(tmp, "persist.db");
  const s1 = new SqliteConversationStore(path);
  await s1.append("c1", { role: "user", content: "remember me", ts: 42 });
  s1.close();
  const s2 = new SqliteConversationStore(path);
  const h = await s2.history("c1", 10);
  expect(h).toEqual([{ role: "user", content: "remember me", ts: 42 }]);
  s2.close();
});
