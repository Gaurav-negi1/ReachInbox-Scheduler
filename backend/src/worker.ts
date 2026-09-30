import "dotenv/config";
import { Worker, type Job, DelayedError } from "bullmq";
import { prisma } from "./lib/prisma";
import { connection, emailQueue } from "./lib/queue";
import { logger } from "./logger";
import { config, QUEUE_NAME } from "./config";
import { sendMail } from "./lib/mailer";
import { tryClaimSendSlot, releaseHourlySlots, msUntilNextHour, shouldAlertRateLimit } from "./lib/rateLimiter";
import { notifyRateLimitHit } from "./lib/slack";
import { indexEmail } from "./lib/elasticsearch";

/**
 * Email send worker.
 *
 * - BullMQ delayed jobs drive every send (no cron).
 * - Concurrency is configurable (WORKER_CONCURRENCY).
 * - Redis-backed rate limiting is shared across all worker instances, so
 *   N workers cannot collectively exceed the hourly caps.
 * - The DB row status is the source of truth; a job only sends if the row
 *   is still SCHEDULED/SENDING, guaranteeing at-most-once delivery even if
 *   BullMQ redelivers a job after a crash.
 * - Slack alert dedupe is Redis-NX (rl:alert:{window}:{scope}), so multiple
 *   worker instances produce a single alert per scope per window.
 */

async function maybeAlertRateLimit(
  userId: string | null,
  senderEmail: string,
  batchId: string | null | undefined,
  reason: "global" | "sender" | "batch",
  jobBatchLimit?: number | null
) {
  // One alert per scope per hour window, deduped atomically in Redis so it
  // holds across multiple worker instances too.
  const first = await shouldAlertRateLimit(connection, reason, senderEmail, batchId);
  if (!first) return;
  await notifyRateLimitHit(userId, {
    senderEmail,
    reason,
    limit:
      reason === "global"
        ? config.worker.maxPerHourGlobal
        : reason === "sender"
          ? config.worker.maxPerHourPerSender
          : Number(jobBatchLimit ?? 0),
    windowResetsAtMs: Date.now() + msUntilNextHour(),
    queuedAhead: 0,
  });
}

