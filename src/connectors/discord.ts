import type { Connector, IncomingMessage, OutgoingMessage } from "./types.js";

export interface DiscordConfig {
  /** Bot token (Bot <token>) for the Discord REST API. */
  botToken: string;
}

interface DiscordMessageCreate {
  id: string;
  content: string;
  channel_id: string;
  author?: { id: string; username?: string; bot?: boolean };
}

/**
 * Discord connector.
 *
 * Discord's real-time messages arrive over the Gateway (websocket), not HTTP — so
 * downstream you'll either:
 *   (a) run a tiny gateway proxy that POSTs MESSAGE_CREATE events to this webhook
 *       as JSON matching the Discord Message object shape, or
 *   (b) use Discord Interactions (slash commands / components) which DO arrive
 *       over HTTP and follow a different shape (not covered here yet).
 *
 * This connector handles (a). Bot-authored messages are ignored to avoid loops.
 */
export const discord: Connector<DiscordConfig> = {
  platform: "discord",

  async parse(request: Request): Promise<IncomingMessage | null> {
    let msg: DiscordMessageCreate;
    try {
      msg = (await request.json()) as DiscordMessageCreate;
    } catch {
      return null;
    }
    if (!msg.content || !msg.channel_id || !msg.id) return null;
    if (msg.author?.bot) return null;

    return {
      text: msg.content,
      platform: "discord",
      sender: {
        id: msg.author?.id ?? "",
        name: msg.author?.username,
      },
      channelId: msg.channel_id,
      messageId: msg.id,
    };
  },

  async reply(out: OutgoingMessage, config: DiscordConfig): Promise<void> {
    const url = `https://discord.com/api/v10/channels/${out.channelId}/messages`;
    const body: Record<string, unknown> = { content: out.text };
    if (out.replyTo) {
      body.message_reference = { message_id: out.replyTo };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${config.botToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`discord POST message failed: ${res.status} ${await res.text()}`);
    }
  },
};
