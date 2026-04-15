import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "../src/cursor-store.js";
import { SqliteCursorStore } from "../src/cursor-store-sqlite.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

test("MemoryCursorStore: get returns null for unknown agents", async () => {
  const s = new MemoryCursorStore();
  expect(await s.get("nope")).toBeNull();
});

test("MemoryCursorStore: set then get round-trips", async () => {
  const s = new MemoryCursorStore();
  await s.set("a", "100");
  await s.set("b", "200");
  expect(await s.get("a")).toBe("100");
  expect(await s.get("b")).toBe("200");
  await s.set("a", "999");
  expect(await s.get("a")).toBe("999");
});

test("SqliteCursorStore: persists across instances backed by the same file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cursors.db");
  const s1 = new SqliteCursorStore(path);
  await s1.set("agent-1", "42");
  s1.close();

  const s2 = new SqliteCursorStore(path);
  expect(await s2.get("agent-1")).toBe("42");
  await s2.set("agent-1", "99");
  expect(await s2.get("agent-1")).toBe("99");
  s2.close();
});
