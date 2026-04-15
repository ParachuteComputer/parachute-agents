#!/usr/bin/env bun
/**
 * `parachute-agent` — local inspector for a self-hosted agents deployment.
 *
 * Read-only view of what the runner has written to disk: loaded agent files,
 * the sqlite run log (`.agents/runs.db`), and the sqlite conversation store
 * (`.agents/conversations.db`). Does not spawn a runner, does not hit the
 * network. Point at a different dir with `--db-dir` / `--agents-dir`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { loadAgentsFromDir } from "./adapters/node.js";
import { parseAgent, type ToolEntry } from "./agents.js";
import { SqliteRunLog } from "./run-log-sqlite.js";
import type { AgentRun } from "./run-log.js";

interface Flags {
  dbDir: string;
  agentsDir: string;
  limit?: number;
  agent?: string;
  since?: number;
  yes: boolean;
  help: boolean;
}

const HELP = `parachute-agent — local inspector for @openparachute/agent

Usage:
  parachute-agent <command> [subcommand] [args] [flags]

Commands:
  agents list                     List agents under ./agents (name, trigger, model)
  agents show <name>              Print frontmatter + body for one agent
  runs list [--agent N] [--limit N] [--since <iso>]
                                  List recorded runs, newest first
  runs show <id>                  Full detail for one run
  convo list [--limit N]          List conversation IDs with turn counts
  convo show <conversation_id>    Print full thread
  convo clear <conversation_id> --yes
                                  Delete all turns for one conversation

Flags:
  --db-dir <path>       sqlite db directory (default ./.agents)
  --agents-dir <path>   agents markdown dir (default ./agents)
  --help, -h            Show this help

Examples:
  parachute-agent agents list
  parachute-agent runs list --agent daily-digest --limit 10
  parachute-agent runs list --since 2026-04-15T00:00:00Z
`;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {
    dbDir: "./.agents",
    agentsDir: "./agents",
    yes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--db-dir") flags.dbDir = argv[++i] ?? flags.dbDir;
    else if (a === "--agents-dir") flags.agentsDir = argv[++i] ?? flags.agentsDir;
    else if (a === "--agent") flags.agent = argv[++i];
    else if (a === "--limit") flags.limit = Number(argv[++i]);
    else if (a === "--since") {
      const v = argv[++i]!;
      const n = Date.parse(v);
      if (Number.isNaN(n)) throw new Error(`--since expects an ISO date, got ${v}`);
      flags.since = n;
    } else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  return { positional, flags };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? "").length)),
  );
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : (cell ?? "").padEnd(widths[i]!)))
        .join("  "),
    )
    .join("\n");
}

function triggerSummary(fm: { trigger: { type: string; [k: string]: unknown } }): string {
  const t = fm.trigger;
  if (t.type === "webhook") return `webhook ${t.source as string}/${t.match as string}`;
  if (t.type === "cron") return `cron ${t.schedule as string}`;
  if (t.type === "vault") {
    const filter = (t.filter as { tags?: string[]; not_tags?: string[] } | undefined) ?? {};
    const parts = [`vault:${t.on_event as string}`];
    if (filter.tags?.length) parts.push(`tags=[${filter.tags.join(",")}]`);
    if (filter.not_tags?.length) parts.push(`not=[${filter.not_tags.join(",")}]`);
    parts.push(`poll=${t.poll_seconds as number}s`);
    return parts.join(" ");
  }
  return t.type;
}

function toolsSummary(tools: ToolEntry[]): string {
  if (tools.length === 0) return "-";
  return tools
    .map((t) => (typeof t === "string" ? t : `mcp:${t.mcp.name}(${t.mcp.auth.type})`))
    .join(", ");
}

async function cmdAgentsList(flags: Flags): Promise<void> {
  const dir = resolve(flags.agentsDir);
  if (!existsSync(dir)) {
    err(`No agents dir at ${dir}. Pass --agents-dir.`);
    process.exit(1);
  }
  const files = await loadAgentsFromDir(dir);
  const rows: string[][] = [["NAME", "TRIGGER", "MODEL", "TOOLS"]];
  for (const [path, src] of Object.entries(files)) {
    try {
      const a = parseAgent(src);
      rows.push([
        a.frontmatter.name,
        triggerSummary(a.frontmatter),
        a.frontmatter.model,
        toolsSummary(a.frontmatter.tools),
      ]);
    } catch (e) {
      rows.push([`(invalid: ${path})`, String((e as Error).message).slice(0, 40), "-", "-"]);
    }
  }
  if (rows.length === 1) {
    console.log(`No agents found under ${dir}.`);
    return;
  }
  console.log(table(rows));
}

async function cmdAgentsShow(name: string, flags: Flags): Promise<void> {
  const dir = resolve(flags.agentsDir);
  const files = await loadAgentsFromDir(dir);
  for (const [path, src] of Object.entries(files)) {
    try {
      const a = parseAgent(src);
      if (a.frontmatter.name === name) {
        console.log(src.trimEnd());
        return;
      }
    } catch {
      /* skip invalid */
    }
  }
  err(`No agent named "${name}" found under ${dir}.`);
  process.exit(1);
}

function openRunLog(flags: Flags): SqliteRunLog {
  const path = resolve(flags.dbDir, "runs.db");
  if (!existsSync(path)) {
    err(`No run log at ${path}. Run the server first, or pass --db-dir.`);
    process.exit(1);
  }
  return new SqliteRunLog(path);
}

