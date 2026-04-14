# @openparachute/agents

**Parachute Managed Agents.** A thin framework for building stateful AI agents that natively know how to talk to a Parachute Vault. Deploy to Cloudflare Workers for edge + per-agent Durable Objects, or run the same agents on a self-hosted Bun server — the agent markdown is identical across both.

> **Status:** Sketch. Designed in collaboration with Aaron in an open Telegram brainstorm. Inspired by [weave-bot-orb](https://github.com/woven-web/weave-bot-orb) — same problem (Discord bot watches for URLs → AI extracts events → save to structured store), one tenth the surface area.

## What this is

- **One markdown file = one agent.** Each agent is a frontmatter + body file describing when to fire and what to do. No separate "skill" layer — composable reusable prompts will live in the vault later, not in a framework abstraction.
- **Parachute Vault MCP wired in by default.** Every agent can read/write notes, traverse the graph, query tags, list links — without you writing any glue.
- **Any model via the Vercel AI SDK.** Default is Nemotron 3 Super (120B MoE) because the magic is in the knowledge graph, not the model. Swap to Claude, GPT, Gemini, or local Ollama in one config line.
- **Runs on Cloudflare's stateful runtime *or* self-hosted Bun.** Same agents, same runner, two deployment modes. On CF you get Durable Objects + hibernation + edge. On Bun you get a single `bun src/index.ts` on any box.
- **Native connectors for Telegram, Discord, (Slack soon).** Connectors parse platform webhooks into a normalized `IncomingMessage` shape and reply via platform APIs — no per-platform glue in your agents.
- **Triggers on what you'd expect:** webhook (Discord/Slack/Telegram/HTTP), cron, vault note mutation.

The result: a Discord bot that watches a channel for URLs, extracts event details, and saves them into your Parachute Vault is roughly 50 lines of TypeScript + one markdown agent file.

## Compared to the bespoke approach

`weave-bot-orb` is ~3000 lines of Python across 3 services (FastAPI agent + Discord bot + Slack bot), uses Playwright + per-org config + per-org Grist documents + multi-platform webhook routing. It works, but every new feature touches three places and storage is bolted on as a side effect.

A `@openparachute/agents` app is one runtime wrapper, one folder of markdown agents, and one vault. New features are new markdown files. Storage is the vault — no Grist, no SQLite-per-platform, no callback dance.

## Two deployment modes

Pick whichever suits the app — **the agent markdown is identical**, only the runtime wrapper differs.

### Cloudflare Workers + Durable Objects

```
my-agent/
├── wrangler.toml          # rules = [{ type = "Text", globs = ["agents/**/*.md"] }]
├── agents/*.md            # imported as raw strings at build time
└── src/index.ts           # extend ParachuteAgent, register as DO
```

`examples/weave-bot/` is the reference.

### Self-hosted Bun

```
my-agent/
├── agents/*.md            # loaded from disk at startup
└── src/index.ts           # import { startSelfHosted } from "@openparachute/agents/adapters/node"
```

`examples/weave-bot-selfhosted/` is the reference. Run with `bun src/index.ts`.

## The shape (sketch)

```
my-agent/
├── wrangler.toml
├── src/
│   └── index.ts            # ~30 lines: instantiate ParachuteAgent, wire triggers
├── agents/
│   ├── extract-event.md    # frontmatter + system prompt
│   └── weekly-summary.md   # cron agent
└── package.json
```

An agent file:

```yaml
---
name: extract-event
description: When a URL is shared, extract event metadata and save it to the vault.
trigger:
  type: webhook
  source: discord
  match: contains_url
model: nvidia/nemotron-3-super-120b-a12b
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
- Discord webhook → match URL → fire agent
- Vercel AI SDK loop with the model + tools
- Vault MCP auto-injection (tools: `query-notes`, `create-note`, `update-note`, etc.)
- Reply formatting back to Discord

## Why now

We just shipped Parachute Vault v0.1 with OAuth 2.1, a clean 9-tool MCP surface, scoped tokens, and `include_metadata` field filtering. The vault is finally a stable platform. That's the substrate this framework needs.

Anthropic shipped Claude Managed Agents recently — same idea but locked into the Claude Max subscription. Parachute Managed Agents is the open, self-hosted, model-agnostic version. The vault is the moat.
