#!/usr/bin/env bun
/** @jsxImportSource hono/jsx */
/**
 * `parachute-agent-ui` — local management dashboard for @openparachute/agent.
 *
 * Read-only inspector for the same files and sqlite stores the CLI reads.
 * Does not spawn a runner, does not send traffic to one — agents and run
 * logs are the source of truth. See README "Web UI" for usage.
 */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSnapshot,
  findAgent,
  getConversation,
  getRun,
  latestRunStartedAt,
  listConversations,
  listRunsForAgent,
  type UiPaths,
  type UiSnapshot,
} from "./state.js";
import {
  AgentDetailPage,
  ConversationDetailPage,
  ConversationsPage,
  DashboardPage,
  NotFoundPage,
  RunDetailPage,
} from "./render.js";

export interface UiServerOptions {
  paths: UiPaths;
  /** SSE polling cadence. Defaults to 2000ms. */
  pollMs?: number;
}

function htmlDoc(body: string): string {
  return `<!doctype html>${body}`;
}

export function buildUiApp(options: UiServerOptions): Hono {
  const app = new Hono();
  const pollMs = options.pollMs ?? 2000;

  // Static assets live next to the compiled server.js. `serveStatic` from
  // `hono/bun` expects `root` to be relative to process.cwd(), so convert.
  const here = dirname(fileURLToPath(import.meta.url));
  const publicRoot = relative(process.cwd(), resolve(here, "public")) || ".";
  app.use(
    "/assets/*",
    serveStatic({
      root: publicRoot,
      rewriteRequestPath: (p) => p.replace(/^\/assets/, ""),
    }),
  );

  app.get("/", async (c) => {
    const snap = await buildSnapshot(options.paths);
    return c.html(htmlDoc((<DashboardPage snap={snap} />).toString()));
  });

  app.get("/agents/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const snap = await buildSnapshot(options.paths);
    const card = findAgent(snap, name);
    if (!card) {
      return c.html(
        htmlDoc(
          (<NotFoundPage message={`No agent named "${name}".`} snap={snap} />).toString(),
        ),
        404,
      );
    }
    const runs = await listRunsForAgent(options.paths, name, 100);
    return c.html(htmlDoc((<AgentDetailPage snap={snap} card={card} runs={runs} />).toString()));
  });

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await getRun(options.paths, id);
    const snap = await buildSnapshot(options.paths);
    if (!run) {
      return c.html(
        htmlDoc(
          (<NotFoundPage message={`No run matching "${id}".`} snap={snap} />).toString(),
        ),
        404,
      );
    }
    return c.html(htmlDoc((<RunDetailPage snap={snap} run={run} />).toString()));
  });

  app.get("/conversations", async (c) => {
    const snap = await buildSnapshot(options.paths);
    const rows = listConversations(options.paths, 200);
    return c.html(htmlDoc((<ConversationsPage snap={snap} rows={rows} />).toString()));
  });

  app.get("/conversations/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const turns = getConversation(options.paths, id);
    const snap = await buildSnapshot(options.paths);
    return c.html(
      htmlDoc(
        (<ConversationDetailPage snap={snap} conversationId={id} turns={turns} />).toString(),
      ),
    );
  });

  // JSON snapshot used by the SSE client to re-render cards in place.
  app.get("/api/snapshot", async (c) => {
    const snap = await buildSnapshot(options.paths);
    return c.json(snapshotJson(snap));
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      let lastStart = -1;
      c.req.raw.signal.addEventListener("abort", () => {
        alive = false;
      });
      // Ping on connect so the client can sync immediately even if nothing has run.
      while (alive) {
        const t = await latestRunStartedAt(options.paths);
        if (t !== lastStart) {
          lastStart = t;
          const snap = await buildSnapshot(options.paths);
          await stream.writeSSE({
            event: "snapshot",
            data: JSON.stringify(snapshotJson(snap)),
          });
        } else {
          await stream.writeSSE({ event: "heartbeat", data: String(Date.now()) });
        }
        await stream.sleep(pollMs);
      }
    }),
  );

  app.notFound((c) =>
    c.html(
      htmlDoc(
        (
          <NotFoundPage
            message={`No route for ${c.req.path}.`}
            snap={null}
          />
        ).toString(),
      ),
      404,
    ),
  );

  return app;
}

