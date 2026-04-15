import { expect, test } from "bun:test";
import type { Client as RawMcpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { loadAgentsFromVault, loadAgentsInline } from "../src/agent-sources.js";

function mockVaultClient(rows: Array<Record<string, unknown>>, opts: {
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  closeThrows?: boolean;
} = {}) {
  const seen: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const client = {
    callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
      seen.push(req);
      if (opts.callTool) return opts.callTool(req.name, req.arguments);
      return {
        content: [{ type: "text", text: JSON.stringify({ notes: rows }) }],
      };
    },
    close: async () => {
      if (opts.closeThrows) throw new Error("close failed");
    },
  } as unknown as RawMcpClient;
  return { client, seen };
}

test("loadAgentsInline: returns a copy of the input map", () => {
  const input = { "a.md": "one", "b.md": "two" };
  const out = loadAgentsInline(input);
  expect(out).toEqual(input);
  out["c.md"] = "three";
  expect(input).not.toHaveProperty("c.md");
});

test("loadAgentsFromVault: maps notes[path] → notes[content] and uses the default tag", async () => {
  const { client, seen } = mockVaultClient([
    { path: "Agents/daily", content: "---\nname: daily\n---\nbody" },
    { path: "Agents/weekly", content: "---\nname: weekly\n---\nbody" },
  ]);
  const out = await loadAgentsFromVault({
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

test("loadAgentsFromVault: custom tag is forwarded", async () => {
  const { client, seen } = mockVaultClient([]);
  await loadAgentsFromVault({
    vault: { url: "http://x", token: "t" },
    tag: "custom-agent",
    client,
  });
  expect(seen[0]!.arguments.tag).toEqual(["custom-agent"]);
});

test("loadAgentsFromVault: skips rows without content, keeps the rest", async () => {
  const { client } = mockVaultClient([
    { path: "Agents/empty", content: "" },
    { path: "Agents/nocontent" },
    { path: "Agents/ok", content: "---\nname: ok\n---\nbody" },
  ]);
  const out = await loadAgentsFromVault({
    vault: { url: "http://x", token: "t" },
    client,
  });
  expect(Object.keys(out)).toEqual(["Agents/ok"]);
});

test("loadAgentsFromVault: returns {} when the vault errors, and logs", async () => {
  const { client } = mockVaultClient([], {
    callTool: async () => {
      throw new Error("network down");
    },
  });
  const logs: string[] = [];
  const out = await loadAgentsFromVault({
    vault: { url: "http://x", token: "t" },
    client,
    logger: (m) => logs.push(m),
  });
  expect(out).toEqual({});
  expect(logs.some((m) => m.includes("network down"))).toBe(true);
});

test("loadAgentsFromVault: bare array payload (not wrapped in {notes}) is accepted", async () => {
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
  const out = await loadAgentsFromVault({
    vault: { url: "http://x", token: "t" },
    client,
  });
  expect(out["Agents/flat"]).toContain("name: flat");
});

test("loadAgentsFromVault: when the caller passes client, we do not close it", async () => {
  let closed = false;
  const client = {
    callTool: async () => ({
      content: [{ type: "text", text: JSON.stringify({ notes: [] }) }],
    }),
    close: async () => {
      closed = true;
    },
  } as unknown as RawMcpClient;
  await loadAgentsFromVault({
    vault: { url: "http://x", token: "t" },
    client,
  });
  expect(closed).toBe(false);
});
