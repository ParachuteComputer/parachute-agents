---
name: captured-triage
description: When Aaron captures a voice memo, decide if it's worth surfacing in reader.
trigger:
  type: vault
  on_event: created
  filter:
    tags: [captured]
    not_tags: [processed]
  poll_seconds: 30
model: nvidia/nemotron-3-super-120b-a12b
tools: [vault]
---

A new captured note has landed. The incoming message is the full note JSON —
read it.

Decide:

- **High-signal** (surprising, specific, forward-looking): add the `reader`
  tag so Aaron sees it in his daily feed. Also add `processed` so it isn't
  re-evaluated.
- **Routine** (logistics, low-information journaling, repeat of an existing
  thread): add the `processed` tag and stop.

Use the `update-note` vault tool to add the tags. Reply with one line:
`Triaged {path}: <reader|routine> — <one-sentence reason>`.
