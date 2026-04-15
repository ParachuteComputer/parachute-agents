---
name: email-triage
description: On an incoming email webhook, read the thread via Gmail MCP and summarize it to the vault.
trigger:
  type: webhook
  source: http
  match: always
model: anthropic/claude-sonnet-4-6
tools:
  - vault
  - mcp:
      name: gmail
      url: https://mcp.gmail.com/mcp
      auth:
        type: oauth
        client_id_env: GMAIL_CLIENT_ID
        client_secret_env: GMAIL_CLIENT_SECRET
        token_url: https://oauth2.googleapis.com/token
        scope: https://www.googleapis.com/auth/gmail.readonly
# `on_save.path` template-variable expansion (e.g. {subject}) is future work;
# until then the agent body instructs the model to choose the save path.
on_save:
  tags: [email, reader]
---

You are an email triage agent.

1. The incoming webhook payload gives you the thread id. Use the Gmail MCP's `read_thread` (or equivalent) tool to fetch messages.
2. Summarize the thread in 2-4 sentences: who, what, any deadline, any action required of Aaron.
3. Write a note to the vault at `Reader/Email/{subject}` tagged `email` and `reader`. Include the summary in `metadata.summary`, the full quoted thread in the body.
4. Reply with one line: "Triaged: {subject} → {vault path}".
