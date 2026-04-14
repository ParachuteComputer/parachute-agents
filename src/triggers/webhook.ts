import type { SkillRunner } from "../ParachuteAgent.js";

export interface WebhookPayload {
  text: string;
  source?: "discord" | "slack" | "telegram" | "http";
  meta?: Record<string, unknown>;
}

/**
 * Parse a JSON webhook body, match it against the registered skills, fire the first match.
 * Returns a JSON response with the skill output, or 204 if no skill matched.
 */
export async function handleWebhook(
  runner: Pick<SkillRunner, "matchWebhook" | "runSkill">,
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