async function processEmailJob(job: Job, token?: string): Promise<void> {
  const { emailRecordId, senderEmail, recipientEmail, subject, body, userId } = job.data;

  // Idempotency gate: claim the DB row first. If it is not claimable
  // (already SENT / SENDING elsewhere / CANCELLED) we simply finish.
  const claim = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
    UPDATE "ScheduledEmail"
    SET status = 'SENDING', "attemptCount" = "attemptCount" + 1, "updatedAt" = now()
    WHERE id = ${emailRecordId} AND status IN ('SCHEDULED', 'SENDING')
    RETURNING id, status
  `;
  const claimed = claim[0];
  if (!claimed) {
    logger.info({ jobId: job.id, emailRecordId }, "job skipped — row not claimable (already sent/cancelled)");
    return;
  }

  const row = await prisma.scheduledEmail.findUnique({ where: { id: emailRecordId } });
  if (!row) {
    logger.error({ emailRecordId }, "claimed row vanished — skipping");
    return;
  }

  // Rate limiting + throttle: atomically claim a send slot in Redis.
  const slot = await tryClaimSendSlot(connection, senderEmail, row.batchId, row.hourlyLimit);
  if (!slot.allowed) {
    // Release the claim and move the ACTIVE job into BullMQ's delayed state —
    // nothing is dropped or failed; order is preserved via overflow ranks.
    await prisma.scheduledEmail.update({
      where: { id: emailRecordId },
      data: { status: "SCHEDULED", lastError: null },
    });
    // slot.retryAtMs is absolute, Redis-TIME-based; add a small buffer so the
    // job becomes ready strictly after the window/throttle opens.
    const resumeAt = Math.max(Date.now() + 1000, slot.retryAtMs + 250);
    await job.moveToDelayed(resumeAt, token);
    logger.info(
      { jobId: job.id, reason: slot.reason, resumeAt: new Date(resumeAt).toISOString() },
      "rate limit / throttle hit — job moved to delayed state"
    );
    if (slot.reason === "global" || slot.reason === "sender" || slot.reason === "batch") {
      await maybeAlertRateLimit(userId, senderEmail, row.batchId, slot.reason, row.hourlyLimit);
    }
    throw new DelayedError(); // BullMQ parks the job until resumeAt; not a failure
  }

  try {
    // Attachments live in Postgres per email row; load them just-in-time so
    // job payloads stay small and retries re-read fresh data.
    const attachmentRows = await prisma.attachment.findMany({ where: { emailId: emailRecordId } });
    const { messageId, previewUrl } = await sendMail(senderEmail, {
      to: recipientEmail,
      subject,
      text: body,
      html: row.bodyHtml ?? null,
      attachments: attachmentRows.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.data),
        contentType: a.mimetype,
      })),
    });

    const sentAt = new Date();
    await prisma.scheduledEmail.update({
      where: { id: emailRecordId },
      data: { status: "SENT", sentAt, lastError: null },
    });

    // Mirror into Elasticsearch only after the DB commit. indexEmail is
    // best-effort (never throws), and the guard below is belt-and-braces so a
    // search-layer outage can never turn a completed send into a "failure".
    await indexEmail({
      id: row.id,
      userId: row.userId,
      senderEmail: row.senderEmail,
      recipientEmail: row.recipientEmail,
      subject: row.subject,
      body: row.body,
      status: "SENT",
      scheduledAt: row.scheduledAt,
      sentAt,
      batchId: row.batchId,
      starred: row.starred,
    }).catch(() => undefined);

    logger.info(
      { jobId: job.id, to: recipientEmail, messageId, previewUrl, attachments: attachmentRows.length },
      "email sent"
    );
  } catch (err) {
    // Failed SMTP attempt: release the rate-limit slots we consumed.
    // If BullMQ will retry, put the row back to SCHEDULED so the claim gate
    // lets the retry through; only mark FAILED on the final attempt.
    await releaseHourlySlots(connection, senderEmail, row.batchId, row.hourlyLimit).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    const attemptsConfigured = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attemptsConfigured;
    await prisma.scheduledEmail.update({
      where: { id: emailRecordId },
      data: {
        status: isFinalAttempt ? "FAILED" : "SCHEDULED",
        lastError: message.slice(0, 500),
      },
    });

    // Terminal failure: mirror it into Elasticsearch so failed emails stay
    // searchable (with status FAILED) in the Sent tab.
    if (isFinalAttempt) {
      await indexEmail({
        id: row.id,
        userId: row.userId,
        senderEmail: row.senderEmail,
        recipientEmail: row.recipientEmail,
        subject: row.subject,
        body: row.body,
        status: "FAILED",
        scheduledAt: row.scheduledAt,
        sentAt: null,
        batchId: row.batchId,
        starred: row.starred,
      }).catch(() => undefined);
    }

    logger.error({ jobId: job.id, isFinalAttempt, err: message }, "smtp send failed");
    throw err; // let BullMQ handle retry/backoff
  }
}

export function startWorker(): Worker {
  const worker = new Worker(QUEUE_NAME, processEmailJob, {
    connection,
    concurrency: config.worker.concurrency,
    autorun: true,
  });

  worker.on("completed", (job) => logger.debug({ jobId: job.id }, "job completed"));
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "job failed (will retry per backoff)");
  });
  worker.on("error", (err) => logger.error({ err: err.message }, "worker error"));

  logger.info(
    {
      queue: QUEUE_NAME,
      concurrency: config.worker.concurrency,
      minDelaySec: config.worker.minSendDelaySeconds,
      globalHourlyCap: config.worker.maxPerHourGlobal,
      senderHourlyCap: config.worker.maxPerHourPerSender,
    },
    "email worker started"
  );
  return worker;
}

// If run directly (npm run worker), boot and install graceful shutdown.
if (require.main === module) {
  void (async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const worker = startWorker();

      const shutdown = async (signal: string) => {
        logger.info({ signal }, "shutting worker down gracefully...");
        // Wait for in-flight jobs so we never kill a send mid-flight;
        // unclaimed rows stay SCHEDULED and resume after restart.
        await worker.close();
        await emailQueue.close();
        await prisma.$disconnect();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
    } catch (err) {
      logger.error({ err }, "worker failed to start");
      process.exit(1);
    }
  })();
}
