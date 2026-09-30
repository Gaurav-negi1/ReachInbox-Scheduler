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

export async function notifyRateLimitHit(
  userId: string | null,
  event: RateLimitEvent
): Promise<void> {
  try {
    const user = userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : null;

    const text =
      `:rotating_light: *Hourly email limit reached*\n` +
      `• Scope: *${
        event.reason === "global"
          ? "global"
          : event.reason === "batch"
            ? `batch ${event.senderEmail}`
            : `sender ${event.senderEmail}`
      }*\n` +
      `• Limit: ${event.limit} emails/hour\n` +
      `• Window resets: <!date^${Math.floor(event.windowResetsAtMs / 1000)}^{date_short} at {time}|next hour>\n` +
      `• Jobs stay queued and will resume in the next window — nothing is dropped.`;

    if (user?.slackWebhook) {
      const webhook = new IncomingWebhook(user.slackWebhook);
      await webhook.send({ text });
      logger.info({ userId }, "slack webhook notification sent");
      return;
    }

    if (user?.slackBotToken) {
      const client = new WebClient(user.slackBotToken);
      await client.chat.postMessage({
        channel: user.slackChannel ?? "#general",
        text,
      });
      logger.info({ userId }, "slack bot notification sent");
      return;
    }

    logger.info({ userId }, "slack not connected — skipping rate-limit notification");
  } catch (err) {
    // Notification failures must never break the email pipeline.
    logger.error({ err, userId }, "slack notification failed (non-fatal)");
  }
}
