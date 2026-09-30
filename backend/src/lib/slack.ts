import { IncomingWebhook } from "@slack/webhook";
import { WebClient } from "@slack/web-api";
import { prisma } from "./prisma";
import { logger } from "../logger";

/**
 * Slack notifications on rate-limit hits.
 *
 * A user connects Slack via OAuth from the dashboard; we store either an
 * incoming-webhook URL or a bot token (chat.postMessage). If nothing is
 * connected we no-op silently — never crash the send path.
 */

export type RateLimitEvent = {
  senderEmail: string;
  reason: "global" | "sender" | "batch";
  limit: number;
  windowResetsAtMs: number;
  queuedAhead: number;
};

function scopeLabel(event: RateLimitEvent): string {
  return event.reason === "global"
    ? "global"
    : event.reason === "batch"
      ? `batch (sender ${event.senderEmail})`
      : `sender ${event.senderEmail}`;
}

/**
 * Mirror the alert into Postgres so the dashboard bell can show it in-app.
 * Best-effort: alert persistence must never break the send pipeline.
 */
async function recordAlert(userId: string | null, event: RateLimitEvent, slackSent: boolean): Promise<void> {
  try {
    await prisma.rateLimitAlert.create({
      data: {
        userId,
        reason: event.reason,
        scope: scopeLabel(event),
        limit: event.limit,
        queuedAhead: event.queuedAhead,
        slackSent,
      },
    });
  } catch {
    // Non-fatal — the Slack message (if any) already went out.
  }
}

export type NotifyOptions = {
  /** Write the in-app alert row (first hit per scope per window). */
  record?: boolean;
  /** Attempt Slack delivery. */
  slack?: boolean;
};

/**
 * Returns true only if a Slack message was actually delivered (so the caller
 * can keep its per-window Slack dedupe only for real deliveries — a user who
 * connects Slack mid-window still gets the next hit).
 */
export async function notifyRateLimitHit(
  userId: string | null,
  event: RateLimitEvent,
  opts: NotifyOptions = { record: true, slack: true }
): Promise<boolean> {
  let delivered = false;
  try {
    if (opts.slack !== false) {
      const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;

      const text =
        `:rotating_light: *Hourly email limit reached*\n` +
        `• Scope: *${scopeLabel(event)}*\n` +
        `• Limit: ${event.limit} emails/hour\n` +
        `• Emails parked behind the cap: ${event.queuedAhead}\n` +
        `• Window resets: <!date^${Math.floor(event.windowResetsAtMs / 1000)}^{date_short} at {time}|next hour>\n` +
        `• Jobs stay queued and will resume in the next window — nothing is dropped.`;

      if (user?.slackWebhook) {
        await new IncomingWebhook(user.slackWebhook).send({ text });
        logger.info({ userId }, "slack webhook notification sent");
        delivered = true;
      } else if (user?.slackBotToken) {
        await new WebClient(user.slackBotToken).chat.postMessage({
          channel: user.slackChannel ?? "#general",
          text,
        });
        logger.info({ userId }, "slack bot notification sent");
        delivered = true;
      } else {
        logger.info({ userId }, "slack not connected — skipping rate-limit notification");
      }
    }
  } catch (err) {
    // Notification failures must never break the email pipeline.
    logger.error({ err, userId }, "slack notification failed (non-fatal)");
  }

  if (opts.record !== false) await recordAlert(userId, event, delivered);
  return delivered;
}
