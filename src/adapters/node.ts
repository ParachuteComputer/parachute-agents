import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { AgentRunner, type ParachuteAgentConfig } from "../runner.js";
import { handleWebhook, handleConnectorWebhook } from "../triggers/webhook.js";
import type { Connector } from "../connectors/types.js";

/**
 * Recursively load every `*.md` file under `dir` into the `{path: source}` map that
 * `AgentRunner` expects. Paths are relative to `dir` so loader error messages stay tidy.
 */
export async function loadAgentsFromDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string, prefix: string) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile() && extname(entry.name) === ".md") {
        out[rel] = await readFile(abs, "utf8");
      }
    }
  };
  await walk(dir, "");
  return out;
}

export interface ServeOptions {
  port?: number;
  hostname?: string;
  /** Mount-point for the generic `{text, source, meta}` webhook. Default `/webhook`. */
  webhookPath?: string;
  /**
   * Platform-specific connector mounts. Each entry adds a POST endpoint that pipes
   * through {@link handleConnectorWebhook}.
   */
  connectors?: Array<{
    path: string;
    connector: Connector<unknown>;
    config: unknown;
    autoReply?: boolean;
  }>;
}

/**
 * Build a Fetch-standard handler from a runner + serve options. Used internally by
 * {@link serveBun}, but also exported so hosts with their own HTTP stack (Hono,
 * itty-router, raw Node http) can mount it.
 */
export function buildHandler(runner: AgentRunner, opts: ServeOptions = {}) {
  const webhookPath = opts.webhookPath ?? "/webhook";
  const connectors = opts.connectors ?? [];

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("not found", { status: 404 });

    if (url.pathname === webhookPath) {
      return handleWebhook(runner, request);
    }
    for (const c of connectors) {
      if (url.pathname === c.path) {
        return handleConnectorWebhook(runner, request, {
          connector: c.connector,
          config: c.config,
          autoReply: c.autoReply,
        });
      }
    }
    return new Response("not found", { status: 404 });
  };
}

/**
 * Start a Bun HTTP server. Assumes `Bun.serve` is available — no-op fallback for Node
 * is deliberately omitted, use {@link buildHandler} with your own HTTP layer instead.
 */
export function serveBun(
  runner: AgentRunner,
  opts: ServeOptions = {},
): { stop: () => void; port: number; hostname: string } {
  const BunGlobal = (globalThis as { Bun?: { serve: (o: unknown) => unknown } }).Bun;
  if (!BunGlobal) {
    throw new Error("serveBun(): Bun runtime not detected. Use buildHandler() with a Node HTTP server instead.");
  }

  const handler = buildHandler(runner, opts);
  const server = BunGlobal.serve({
    port: opts.port ?? 3000,
    hostname: opts.hostname ?? "0.0.0.0",
    fetch: handler,
  }) as { stop: () => void; port: number; hostname: string };

  return server;
}

/**
 * Convenience: load agents from a directory, construct the runner, serve under Bun.
 * One call for the typical self-hosted setup.
 */
export async function startSelfHosted(args: {
  agentsDir: string;
  config: Omit<ParachuteAgentConfig, "agents">;
  serve?: ServeOptions;
}): Promise<{ runner: AgentRunner; server: { stop: () => void; port: number; hostname: string } }> {
  const agents = await loadAgentsFromDir(args.agentsDir);
  const runner = new AgentRunner({ ...args.config, agents });
  const server = serveBun(runner, args.serve);
  return { runner, server };
}
