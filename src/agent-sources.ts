/**
 * Unified `loadAgents({source})` entry point. Picks an `AgentSource` variant
 * and returns the `{path → markdown}` map `AgentRunner` consumes.
 *
 * Follows the **Parachute tagged-union loader** convention — every module in
 * the ecosystem (scribe, narrate, daily, …) exposes a single `load*` with the
 * same tagged-union shape, so hosts can swap storage backends without
 * touching the runner.
 *
 * Variants:
 * - `inline`: hand-built `{path → markdown}` map (tests, small deployments).
 * - `dir`: filesystem — recursively loads `*.md` under a directory. Uses
 *   `node:fs/promises` via dynamic import, so base imports stay CF-safe:
 *   CF hosts that avoid this variant never pay the import cost.
 * - `vault`: Parachute Vault — each note tagged `agent-definition` (override
 *   with `tag:`) becomes one agent. Errors log + return `{}` so a transient
 *   vault blip doesn't crash boot.
 *
 * The vault loader is a one-shot snapshot — re-call `loadAgents({...})` to
 * pick up changes. Live-reload is deliberately out of scope to keep the
 * runner immutable after construction.
 */
import { Vault, type VaultConfig } from "./vault.js";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";

export type AgentSource =
  | { type: "inline"; agents: Record<string, string> }
  | { type: "dir"; path: string }
  | {
      type: "vault";
      vault: VaultConfig;
      /** Tag to match. Defaults to `"agent-definition"`. */
      tag?: string;
      /** Max notes to fetch. Defaults to 200. */
      limit?: number;
      /** Test hook: inject a pre-built raw MCP client. */
      client?: McpClient;
      /** Diagnostic log callback. */
      logger?: (msg: string) => void;
    };

/**
 * Load agent markdown from the chosen source. See {@link AgentSource} for
 * the variants.
 */
export async function loadAgents(source: AgentSource): Promise<Record<string, string>> {
  switch (source.type) {
    case "inline":
      return { ...source.agents };
    case "dir":
      return loadAgentsFromDirImpl(source.path);
    case "vault":
      return loadAgentsFromVaultImpl(source);
  }
}

async function loadAgentsFromDirImpl(dir: string): Promise<Record<string, string>> {
  // Dynamic import so the base entry stays CF-safe: hosts that never use
  // `type: "dir"` never trigger the `node:fs/promises` resolution.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const out: Record<string, string> = {};
  const walk = async (current: string, prefix: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile() && path.extname(entry.name) === ".md") {
        out[rel] = await fs.readFile(abs, "utf8");
      }
    }
  };
  await walk(dir, "");
  return out;
}

interface VaultNoteRow {
  path?: string;
  content?: string;
  [key: string]: unknown;
}

type VaultSource = Extract<AgentSource, { type: "vault" }>;

async function loadAgentsFromVaultImpl(source: VaultSource): Promise<Record<string, string>> {
  const tag = source.tag ?? "agent-definition";
  const limit = source.limit ?? 200;
  const log = source.logger ?? (() => {});

  let client: McpClient | null = null;
  let owned = false;
  try {
    if (source.client) {
      client = source.client;
    } else {
      client = await new Vault(source.vault).raw();
      owned = true;
    }
    const res = (await client.callTool({
      name: "query-notes",
      arguments: {
        tag: [tag],
        tag_match: "all",
        sort: "desc",
        include_metadata: true,
        include_content: true,
        limit,
      },
    })) as { content?: Array<{ type?: string; text?: string }> };
    const text = res.content?.[0]?.text;
    if (!text) {
      log(`loadAgents(vault): vault returned no content`);
      return {};
    }
    const parsed = JSON.parse(text) as { notes?: unknown[] } | unknown[];
    const rows = Array.isArray(parsed)
      ? (parsed as VaultNoteRow[])
      : ((parsed.notes ?? []) as VaultNoteRow[]);
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (typeof row?.content !== "string" || row.content.length === 0) continue;
      const key =
        typeof row.path === "string" && row.path.length > 0
          ? row.path
          : `vault/${Object.keys(out).length}`;
      out[key] = row.content;
    }
    log(`loadAgents(vault): loaded ${Object.keys(out).length} agent(s)`);
    return out;
  } catch (err) {
    log(
      `loadAgents(vault): falling back to empty agent set — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  } finally {
    if (owned && client) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// ---- Back-compat shims -----------------------------------------------------
// Thin deprecated wrappers over `loadAgents({...})`. Will be removed in a
// future major — prefer the unified loader.

/** @deprecated Use `loadAgents({type: "inline", agents})`. */
export function loadAgentsInline(agents: Record<string, string>): Record<string, string> {
  return { ...agents };
}

export interface LoadAgentsFromVaultOptions {
  vault: VaultConfig;
  tag?: string;
  limit?: number;
  client?: McpClient;
  logger?: (msg: string) => void;
}

/** @deprecated Use `loadAgents({type: "vault", ...})`. */
export function loadAgentsFromVault(
  options: LoadAgentsFromVaultOptions,
): Promise<Record<string, string>> {
  return loadAgents({ type: "vault", ...options });
}
