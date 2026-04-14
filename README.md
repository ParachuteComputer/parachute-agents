# @openparachute/agents

**Parachute Managed Agents.** A thin framework for building stateful AI agents that live on Cloudflare and natively know how to talk to a Parachute Vault.

> **Status:** Sketch. Designed in collaboration with Aaron in an open Telegram brainstorm. Inspired by [weave-bot-orb](https://github.com/woven-web/weave-bot-orb) — same problem (Discord bot watches for URLs → AI extracts events → save to structured store), one tenth the surface area.

## What this is

A Cloudflare Agents class that:

- **Loads its behavior from a folder of markdown skill files.** Each skill is a frontmatter + body file describing when to fire and what to do.
- **Has the Parachute Vault MCP wired in by default.** Every skill can read/write notes, traverse the graph, query tags, list links, etc. — without you writing any glue.
- **Speaks any model via the Vercel AI SDK.** Default is Nemotron Super because the magic is in the knowledge graph, not the model. Swap to Claude, GPT, Gemini, or local Ollama in one config line.
- **Runs on Cloudflare's stateful runtime.** Hibernate when idle, scale to millions of instances, schedule cron tasks, hold WebSocket conversations, persist state in a built-in SQLite per-agent database.
- **Triggers on what you'd expect:** webhook (Discord/Slack/Telegram/email/HTTP), cron, vault note mutation.

The result: a Discord bot that watches a channel for URLs, extracts event details with an AI, and saves them into your Parachute Vault is roughly 50 lines of TypeScript + one markdown skill file.

## Compared to the bespoke approach

`weave-bot-orb` is ~3000 lines of Python across 3 services (FastAPI agent + Discord bot + Slack bot), uses Playwright + per-org config + per-org Grist documents + multi-platform webhook routing. It works, but every new feature touches three places and storage is bolted on as a side effect.

A `@openparachute/agents` agent is one Cloudflare Worker, one folder of markdown skills, and one vault. New features are new markdown files. Storage is the vault — no Grist, no SQLite-per-platform, no callback dance.

## The shape (sketch)

```
my-agent/
├── wrangler.toml
├── src/
│   └── index.ts          # ~30 lines: instantiate ParachuteAgent, wire triggers
├── skills/
│   ├── extract-event.md  # frontmatter + system prompt
│   └── weekly-summary.md # cron skill
└── package.json
```

A skill file:

```yaml
---
name: extract-event
description: When a URL is shared, extract event metadata and save it to the vault.
trigger:
  type: webhook
  source: discord
  match: contains_url
model: nvidia/nemotron-super
tools: [fetch_url, vault]
on_save:
  tags: [event]
  path: Events/{title}
---

You are an event extraction agent. When a URL is shared:

1. Fetch the page with `fetch_url`
2. Extract title, start datetime, end datetime, venue, address, description, image
3. If it's clearly an event, save it to the vault with the configured path/tags
4. Reply with a one-line summary + a link to the vault note
```

That's it. The framework handles:
- Discord webhook → match URL → fire skill
- Vercel AI SDK loop with the model + tools
- Vault MCP auto-injection (tools: `query-notes`, `create-note`, `update-note`, etc.)
- Reply formatting back to Discord

## Why now

We just shipped Parachute Vault v0.1 with OAuth 2.1, a clean 9-tool MCP surface, scoped tokens, and `include_metadata` field filtering. The vault is finally a stable platform. That's the substrate this framework needs.

Anthropic shipped Claude Managed Agents recently — same idea but locked into the Claude Max subscription. Parachute Managed Agents is the open, self-hosted, model-agnostic version. The vault is the moat.
