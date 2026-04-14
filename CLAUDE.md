# @openparachute/agents

Framework for building stateful AI agents on Cloudflare or self-hosted Bun, with native Parachute Vault integration. The "managed agents" platform that the rest of the Parachute ecosystem composes into.

## What this is

Tiny TypeScript package that wraps `cloudflare/agents` (Durable Objects + scheduling) and the Vercel AI SDK, with two opinions:

1. **One markdown file = one agent.** Each agent has frontmatter (trigger config, model, tools, save behavior) + a body (system prompt). The framework loads them at boot, registers triggers, and runs the AI SDK loop on fire. No separate "skill" layer — composable reusable prompts will live in the vault later (tagged `agent-skill`), not in a framework abstraction.
2. **Parachute Vault is the storage layer.** Every agent gets the vault MCP wired in by default. Agents can read/write notes, query tags, traverse the graph, find paths — no glue code.

## Why this exists

Bespoke agent stacks like `weave-bot-orb` (Python + FastAPI + Playwright + Grist + Discord + Slack adapters) are ~3000 lines for what is structurally a "URL in → AI extract → save somewhere" pipeline. With the vault as the substrate and this framework as the runtime, the same pipeline collapses to one TypeScript file + one markdown agent. The vault handles the structured store. The agent markdown handles the prompt + behavior. Everything else is framework.

## Architecture

```
src/
├── ParachuteAgent.ts      # AgentRunner (stateless) + ParachuteAgent (DO wrapper)
├── agents.ts              # agent loader: frontmatter + body → registered handler
├── vault.ts               # MCP client for the configured Parachute Vault
├── connectors/            # Telegram / Discord / Slack (soon) webhook + reply
├── adapters/node.ts       # Bun HTTP server + filesystem agent loader
└── triggers/
    └── webhook.ts         # generic + connector-driven webhook → match → fire
```

## Agent schema (sketch)

```yaml
---
name: <unique slug>
description: <human readable, used in MCP exposure too>
trigger:
  type: webhook | cron | vault | manual
  # webhook
  source: discord | slack | telegram | http
  match: contains_url | regex:<pattern> | always
  # cron
  schedule: "0 9 * * *"
  # vault
  on_event: created | updated
  filter:
    tags: [...]
    not_tags: [...]
model: <provider>/<model>   # e.g. nvidia/nemotron-3-super-120b-a12b, anthropic/claude-sonnet-4-6
tools: [fetch_url, vault, ...]
on_save:
  tags: [...]
  path: <template>
---

System prompt body in markdown.
```

## Tech stack

- **Runtime:** Cloudflare Workers + Durable Objects (via `agents` package), or self-hosted Bun
- **AI:** Vercel AI SDK (`ai` package) — provider-agnostic
- **Vault MCP:** the standard Parachute Vault HTTP MCP at `<vault-url>/mcp` (Streamable HTTP transport)
- **Browser fetch:** Cloudflare Browser Rendering for JS-heavy pages, plain fetch for the rest
- **Config:** TypeScript at boot + markdown agents loaded at deploy time (CF) or startup (Bun)

## Conventions for tentacles working in this repo

- Read this CLAUDE.md and the README first
- The MVP is "rebuild weave-bot-orb on this framework as the example" — that's the test
- Don't over-engineer the agent schema. Start with what weave-bot-orb actually does + one cron agent (weekly summary), and let the schema grow from real use
