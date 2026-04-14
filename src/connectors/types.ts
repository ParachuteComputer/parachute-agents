/**
 * Platforms the framework can route to. Must match the `trigger.source` enum in
 * `skills.ts` — extending this list requires updating both.
 */
export type Platform = "telegram" | "discord" | "slack" | "http";

export interface IncomingMessage {
  /** The user-visible text of the message. URLs and mentions preserved as-is. */
  text: string;
  /** Which platform produced this message. */
  platform: Platform;
  /** Stable identifier for the user who sent it (platform-scoped). */
  sender: { id: string; name?: string };
  /** Stable identifier for the conversation/room/channel this came from. */
  channelId: string;
  /** Platform message ID, used for reply-threading if the platform supports it. */
  messageId?: string;
  /** Raw platform payload for connectors that need fields the normalized shape omits. */
  meta?: Record<string, unknown>;
}

export interface OutgoingMessage {
  channelId: string;
  text: string;
  /** Platform message ID to reply-to; ignored by platforms that lack threading. */
  replyTo?: string;
}

/**
 * Minimal interface every connector implements. Connectors are pure wrappers around
 * a platform's webhook shape + outbound API — no state, no storage.
 */
export interface Connector<Config = unknown> {
  /** Matches the `trigger.source` field in skill frontmatter. */
  platform: Platform;
  /**
   * Parse a platform webhook into a normalized message, or return null if the
   * payload isn't a user message (e.g. join notifications, edits, reactions).
   */
  parse(request: Request): Promise<IncomingMessage | null>;
  /** Send a reply back to the platform. */
  reply(out: OutgoingMessage, config: Config): Promise<void>;
}
