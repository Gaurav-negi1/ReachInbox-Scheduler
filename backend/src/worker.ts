import "dotenv/config";
import { Worker, type Job, DelayedError } from "bullmq";
import { prisma } from "./lib/prisma";
import { connection, emailQueue } from "./lib/queue";
import { logger } from "./logger";
import { config, QUEUE_NAME } from "./config";
import { sendMail } from "./lib/mailer";
import {
  tryClaimSendSlot,
  releaseHourlySlots,
  msUntilNextHour,
  shouldAlertRateLimit,
  releaseAlert,
  type LimitReason,
} from "./lib/rateLimiter";
import { notifyRateLimitHit } from "./lib/slack";
import { indexEmail } from "./lib/elasticsearch";

/**
 * Email send worker.
 *
 * - BullMQ delayed jobs drive every send (no cron).
 * - Concurrency is configurable (WORKER_CONCURRENCY).
 * - Redis-backed rate limiting is shared across all worker instances, so
 *   N workers cannot collectively exceed the hourly caps, and the min delay
 *   between sends is a Redis-reserved slot shared by all of them.
 * - The DB row status is the source of truth; a job only sends if the row
 *   is still SCHEDULED/SENDING, guaranteeing at-most-once delivery even if
 *   BullMQ redelivers a job after a crash.
 * - Alert dedupe is Redis-NX (rl:alert:{kind}:{window}:{scope}), so multiple
 *   worker instances produce a single alert per scope per window.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function maybeAlertRateLimit(
  userId: string | null,
  senderEmail: string,
  batchId: string | null | undefined,
  reason: LimitReason,
  jobBatchLimit: number | null | undefined,
  queuedAhead: number
): Promise<void> {
  try {
    // Two independent once-per-window claims: the in-app alert row, and the
    // Slack message. Slack's claim is given back when nothing was delivered
    // (not connected / API error) so connecting Slack mid-window still gets
    // the very next limit hit notified — no redeploy, no waiting an hour.
    const record = await shouldAlertRateLimit(connection, reason, senderEmail, batchId, "app");
    const slack = await shouldAlertRateLimit(connection, reason, senderEmail, batchId, "slack");
    if (!record && !slack) return;

    const delivered = await notifyRateLimitHit(
      userId,
      {
        senderEmail,
        reason,
        limit:
          reason === "global"
            ? config.worker.maxPerHourGlobal
            : reason === "sender"
              ? config.worker.maxPerHourPerSender
              : Number(jobBatchLimit ?? 0),
        windowResetsAtMs: Date.now() + msUntilNextHour(),
        queuedAhead,
      },
      { record, slack }
    );
    if (slack && !delivered) await releaseAlert(connection, reason, senderEmail, batchId, "slack");
  } catch (err) {
    logger.error({ err }, "rate-limit alert failed (non-fatal)");
  }
}

/**
 * Post-send bookkeeping. The SMTP server has ALREADY accepted the message, so a
 * DB hiccup here must never surface as a send failure (that would retry and
 * deliver a duplicate). Retry the write; if it still fails, leave the row in
 * SENDING — the boot-time reconciler promotes SENDING rows whose job completed.
 */
async function markSent(emailRecordId: string, sentAt: Date): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await prisma.scheduledEmail.update({
        where: { id: emailRecordId },
        data: { status: "SENT", sentAt, lastError: null, nextAttemptAt: null },
      });
      return true;
    } catch (err) {
      logger.error({ emailRecordId, attempt, err }, "failed to persist SENT status after delivery");
      await sleep(200 * attempt);
    }
  }
  return false;
}

