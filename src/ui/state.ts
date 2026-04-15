import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { loadAgentsFromDir } from "../adapters/node.js";
import { parseAgent, type AgentDefinition } from "../agents.js";
import { SqliteRunLog } from "../run-log-sqlite.js";
import type { AgentRun } from "../run-log.js";

export interface UiPaths {
  agentsDir: string;
  dbDir: string;
}

export interface AgentCard {
  name: string;
  path: string;
  definition: AgentDefinition | null;
  parseError: string | null;
  raw: string;
  /** Last recorded run (any status). */
  lastRun: AgentRun | null;
  /** Last N runs newest-first, for the card's tail. */
  recentRuns: AgentRun[];
  /** Total runs + failure count in the window we loaded. */
  totalRuns: number;
  failedRuns: number;
}

export interface UiSnapshot {
  generatedAt: number;
  paths: UiPaths;
  agents: AgentCard[];
  /** Orphaned runs: agents whose definitions aren't on disk anymore. */
  orphanedRunAgents: string[];
}

export interface ConversationSummary {
  conversationId: string;
  turns: number;
  lastTs: number;
}

export interface ConversationTurn {
  ts: number;
  role: string;
  content: string;
}

/** Open the run log if the db file exists; caller is responsible for close(). */
export function openRunLog(paths: UiPaths): SqliteRunLog | null {
  const path = resolve(paths.dbDir, "runs.db");
  if (!existsSync(path)) return null;
  return new SqliteRunLog(path);
}

function openConvoDb(paths: UiPaths): Database | null {
  const path = resolve(paths.dbDir, "conversations.db");
  if (!existsSync(path)) return null;
  return new Database(path, { readonly: true });
}

async function loadAgents(paths: UiPaths): Promise<Array<{
  path: string;
  raw: string;
  definition: AgentDefinition | null;
  parseError: string | null;
}>> {
  const dir = resolve(paths.agentsDir);
  if (!existsSync(dir)) return [];
  const files = await loadAgentsFromDir(dir);
  return Object.entries(files).map(([path, raw]) => {
    try {
      return { path, raw, definition: parseAgent(raw), parseError: null };
    } catch (e) {
      return { path, raw, definition: null, parseError: (e as Error).message };
    }
  });
}

export async function buildSnapshot(paths: UiPaths): Promise<UiSnapshot> {
  const loaded = await loadAgents(paths);
  const log = openRunLog(paths);
  const cards: AgentCard[] = [];
  const seenAgentNames = new Set<string>();

  try {
    for (const entry of loaded) {
      const name = entry.definition?.frontmatter.name ?? `(${entry.path})`;
      if (entry.definition) seenAgentNames.add(entry.definition.frontmatter.name);
      const recent = entry.definition && log
        ? await log.list({ agent: entry.definition.frontmatter.name, limit: 20 })
        : [];
      const failedRuns = recent.filter((r) => r.error !== null).length;
      cards.push({
        name,
        path: entry.path,
        definition: entry.definition,
        parseError: entry.parseError,
        raw: entry.raw,
        lastRun: recent[0] ?? null,
        recentRuns: recent.slice(0, 5),
        totalRuns: recent.length,
        failedRuns,
      });
    }

    let orphanedRunAgents: string[] = [];
    if (log) {
      const latest = await log.list({ limit: 200 });
      const orphans = new Set<string>();
      for (const r of latest) {
        if (!seenAgentNames.has(r.agentName)) orphans.add(r.agentName);
      }
      orphanedRunAgents = [...orphans].sort();
    }

    cards.sort((a, b) => {
      const at = a.lastRun?.startedAt ?? 0;
      const bt = b.lastRun?.startedAt ?? 0;
      if (at !== bt) return bt - at;
      return a.name.localeCompare(b.name);
    });

    return {
      generatedAt: Date.now(),
      paths,
      agents: cards,
      orphanedRunAgents,
    };
  } finally {
    log?.close();
  }
}

export async function listRunsForAgent(
  paths: UiPaths,
  agent: string,
  limit = 100,
): Promise<AgentRun[]> {
  const log = openRunLog(paths);
  if (!log) return [];
  try {
    return await log.list({ agent, limit });
  } finally {
    log.close();
  }
}

export async function getRun(paths: UiPaths, id: string): Promise<AgentRun | null> {
  const log = openRunLog(paths);
  if (!log) return null;
  try {
    const direct = await log.get(id);
    if (direct) return direct;
    const all = await log.list({ limit: 1000 });
    return all.find((r) => r.id.startsWith(id)) ?? null;
  } finally {
    log.close();
  }
}

export async function latestRunStartedAt(paths: UiPaths): Promise<number> {
  const log = openRunLog(paths);
  if (!log) return 0;
  try {
    const [first] = await log.list({ limit: 1 });
    return first?.startedAt ?? 0;
  } finally {
    log.close();
  }
}

export function listConversations(paths: UiPaths, limit = 100): ConversationSummary[] {
  const db = openConvoDb(paths);
  if (!db) return [];
  try {
    const rows = db
      .query<
        { conversation_id: string; turns: number; last_ts: number },
        [number]
      >(
        `SELECT conversation_id, COUNT(*) AS turns, MAX(ts) AS last_ts
         FROM turns GROUP BY conversation_id ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      turns: r.turns,
      lastTs: r.last_ts,
    }));
  } finally {
    db.close();
  }
}

export function getConversation(paths: UiPaths, id: string): ConversationTurn[] {
  const db = openConvoDb(paths);
  if (!db) return [];
  try {
    return db
      .query<{ ts: number; role: string; content: string }, [string]>(
        "SELECT ts, role, content FROM turns WHERE conversation_id = ? ORDER BY ts ASC, rowid ASC",
      )
      .all(id);
  } finally {
    db.close();
  }
}

export function findAgent(snap: UiSnapshot, name: string): AgentCard | null {
  return snap.agents.find((a) => a.name === name) ?? null;
}
