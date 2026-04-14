# weave-bot-selfhosted

Same skill, same vault, same framework — running as a Bun HTTP server on any machine. No Cloudflare account required.

## Run

```bash
bun install
export VAULT_URL=https://vault.example.com/mcp
export VAULT_TOKEN=...
export PROVIDER_API_KEY=...              # OpenRouter key
export TELEGRAM_BOT_TOKEN=...            # optional; endpoint is off if unset
export DISCORD_BOT_TOKEN=...             # optional
bun run dev
```

## Webhooks

- `POST /webhook` — generic `{text, source, meta}` shape, useful for curl testing.
- `POST /webhook/telegram` — Telegram Bot API webhook. Point `setWebhook` here.
- `POST /webhook/discord` — Discord message-create webhook. Expects a proxy upstream that forwards gateway MESSAGE_CREATE events as JSON.

## Test

```bash
curl -X POST localhost:3000/webhook \
  -H 'content-type: application/json' \
  -d '{"text": "check out https://example.com/event", "source": "telegram"}'
```
