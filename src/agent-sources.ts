/**
 * Helpers for loading the `agents` map from different sources. All three
 * return the `{ path → markdown }` shape that `AgentRunner` expects, so they
 * are interchangeable from the runner's perspective.
 *
 * - `loadAgentsFromDir`: filesystem (see `adapters/node.ts`).
 * - `loadAgentsInline`: wrap an already-built map (passthrough).
 * - `loadAgentsFromVault`: query a Parachute Vault for notes tagged as agent
 *   definitions; each note's body is the agent markdown.
 *
 * The vault loader is a one-shot snapshot — no live reload in v1. Re-run it
 * (restart the runner, or reconstruct with a new `agents` map) to pick up
 * changes. A `refreshSeconds` hook is deliberately absent to keep the runner
 * immutable; handle polling in the host if you need it.
 */
import { Vault, type VaultConfig } from "./vault.js";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";

export function loadAgentsInline(agents: Record<string, string>): Record<string, string> {
  return { ...agents };
}

export interface LoadAgentsFromVaultOptions {
  vault: VaultConfig;
  /** Tag to match. Defaults to `"agent-definition"`. */
  tag?: string;
  /** Max notes to fetch. Defaults to 200 — agents are small, this is plenty. */
  limit?: number;
  /** Test hook: inject a pre-built raw MCP client. */
  client?: McpClient;
  /** Diagnostic log callback; called once per load with fetched count or error message. */
  logger?: (msg: string) => void;
}

interface VaultNoteRow {
  path?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Query the vault for agent-definition notes and return them as a
 * `{ path → markdown }` map. Falls back to an empty map (with a logged
 * warning) when the vault is unreachable — the runner should be able to
 * boot with no agents rather than hard-crashing on a transient network
 * blip.
 */
export async function loadAgentsFromVault(
  options: LoadAgentsFromVaultOptions,
): Promise<Record<string, string>> {
  const tag = options.tag ?? "agent-definition";
  const limit = options.limit ?? 200;
  const log = options.logger ?? (() => {});

  let client: McpClient | null = null;
  let owned = false;
  try {
    if (options.client) {
      client = options.client;
    } else {
      client = await new Vault(options.vault).raw();
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
      log(`loadAgentsFromVault: vault returned no content`);
      return {};
    }
    const parsed = JSON.parse(text) as { notes?: unknown[] } | unknown[];
    const rows = Array.isArray(parsed)
      ? (parsed as VaultNoteRow[])
      : ((parsed.notes ?? []) as VaultNoteRow[]);
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (typeof row?.content !== "string" || row.content.length === 0) continue;
      const key = typeof row.path === "string" && row.path.length > 0 ? row.path : `vault/${Object.keys(out).length}`;
      out[key] = row.content;
    }
    log(`loadAgentsFromVault: loaded ${Object.keys(out).length} agent(s)`);
    return out;
  } catch (err) {
    log(
      `loadAgentsFromVault: falling back to empty agent set — ${
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
