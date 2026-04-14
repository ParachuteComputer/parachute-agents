import type { SkillRunner } from "../ParachuteAgent.js";
import type { Connector, IncomingMessage } from "../connectors/types.js";

export interface WebhookPayload {
  text: string;
  source?: "discord" | "slack" | "telegram" | "http";
  meta?: Record<string, unknown>;
}

type RunnerLike = Pick<SkillRunner, "matchWebhook" | "runSkill">;

/**
 * Parse a generic `{text, source, meta}` JSON webhook body, match it against the
 * registered skills, fire the first match. Returns the skill output as JSON or
 * 204 if no skill matched.
 *
 * For platform-specific handling (Telegram, Discord), prefer {@link handleConnectorWebhook}.
 */
export async function handleWebhook(
  runner: RunnerLike,
  request: Request,
): Promise<Response> {
  let payload: WebhookPayload;
  try {
    payload = (await request.json()) as WebhookPayload;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const skill = runner.matchWebhook({ text: payload.text, source: payload.source });
  if (!skill) return new Response(null, { status: 204 });

  const result = await runner.runSkill(skill.frontmatter.name, {
    user: payload.text,
    context: payload.meta,
  });
  return Response.json(result);
}

export interface ConnectorWebhookOptions<Config> {
  connector: Connector<Config>;
  config: Config;
  /** If true, send the skill's text output back to the platform via connector.reply(). */
  autoReply?: boolean;
}

/**
 * Parse a platform webhook through a {@link Connector}, match a skill, run it,
 * optionally reply on the platform. Returns a JSON response describing what happened.
 */
export async function handleConnectorWebhook<Config>(
  runner: RunnerLike,
  request: Request,
  opts: ConnectorWebhookOptions<Config>,
): Promise<Response> {
  const msg: IncomingMessage | null = await opts.connector.parse(request);
  if (!msg) return new Response(null, { status: 204 });

  const skill = runner.matchWebhook({ text: msg.text, source: msg.platform });
  if (!skill) return new Response(null, { status: 204 });

  const result = await runner.runSkill(skill.frontmatter.name, {
    user: msg.text,
    context: { sender: msg.sender, channelId: msg.channelId, meta: msg.meta },
  });

  if (opts.autoReply && result.text) {
    await opts.connector.reply(
      { channelId: msg.channelId, text: result.text, replyTo: msg.messageId },
      opts.config,
    );
  }

  return Response.json({
    skill: result.skill,
    text: result.text,
    toolCalls: result.toolCalls,
    channelId: msg.channelId,
    replied: Boolean(opts.autoReply && result.text),
  });
}
