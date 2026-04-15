/** @jsxImportSource hono/jsx */
import type {
  AgentCard,
  ConversationSummary,
  ConversationTurn,
  UiSnapshot,
} from "./state.js";
import type { AgentRun } from "../run-log.js";
import type { AgentDefinition, ToolEntry } from "../agents.js";
import { fmtAge, fmtDate, fmtDuration, shortId } from "./format.js";

function triggerSummary(def: AgentDefinition): string {
  const t = def.frontmatter.trigger;
  if (t.type === "webhook") return `webhook ${t.source}/${t.match}`;
  if (t.type === "cron") return `cron ${t.schedule}`;
  if (t.type === "vault") {
    const parts = [`vault:${t.on_event}`];
    const f = t.filter;
    if (f?.tags?.length) parts.push(`tags=[${f.tags.join(",")}]`);
    if (f?.not_tags?.length) parts.push(`not=[${f.not_tags.join(",")}]`);
    parts.push(`poll=${t.poll_seconds}s`);
    return parts.join(" ");
  }
  return (t as { type: string }).type;
}

function toolsSummary(tools: ToolEntry[]): string {
  if (tools.length === 0) return "-";
  return tools
    .map((t) => (typeof t === "string" ? t : `mcp:${t.mcp.name}(${t.mcp.auth.type})`))
    .join(", ");
}

function tentacleColor(name: string): string {
  // Hash name → hue. Stable, cheap, keeps card accents recognizable.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 70% 60%)`;
}

function statusDot(run: AgentRun | null) {
  if (!run) return <span class="status-dot status-idle" title="no runs" />;
  if (run.error) return <span class="status-dot status-err" title={run.error} />;
  return <span class="status-dot status-ok" title="last run ok" />;
}

function Layout(props: {
  title: string;
  snap: UiSnapshot | null;
  children: unknown;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} — parachute-agent</title>
        <link rel="stylesheet" href="/assets/styles.css" />
        <link
          rel="preconnect"
          href="https://rsms.me/"
        />
        <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
      </head>
      <body>
        <header class="topbar">
          <div class="topbar-inner">
            <a href="/" class="brand">
              <span class="brand-mark">◆</span>
              <span>parachute-agent</span>
            </a>
            <nav class="topnav">
              <a href="/">agents</a>
              <a href="/conversations">conversations</a>
              <input
                id="search"
                type="search"
                placeholder="filter  ( / )"
                autocomplete="off"
              />
            </nav>
            <div class="topbar-meta">
              {props.snap ? (
                <span class="meta-text" data-updated={String(props.snap.generatedAt)}>
                  updated {fmtAge(props.snap.generatedAt)}
                </span>
              ) : null}
            </div>
          </div>
        </header>
        <main class="main">{props.children}</main>
        <script src="/assets/app.js" type="module"></script>
      </body>
    </html>
  );
}

