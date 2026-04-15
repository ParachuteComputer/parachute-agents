import { expect, test } from "bun:test";
import { AgentRunner } from "../src/runner.js";

const extractEvent = `---
name: extract-event
trigger:
  type: webhook
  source: telegram
  match: contains_url
model: test-model
---
system`;

const generalChat = `---
name: general-chat
trigger:
  type: webhook
  source: any
  match: always
model: test-model
---
system`;

const otherChat = `---
name: other-chat
trigger:
  type: webhook
  source: any
  match: always
model: test-model
---
system`;

function runner(agents: Record<string, string>) {
  return new AgentRunner({
    agents,
    provider: { name: "x", baseURL: "http://x", apiKey: "x" },
  });
}

test("URL payload → specific matcher wins", () => {
  const r = runner({ "extract.md": extractEvent, "general.md": generalChat });
  const hit = r.matchWebhook({ text: "check https://example.com", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("extract-event");
});

test("plain payload → catch-all fires", () => {
  const r = runner({ "extract.md": extractEvent, "general.md": generalChat });
  const hit = r.matchWebhook({ text: "hi there", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("general-chat");
});

test("reversed load order: URL payload still routes to specific matcher", () => {
  const r = runner({ "general.md": generalChat, "extract.md": extractEvent });
  const hit = r.matchWebhook({ text: "https://example.com", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("extract-event");
});

test("two always agents: first-loaded wins", () => {
  const r = runner({ "general.md": generalChat, "other.md": otherChat });
  const hit = r.matchWebhook({ text: "hi", source: "telegram" });
  expect(hit?.frontmatter.name).toBe("general-chat");
});