/** Shape we send over SSE — small, JSON-safe, no Dates or circular refs. */
export function snapshotJson(snap: UiSnapshot): unknown {
  return {
    generatedAt: snap.generatedAt,
    paths: snap.paths,
    orphanedRunAgents: snap.orphanedRunAgents,
    agents: snap.agents.map((c) => ({
      name: c.name,
      path: c.path,
      parseError: c.parseError,
      trigger: c.definition
        ? triggerJson(c.definition.frontmatter.trigger)
        : null,
      model: c.definition?.frontmatter.model ?? null,
      lastRun: c.lastRun
        ? {
            id: c.lastRun.id,
            startedAt: c.lastRun.startedAt,
            durationMs: c.lastRun.durationMs,
            trigger: c.lastRun.trigger,
            error: c.lastRun.error,
          }
        : null,
      failedRuns: c.failedRuns,
    })),
  };
}

function triggerJson(t: { type: string } & Record<string, unknown>): unknown {
  return t;
}

function parseArgs(argv: string[]): {
  paths: UiPaths;
  port: number;
  host: string;
  pollMs: number;
  help: boolean;
} {
  const paths: UiPaths = {
    agentsDir: "./agents",
    dbDir: "./.agents",
  };
  let port = Number(process.env.PARACHUTE_AGENT_UI_PORT ?? 6062);
  let host = process.env.PARACHUTE_AGENT_UI_HOST ?? "127.0.0.1";
  let pollMs = Number(process.env.PARACHUTE_AGENT_UI_POLL_MS ?? 2000);
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--agents-dir") paths.agentsDir = argv[++i] ?? paths.agentsDir;
    else if (a === "--db-dir") paths.dbDir = argv[++i] ?? paths.dbDir;
    else if (a === "--port") port = Number(argv[++i]);
    else if (a === "--host") host = argv[++i] ?? host;
    else if (a === "--poll-ms") pollMs = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { paths, port, host, pollMs, help };
}

const HELP = `parachute-agent-ui — local web dashboard for @openparachute/agent

Usage:
  parachute-agent-ui [flags]

Flags:
  --agents-dir <path>     agents markdown dir (default ./agents)
  --db-dir <path>         sqlite db directory (default ./.agents)
  --port <n>              listen port (default 6062, env PARACHUTE_AGENT_UI_PORT)
  --host <addr>           bind host (default 127.0.0.1, env PARACHUTE_AGENT_UI_HOST)
                          pass 0.0.0.0 to expose over Tailscale / LAN
  --poll-ms <n>           SSE polling cadence (default 2000)
  --help, -h              Show this help
`;

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const app = buildUiApp({ paths: args.paths, pollMs: args.pollMs });
  const BunGlobal = (globalThis as { Bun?: { serve: (o: unknown) => { port: number; hostname: string } } }).Bun;
  if (!BunGlobal) {
    process.stderr.write("parachute-agent-ui requires Bun runtime.\n");
    return 1;
  }
  const server = BunGlobal.serve({
    fetch: app.fetch,
    port: args.port,
    hostname: args.host,
    idleTimeout: 0,
  });
  process.stdout.write(
    `parachute-agent-ui listening on http://${server.hostname}:${server.port}\n` +
      `  agents: ${resolve(args.paths.agentsDir)}\n` +
      `  dbs:    ${resolve(args.paths.dbDir)}\n`,
  );
  return new Promise<number>(() => {
    // Block forever. SIGINT / SIGTERM default handlers exit the process.
  });
}

const importMeta = import.meta as ImportMeta & { main?: boolean };
if (importMeta.main) {
  const code = await main(process.argv.slice(2));
  if (code !== undefined) process.exit(code);
}