function AgentCardView(props: { card: AgentCard }) {
  const { card } = props;
  const color = tentacleColor(card.name);
  const def = card.definition;
  const triggerText = def ? triggerSummary(def) : "invalid";
  const model = def?.frontmatter.model ?? "-";
  const tools = def ? toolsSummary(def.frontmatter.tools) : "-";
  const last = card.lastRun;

  return (
    <article
      class="card"
      style={`--tentacle: ${color}`}
      data-name={card.name}
      data-path={card.path}
      data-trigger={triggerText}
      data-model={model}
    >
      <div class="card-head">
        <h3 class="card-title">
          {statusDot(last)}
          {def ? (
            <a href={`/agents/${encodeURIComponent(card.name)}`}>{card.name}</a>
          ) : (
            <span class="muted">{card.path}</span>
          )}
        </h3>
        <div class="card-meta">
          {card.parseError ? (
            <span class="pill pill-err">parse error</span>
          ) : (
            <span class="pill">{def!.frontmatter.trigger.type}</span>
          )}
          {card.failedRuns > 0 ? (
            <span class="pill pill-err" title={`${card.failedRuns} failures in recent window`}>
              {card.failedRuns} failed
            </span>
          ) : null}
        </div>
      </div>
      <dl class="card-facts">
        <dt>trigger</dt>
        <dd>{triggerText}</dd>
        <dt>model</dt>
        <dd>{model}</dd>
        <dt>tools</dt>
        <dd>{tools}</dd>
        <dt>last run</dt>
        <dd>
          {last ? (
            <a href={`/runs/${last.id}`} title={fmtDate(last.startedAt)}>
              {fmtAge(last.startedAt)} · {fmtDuration(last.durationMs)}
            </a>
          ) : (
            <span class="muted">never</span>
          )}
        </dd>
      </dl>
      {card.parseError ? (
        <pre class="tail err">{card.parseError}</pre>
      ) : card.recentRuns.length > 0 ? (
        <ul class="tail runs">
          {card.recentRuns.map((r) => (
            <li>
              <a href={`/runs/${r.id}`}>
                <span class={r.error ? "run-err" : "run-ok"}>{shortId(r.id)}</span>
                <span class="muted">{r.trigger}</span>
                <span class="muted">{fmtAge(r.startedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function DashboardPage(props: { snap: UiSnapshot }) {
  const { snap } = props;
  const cards = snap.agents;
  return (
    <Layout title="dashboard" snap={snap}>
      <section class="summary">
        <span>
          <strong>{cards.length}</strong> agents
        </span>
        <span>
          <strong>{cards.filter((c) => c.parseError).length}</strong> invalid
        </span>
        <span>
          <strong>{cards.reduce((n, c) => n + c.failedRuns, 0)}</strong> recent failures
        </span>
        {snap.orphanedRunAgents.length > 0 ? (
          <span class="warn" title={snap.orphanedRunAgents.join(", ")}>
            <strong>{snap.orphanedRunAgents.length}</strong> orphaned run-only agents
          </span>
        ) : null}
      </section>
      {cards.length === 0 ? (
        <p class="empty">
          No agents found under <code>{snap.paths.agentsDir}</code>.
        </p>
      ) : (
        <section class="cards" id="cards">
          {cards.map((c) => (
            <AgentCardView card={c} />
          ))}
        </section>
      )}
    </Layout>
  );
}

export function AgentDetailPage(props: { snap: UiSnapshot; card: AgentCard; runs: AgentRun[] }) {
  const { card, runs, snap } = props;
  const def = card.definition;
  return (
    <Layout title={card.name} snap={snap}>
      <a href="/" class="back">← agents</a>
      <h1 class="page-title">{card.name}</h1>
      {def ? (
        <dl class="facts">
          <dt>trigger</dt>
          <dd>
            <code>{triggerSummary(def)}</code>
          </dd>
          <dt>model</dt>
          <dd>
            <code>{def.frontmatter.model}</code>
          </dd>
          <dt>tools</dt>
          <dd>
            <code>{toolsSummary(def.frontmatter.tools)}</code>
          </dd>
          <dt>path</dt>
          <dd>
            <code>{card.path}</code>
          </dd>
          {def.frontmatter.description ? (
            <>
              <dt>description</dt>
              <dd>{def.frontmatter.description}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <pre class="tail err">{card.parseError}</pre>
      )}

      <h2>system prompt</h2>
      <pre class="source">{def?.systemPrompt ?? card.raw}</pre>

      <h2>recent runs</h2>
      {runs.length === 0 ? (
        <p class="empty">No runs recorded.</p>
      ) : (
        <table class="runs-table">
          <thead>
            <tr>
              <th>id</th>
              <th>started</th>
              <th>dur</th>
              <th>trigger</th>
              <th>tools</th>
              <th>error</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr>
                <td>
                  <a href={`/runs/${r.id}`}>{shortId(r.id)}</a>
                </td>
                <td title={fmtDate(r.startedAt)}>{fmtAge(r.startedAt)}</td>
                <td>{fmtDuration(r.durationMs)}</td>
                <td>{r.trigger}</td>
                <td>{r.toolCalls}</td>
                <td class={r.error ? "run-err" : ""}>{r.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
}

export function RunDetailPage(props: { snap: UiSnapshot; run: AgentRun }) {
  const { run, snap } = props;
  return (
    <Layout title={`run ${shortId(run.id)}`} snap={snap}>
      <a href={`/agents/${encodeURIComponent(run.agentName)}`} class="back">← {run.agentName}</a>
      <h1 class="page-title">
        run {shortId(run.id)} {run.error ? <span class="pill pill-err">failed</span> : null}
      </h1>
      <dl class="facts">
        <dt>agent</dt>
        <dd>
          <a href={`/agents/${encodeURIComponent(run.agentName)}`}>{run.agentName}</a>
        </dd>
        <dt>trigger</dt>
        <dd>{run.trigger}</dd>
        <dt>started</dt>
        <dd>
          {fmtDate(run.startedAt)} <span class="muted">({fmtAge(run.startedAt)})</span>
        </dd>
        <dt>ended</dt>
        <dd>{fmtDate(run.endedAt)}</dd>
        <dt>duration</dt>
        <dd>{fmtDuration(run.durationMs)}</dd>
        <dt>tool calls</dt>
        <dd>{run.toolCalls}</dd>
        <dt>conversation</dt>
        <dd>
          {run.input.conversationId ? (
            <a href={`/conversations/${encodeURIComponent(run.input.conversationId)}`}>
              {run.input.conversationId}
            </a>
          ) : (
            <span class="muted">none</span>
          )}
        </dd>
        {run.input.source ? (
          <>
            <dt>source</dt>
            <dd>{run.input.source}</dd>
          </>
        ) : null}
      </dl>

      <h2>input</h2>
      <pre class="source">{run.input.text}</pre>

      {run.error ? (
        <>
          <h2>error</h2>
          <pre class="source err">{run.error}</pre>
        </>
      ) : (
        <>
          <h2>output</h2>
          <pre class="source">{run.output ?? "(empty)"}</pre>
        </>
      )}
    </Layout>
  );
}

export function ConversationsPage(props: { snap: UiSnapshot; rows: ConversationSummary[] }) {
  const { rows, snap } = props;
  return (
    <Layout title="conversations" snap={snap}>
      <h1 class="page-title">conversations</h1>
      {rows.length === 0 ? (
        <p class="empty">
          No conversations recorded at <code>{snap.paths.dbDir}/conversations.db</code>.
        </p>
      ) : (
        <table class="runs-table">
          <thead>
            <tr>
              <th>id</th>
              <th>turns</th>
              <th>last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <a href={`/conversations/${encodeURIComponent(r.conversationId)}`}>
                    {r.conversationId}
                  </a>
                </td>
                <td>{r.turns}</td>
                <td title={fmtDate(r.lastTs)}>{fmtAge(r.lastTs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
}

export function ConversationDetailPage(props: {
  snap: UiSnapshot;
  conversationId: string;
  turns: ConversationTurn[];
}) {
  const { conversationId, turns, snap } = props;
  return (
    <Layout title={conversationId} snap={snap}>
      <a href="/conversations" class="back">← conversations</a>
      <h1 class="page-title">{conversationId}</h1>
      {turns.length === 0 ? (
        <p class="empty">No turns in this conversation.</p>
      ) : (
        <div class="thread">
          {turns.map((t) => (
            <div class={`turn turn-${t.role}`}>
              <div class="turn-head">
                <span class="turn-role">{t.role}</span>
                <span class="muted" title={fmtDate(t.ts)}>{fmtAge(t.ts)}</span>
              </div>
              <pre class="turn-body">{t.content}</pre>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}

export function NotFoundPage(props: { message: string; snap: UiSnapshot | null }) {
  return (
    <Layout title="not found" snap={props.snap}>
      <h1 class="page-title">not found</h1>
      <p>{props.message}</p>
      <a href="/" class="back">← agents</a>
    </Layout>
  );
}
