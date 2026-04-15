import type { AgentRunner } from "../runner.js";
import type { Connector, IncomingMessage } from "../connectors/types.js";

export interface WebhookPayload {
  text: string;
  source?: "discord" | "slack" | "telegram" | "http";
  meta?: Record<string, unknown>;
}

type RunnerLike = Pick<AgentRunner, "matchWebhook" | "runAgent">;

/**
 * Parse a generic `{text, source, meta}` JSON webhook body, match it against the
 * registered agents, fire the first match. Returns the agent output as JSON or
 * 204 if no agent matched.
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

  const agent = runner.matchWebhook({ text: payload.text, source: payload.source });
  if (!agent) return new Response(null, { status: 204 });

  const conversationId =
    typeof payload.meta?.conversation_id === "string" ? payload.meta.conversation_id : undefined;

  const result = await runner.runAgent(
    agent.frontmatter.name,
    { text: payload.text, source: payload.source, meta: payload.meta },
    { conversationId, trigger: "webhook" },
  );
  return Response.json(result);
}

export interface ConnectorWebhookOptions<Config> {
  connector: Connector<Config>;
  config: Config;
  /** If true, send the agent's text output back to the platform via connector.reply(). */
  autoReply?: boolean;
}

/**
 * Parse a platform webhook through a {@link Connector}, match an agent, run it,
 * optionally reply on the platform. Returns a JSON response describing what happened.
 */
export async function handleConnectorWebhook<Config>(
  runner: RunnerLike,
  request: Request,
  opts: ConnectorWebhookOptions<Config>,
): Promise<Response> {
  const msg: IncomingMessage | null = await opts.connector.parse(request);
  if (!msg) return new Response(null, { status: 204 });

  const agent = runner.matchWebhook({ text: msg.text, source: msg.platform });
  if (!agent) return new Response(null, { status: 204 });

  const result = await runner.runAgent(
    agent.frontmatter.name,
    {
      text: msg.text,
      source: msg.platform,
      meta: { sender: msg.sender, channelId: msg.channelId, meta: msg.meta },
    },
    { conversationId: `${msg.platform}:${msg.channelId}`, trigger: "webhook" },
  );

  if (opts.autoReply && result.text) {
    await opts.connector.reply(
      { channelId: msg.channelId, text: result.text, replyTo: msg.messageId },
      opts.config,
    );
  }

  return Response.json({
    agent: result.agent,
    text: result.text,
    toolCalls: result.toolCalls,
    channelId: msg.channelId,
    replied: Boolean(opts.autoReply && result.text),
  });
}
