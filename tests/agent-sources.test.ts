import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client as RawMcpClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  loadAgents,
  loadAgentsInline,
  loadAgentsFromVault,
} from "../src/agent-sources.js";

function mockVaultClient(rows: Array<Record<string, unknown>>, opts: {
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const seen: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const client = {
    callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
      seen.push(req);
      if (opts.callTool) return opts.callTool(req.name, req.arguments);
      return { content: [{ type: "text", text: JSON.stringify({ notes: rows }) }] };
    },
    close: async () => {},
  } as unknown as RawMcpClient;
  return { client, seen };
}

test("loadAgents({type:'inline'}): returns a copy of the input map", async () => {
  const input = { "a.md": "one", "b.md": "two" };
  const out = await loadAgents({ type: "inline", agents: input });
  expect(out).toEqual(input);
  out["c.md"] = "three";
  expect(input).not.toHaveProperty("c.md");
});

test("loadAgents({type:'dir'}): recursively picks up *.md files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parachute-agents-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "a.md"), "# a");
  writeFileSync(join(dir, "nested", "b.md"), "# b");
  writeFileSync(join(dir, "skip.txt"), "not md");
  const out = await loadAgents({ type: "dir", path: dir });
  expect(Object.keys(out).sort()).toEqual(["a.md", "nested/b.md"]);
  expect(out["a.md"]).toBe("# a");
  expect(out["nested/b.md"]).toBe("# b");
});

test("loadAgents({type:'vault'}): maps notes[path] → notes[content] and uses default tag", async () => {
  const { client, seen } = mockVaultClient([
    { path: "Agents/daily", content: "---\nname: daily\n---\nbody" },
    { path: "Agents/weekly", content: "---\nname: weekly\n---\nbody" },
  ]);
  const out = await loadAgents({
    type: "vault",
    vault: { url: "http://x", token: "t" },
    client,
  });
  expect(out["Agents/daily"]).toContain("name: daily");
  expect(out["Agents/weekly"]).toContain("name: weekly");
  expect(seen[0]!.arguments).toMatchObject({
    tag: ["agent-definition"],
    tag_match: "all",
    include_content: true,
  });
});

test("loadAgents({type:'vault'}): custom tag is forwarded", async () => {
  const { client, seen } = mockVaultClient([]);
  await loadAgents({
    type: "vault",
    vault: { url: "http://x", token: "t" },
    tag: "custom-agent",
    client,
  });
  expect(seen[0]!.arguments.tag).toEqual(["custom-agent"]);
});

test("loadAgents({type:'vault'}): skips rows without content, keeps the rest", async () => {
  const { client } = mockVaultClient([
    { path: "Agents/empty", content: "" },
    { path: "Agents/nocontent" },
    { path: "Agents/ok", content: "---\nname: ok\n---\nbody" },
  ]);
  const out = await loadAgents({
    type: "vault",
    vault: { url: "http://x", token: "t" },
    client,
  });
  expect(Object.keys(out)).toEqual(["Agents/ok"]);
});

test("loadAgents({type:'vault'}): vault error → {} with a log", async () => {
  const { client } = mockVaultClient([], {
    callTool: async () => {
      throw new Error("network down");
    },
  });
  const logs: string[] = [];
  const out = await loadAgents({
    type: "vault",
    vault: { url: "http://x", token: "t" },
    client,
    logger: (m) => logs.push(m),
  });
  expect(out).toEqual({});
  expect(logs.some((m) => m.includes("network down"))).toBe(true);
});

test("loadAgents({type:'vault'}): bare array payload (not wrapped in {notes}) is accepted", async () => {
  const { client } = mockVaultClient([], {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { path: "Agents/flat", content: "---\nname: flat\n---\nbody" },
          ]),
        },
      ],
    }),
  });
  const out = await loadAgents({
    type: "vault",
    vault: { url: "http://x", token: "t" },
    client,
  });
  expect(out["Agents/flat"]).toContain("name: flat");
});

test("loadAgents({type:'vault'}): caller-owned client is not closed by the loader", async () => {
  let closed = false;
  const client = {
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ notes: [] }) }] }),
    close: async () => {
      closed = true;
    },
  } as unknown as RawMcpClient;
  await loadAgents({ type: "vault", vault: { url: "http://x", token: "t" }, client });
  expect(closed).toBe(false);
});

test("back-compat: loadAgentsInline + loadAgentsFromVault still work", async () => {
  const inline = loadAgentsInline({ "a.md": "x" });
  expect(inline).toEqual({ "a.md": "x" });

  const { client } = mockVaultClient([{ path: "P", content: "C" }]);
  const vault = await loadAgentsFromVault({ vault: { url: "http://x", token: "t" }, client });
  expect(vault).toEqual({ P: "C" });
});