async function processEmailJob(job: Job, token?: string): Promise<void> {
  const { emailRecordId, senderEmail, recipientEmail, subject, body, userId } = job.data;

  // Idempotency gate: claim the DB row first. If it is not claimable
  // (already SENT / CANCELLED) we simply finish.
  const claim = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
    UPDATE "ScheduledEmail"
    SET status = 'SENDING', "attemptCount" = "attemptCount" + 1, "nextAttemptAt" = NULL, "updatedAt" = now()
    WHERE id = ${emailRecordId} AND status IN ('SCHEDULED', 'SENDING')
    RETURNING id, status
  `;
  if (!claim[0]) {
    logger.info({ jobId: job.id, emailRecordId }, "job skipped — row not claimable (already sent/cancelled)");
    return;
  }

  const row = await prisma.scheduledEmail.findUnique({ where: { id: emailRecordId } });
  if (!row) {
    logger.error({ emailRecordId }, "claimed row vanished — skipping");
    return;
  }

  // Hourly caps: atomically check + claim capacity (and reserve a throttle slot).
  const claimedAtMs = Date.now();
  const slot = await tryClaimSendSlot(connection, senderEmail, row.batchId, row.hourlyLimit);
  if (!slot.allowed) {
    // retryAtMs is an absolute timestamp inside the next hour window (plus this
    // job's ordered position in the overflow queue). Persist it so the UI can
    // show when a parked email will actually attempt to send.
    const resumeAt = Math.max(Date.now() + 1000, slot.retryAtMs + 250);
    await prisma.scheduledEmail.update({
      where: { id: emailRecordId },
      data: {
        status: "SCHEDULED",
        lastError: null,
        nextAttemptAt: new Date(resumeAt),
        attemptCount: { decrement: 1 }, // parking is not a delivery attempt
      },
    });
    // IMPORTANT: DelayedError alone does NOT reschedule anything — BullMQ
    // requires the job to have been moved to the delayed set first, using this
    // run's lock token. Without moveToDelayed the job stays "active" with no
    // owner until the stall checker recovers it (and ignores the target time).
    await job.moveToDelayed(resumeAt, token);
    logger.info(
      { jobId: job.id, reason: slot.reason, resumeAt: new Date(resumeAt).toISOString() },
      "hourly limit hit — job moved to delayed state"
    );
    await maybeAlertRateLimit(userId, senderEmail, row.batchId, slot.reason, row.hourlyLimit, slot.queuedAhead);
    throw new DelayedError(); // BullMQ treats this as "moved", not as a failure
  }

  // Min-delay throttle: we hold a reserved send slot; wait for it.
  if (slot.waitMs > 0) await sleep(slot.waitMs);

  // Re-check after the wait: the user may have cancelled while we slept.
  if (slot.waitMs > 500) {
    const fresh = await prisma.scheduledEmail.findUnique({ where: { id: emailRecordId }, select: { status: true } });
    if (!fresh || fresh.status === "CANCELLED") {
      await releaseHourlySlots(connection, senderEmail, row.batchId, row.hourlyLimit, claimedAtMs).catch(
        () => undefined
      );
      logger.info({ jobId: job.id, emailRecordId }, "job skipped — cancelled while waiting for send slot");
      return;
    }
  }

  let messageId: string;
  let previewUrl: string | null;
  let attachmentCount = 0;
  try {
    // Attachments live in Postgres (one copy per batch; legacy rows may carry
    // a per-email copy). Loaded just-in-time so job payloads stay small.
    const attachmentRows = await prisma.attachment.findMany({
      where: {
        OR: [
          { emailId: emailRecordId },
          ...(row.batchId ? [{ batchId: row.batchId, emailId: null }] : []),
        ],
      },
    });
    attachmentCount = attachmentRows.length;
    ({ messageId, previewUrl } = await sendMail(senderEmail, {
      to: recipientEmail,
      subject,
      text: body,
      html: row.bodyHtml ?? null,
      attachments: attachmentRows.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.data),
        contentType: a.mimetype,
      })),
    }));
  } catch (err) {
    // Failed SMTP attempt: release the rate-limit slots we consumed.
    // If BullMQ will retry, put the row back to SCHEDULED so the claim gate
    // lets the retry through; only mark FAILED on the final attempt.
    await releaseHourlySlots(connection, senderEmail, row.batchId, row.hourlyLimit, claimedAtMs).catch(
      () => undefined
    );
    const message = err instanceof Error ? err.message : String(err);
    const attemptsConfigured = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attemptsConfigured;
    await prisma.scheduledEmail.update({
      where: { id: emailRecordId },
      data: {
        status: isFinalAttempt ? "FAILED" : "SCHEDULED",
        lastError: message.slice(0, 500),
        nextAttemptAt: null,
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
        lastError: message.slice(0, 500),
      }).catch(() => undefined);
    }

    logger.error({ jobId: job.id, isFinalAttempt, err: message }, "smtp send failed");
    throw err; // let BullMQ handle retry/backoff
  }

  // ---- Delivered. Nothing below may throw into the retry path. ----
  const sentAt = new Date();
  const persisted = await markSent(emailRecordId, sentAt);

  // Mirror into Elasticsearch only after the DB commit (best-effort).
  if (persisted) {
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
  }

  logger.info(
    { jobId: job.id, to: recipientEmail, messageId, previewUrl, attachments: attachmentCount, persisted },
    "email sent"
  );
}

export function startWorker(): Worker {
  const worker = new Worker(QUEUE_NAME, processEmailJob, {
    connection,
    concurrency: config.worker.concurrency,
    autorun: true,
    // A send can legitimately sleep for a reserved throttle slot
    // (<= concurrency * minDelay) on top of SMTP time; keep the lock generous so
    // healthy jobs are never mistaken for stalled ones and re-delivered.
    lockDuration: 60_000,
    maxStalledCount: 3,
  });

  worker.on("completed", (job) => logger.debug({ jobId: job.id }, "job completed"));
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "job failed (will retry per backoff)");
    // Stalls (process killed mid-job, event-loop freeze) bypass remaining
    // attempts with UnrecoverableError. The email itself is fine — re-enqueue
    // it so it sends on the next pass instead of lingering forever. The DB
    // claim gate + deterministic job id keep this at-most-once.
    if (job && /stall/i.test(err.message)) {
      void (async () => {
        try {
          const row = await prisma.scheduledEmail.findUnique({ where: { id: job.data.emailRecordId } });
          if (!row || (row.status !== "SCHEDULED" && row.status !== "SENDING")) return;
          await job.remove().catch(() => undefined);
          await emailQueue.add("send", job.data, {
            jobId: job.id,
            delay: 2_000,
            attempts: config.worker.maxAttempts,
            backoff: { type: "fixed", delay: config.worker.backoffMs },
          });
          logger.warn({ jobId: job.id, emailId: row.id }, "stalled job re-enqueued for delivery");
        } catch (requeueErr) {
          logger.error({ jobId: job.id, err: requeueErr }, "failed to re-enqueue stalled job");
        }
      })();
    }
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
        await connection.quit().catch(() => undefined);
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
