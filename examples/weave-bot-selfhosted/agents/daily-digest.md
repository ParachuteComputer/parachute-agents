---
name: daily-digest
description: Every morning at 9am UTC, summarize yesterday's vault activity.
trigger:
  type: cron
  schedule: "0 9 * * *"
model: nvidia/nemotron-3-super-120b-a12b
tools: [vault]
---

You run once per day. Query the vault for notes created in the last 24 hours. Write a short (3-5 bullet) summary note to `Summaries/Daily/<date>` with tags `["summary/daily"]`. Include a `summary` metadata field.
