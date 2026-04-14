# @openparachute/agents

Framework for building stateful AI agents on Cloudflare with native Parachute Vault integration. The "managed agents" platform that the rest of the Parachute ecosystem composes into.

## What this is

Tiny TypeScript package that wraps `cloudflare/agents` (Durable Objects + scheduling) and the Vercel AI SDK, with two opinions:

1. **Agent behavior is configured by markdown skill files.** Each skill has frontmatter (trigger config, model, tools, save behavior) + a body (system prompt). The framework loads them at boot, registers triggers, and runs the AI SDK loop on fire.
2. **Parachute Vault is the storage layer.** Every agent gets the vault MCP wired in by default. Skills can read/write notes, query tags, traverse the graph, find paths — no glue code.

## Why this exists

Bespoke agent stacks like `weave-bot-orb` (Python + FastAPI + Playwright + Grist + Discord + Slack adapters) are ~3000 lines for what is structurally a "URL in → AI extract → save somewhere" pipeline. With the vault as the substrate and CF Agents as the runtime, the same pipeline collapses to one TypeScript file + one markdown skill. The vault handles the structured store. The skill markdown handles the prompt + behavior. Everything else is framework.

## Architecture

```
src/
├── ParachuteAgent.ts   # base class extending cloudflare/agents Agent<Env, State>
├── skills.ts            # skill loader: frontmatter + body → registered handler
├── vault.ts             # MCP client for the configured Parachute Vault
├── triggers/
│   ├── webhook.ts       # Discord/Slack/HTTP webhook → match → fire skill
│   ├── cron.ts          # cron trigger
│   └── vault.ts         # vault note mutation → fire skill
└── index.ts
```

## Skill schema (sketch)

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

- **Runtime:** Cloudflare Workers + Durable Objects (via `agents` package)
- **AI:** Vercel AI SDK (`ai` package) — provider-agnostic
- **Vault MCP:** the standard Parachute Vault HTTP MCP at `<vault-url>/mcp`
- **Browser fetch:** Cloudflare Browser Rendering for JS-heavy pages, plain fetch for the rest
- **Config:** TypeScript at boot + markdown skills loaded at deploy time

## Status

Sketch. README + CLAUDE.md only. Real implementation pending alignment with Aaron on the shape.

## Conventions for tentacles working in this repo

- Read this CLAUDE.md and the README first
- This is a NEW repo — no legacy to preserve
- The MVP is "rebuild weave-bot-orb on this framework as the example" — that's the test
- Don't over-engineer the skill schema. Start with what weave-bot-orb actually does + one cron skill (weekly summary), and let the schema grow from real use
