import type { Connector, IncomingMessage, OutgoingMessage } from "./types.js";

export interface TelegramConfig {
  /** Bot token from @BotFather. */
  botToken: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
}

/**
 * Telegram webhook connector. Wire via `setWebhook` on the Bot API pointing at
 * your agent's `/webhook` endpoint.
 *
 * Only plain text messages are surfaced — edits, joins, reactions return null.
 *
 * TODO: verify `X-Telegram-Bot-Api-Secret-Token` header against a shared secret
 * before trusting the payload in production deployments.
 */
export const telegram: Connector<TelegramConfig> = {
  platform: "telegram",

  async parse(request: Request): Promise<IncomingMessage | null> {
    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return null;
    }
    const msg = update.message;
    if (!msg) return null;

    const text = msg.text ?? msg.caption;
    if (!text) return null;

    const senderName = msg.from?.username ?? msg.from?.first_name;
    // Channel posts have no `from`; keep those distinct per-message instead of
    // collapsing all anonymous traffic onto a shared "" sender id.
    const senderId = msg.from?.id != null ? String(msg.from.id) : `anon-${msg.message_id}`;
    return {
      text,
      platform: "telegram",
      sender: { id: senderId, name: senderName },
      channelId: String(msg.chat.id),
      messageId: String(msg.message_id),
      meta: { update_id: update.update_id },
    };
  },

  async reply(out: OutgoingMessage, config: TelegramConfig): Promise<void> {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: out.channelId,
      text: out.text,
    };
    if (out.replyTo) body.reply_to_message_id = Number(out.replyTo);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`telegram sendMessage failed: ${res.status} ${await res.text()}`);
    }
  },
};