async function cmdRunsList(flags: Flags): Promise<void> {
  const log = openRunLog(flags);
  try {
    const rows = await log.list({
      agent: flags.agent,
      limit: flags.limit ?? 50,
      since: flags.since,
    });
    if (rows.length === 0) {
      console.log("No runs found.");
      return;
    }
    const out: string[][] = [
      ["ID", "AGENT", "STARTED", "DUR", "TRIG", "ERROR"],
      ...rows.map((r) => [
        r.id.slice(0, 8),
        r.agentName,
        fmtDate(r.startedAt),
        `${r.durationMs}ms`,
        r.trigger,
        r.error ?? "",
      ]),
    ];
    console.log(table(out));
  } finally {
    log.close();
  }
}

async function cmdRunsShow(id: string, flags: Flags): Promise<void> {
  const log = openRunLog(flags);
  try {
    const run = (await log.get(id)) ?? (await findByPrefix(log, id));
    if (!run) {
      err(`No run with id "${id}".`);
      process.exit(1);
    }
    printRun(run);
  } finally {
    log.close();
  }
}

async function findByPrefix(log: SqliteRunLog, prefix: string): Promise<AgentRun | null> {
  const all = await log.list({ limit: 1000 });
  return all.find((r) => r.id.startsWith(prefix)) ?? null;
}

function printRun(r: AgentRun): void {
  console.log(`id:         ${r.id}`);
  console.log(`agent:      ${r.agentName}`);
  console.log(`trigger:    ${r.trigger}`);
  console.log(`started:    ${fmtDate(r.startedAt)}`);
  console.log(`ended:      ${fmtDate(r.endedAt)}`);
  console.log(`duration:   ${r.durationMs}ms`);
  console.log(`toolCalls:  ${r.toolCalls}`);
  if (r.error) console.log(`error:      ${r.error}`);
  console.log(`\ninput:`);
  console.log(JSON.stringify(r.input, null, 2));
  console.log(`\noutput:`);
  console.log(r.output ?? "(null)");
}

function openConvoDb(flags: Flags): Database {
  const path = resolve(flags.dbDir, "conversations.db");
  if (!existsSync(path)) {
    err(`No conversation db at ${path}. Run the server first, or pass --db-dir.`);
    process.exit(1);
  }
  return new Database(path);
}

async function cmdConvoList(flags: Flags): Promise<void> {
  const db = openConvoDb(flags);
  try {
    const rows = db
      .query<
        { conversation_id: string; turns: number; last_ts: number },
        [number]
      >(
        `SELECT conversation_id, COUNT(*) AS turns, MAX(ts) AS last_ts
         FROM turns GROUP BY conversation_id ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(flags.limit ?? 50);
    if (rows.length === 0) {
      console.log("No conversations found.");
      return;
    }
    const out: string[][] = [
      ["CONVERSATION_ID", "TURNS", "LAST_TS"],
      ...rows.map((r) => [r.conversation_id, String(r.turns), fmtDate(r.last_ts)]),
    ];
    console.log(table(out));
  } finally {
    db.close();
  }
}

async function cmdConvoShow(id: string, flags: Flags): Promise<void> {
  const db = openConvoDb(flags);
  try {
    const rows = db
      .query<{ ts: number; role: string; content: string }, [string]>(
        "SELECT ts, role, content FROM turns WHERE conversation_id = ? ORDER BY ts ASC, rowid ASC",
      )
      .all(id);
    if (rows.length === 0) {
      console.log(`No turns for "${id}".`);
      return;
    }
    for (const r of rows) {
      console.log(`[${fmtDate(r.ts)}] ${r.role}:`);
      console.log(r.content);
      console.log("");
    }
  } finally {
    db.close();
  }
}

async function cmdConvoClear(id: string, flags: Flags): Promise<void> {
  if (!flags.yes) {
    err(`Refusing to clear "${id}" without --yes.`);
    process.exit(2);
  }
  const db = openConvoDb(flags);
  try {
    const res = db.query("DELETE FROM turns WHERE conversation_id = ?").run(id);
    console.log(`Deleted ${res.changes} turn(s) from "${id}".`);
  } finally {
    db.close();
  }
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export async function main(argv: string[]): Promise<number> {
  let parsed: { positional: string[]; flags: Flags };
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const { positional, flags } = parsed;

  if (flags.help || positional.length === 0) {
    console.log(HELP);
    return 0;
  }

  const [cmd, sub, arg] = positional;
  try {
    if (cmd === "agents" && sub === "list") await cmdAgentsList(flags);
    else if (cmd === "agents" && sub === "show" && arg) await cmdAgentsShow(arg, flags);
    else if (cmd === "runs" && sub === "list") await cmdRunsList(flags);
    else if (cmd === "runs" && sub === "show" && arg) await cmdRunsShow(arg, flags);
    else if (cmd === "convo" && sub === "list") await cmdConvoList(flags);
    else if (cmd === "convo" && sub === "show" && arg) await cmdConvoShow(arg, flags);
    else if (cmd === "convo" && sub === "clear" && arg) await cmdConvoClear(arg, flags);
    else {
      err(`Unknown or incomplete command: ${positional.join(" ")}`);
      err(`Run 'parachute-agent --help' for usage.`);
      return 2;
    }
    return 0;
  } catch (e) {
    err(`Error: ${(e as Error).message}`);
    return 1;
  }
}

// `import.meta.main` is true when run directly via `bun src/cli.ts` or the
// compiled `dist/cli.js` shebang — skipped when the module is imported by tests.
const importMeta = import.meta as ImportMeta & { main?: boolean };
if (importMeta.main) {
  const code = await main(process.argv.slice(2));
  // Ensure we don't hang on open Database handles (defensive; each command closes its own).
  process.exit(code);
}
