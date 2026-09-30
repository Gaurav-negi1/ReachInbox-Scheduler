import { prisma } from "./prisma";
import { emailQueue } from "./queue";
import { logger } from "../logger";
import { config } from "../config";
import type { EmailJobData } from "./types";
import { indexEmail } from "./elasticsearch";
import type { ScheduledEmail } from "@prisma/client";

/** Mirror a reconciled terminal status into Elasticsearch (best-effort). */
async function syncDoc(row: ScheduledEmail, status: "SENT" | "FAILED", lastError?: string | null): Promise<void> {
  try {
    await indexEmail({
      id: row.id,
      userId: row.userId,
      senderEmail: row.senderEmail,
      recipientEmail: row.recipientEmail,
      subject: row.subject,
      body: row.body,
      status,
      scheduledAt: row.scheduledAt,
      sentAt: status === "SENT" ? new Date() : null,
      batchId: row.batchId,
      starred: row.starred,
      lastError: lastError ?? null,
    });
  } catch {
    // Search is best-effort; Postgres remains the source of truth.
  }
}

const PAGE = 500;
const CONCURRENCY = 25;

/** Run `fn` over items with bounded parallelism. */
async function forEachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
  }
}

/**
 * Crash-recovery reconciler (runs once at boot; not a cron).
 *
 * Failure modes after a crash / Redis loss that are repaired here:
 *  1. Row stuck in SENDING  -> the process died after claiming but before the
 *     final DB write. Reconcile from the Bull job's true state if it exists.
 *  2. Row SCHEDULED but its Bull job is gone (enqueue failed mid-batch, job
 *     TTL'd out, or Redis flushed) -> re-enqueue it for its ORIGINAL time
 *     (not only when overdue: a flushed Redis would otherwise silently lose
 *     every future email until it was already late).
 *  3. Row SCHEDULED but its job terminally failed/stalled -> re-enqueue (stall)
 *     or mirror the failure.
 *
 * Jobs carry deterministic ids (`send-<rowId>`), so re-adding can never
 * produce duplicate sends. The DB claim gate in the worker is the last line
 * of defence.
 */
export async function startStaleReaper(): Promise<void> {
  try {
    // --- Mode 1: orphaned SENDING rows -----------------------------------
    const sending = await prisma.scheduledEmail.findMany({
      where: { status: "SENDING", sentAt: null },
    });

    await forEachLimited(sending, async (row) => {
      const job = await emailQueue.getJob(`send-${row.id}`);
      if (job) {
        const state = await job.getState();
        if (state === "completed") {
          await prisma.scheduledEmail.update({
            where: { id: row.id },
            data: { status: "SENT", sentAt: new Date() },
          });
          await syncDoc(row, "SENT");
          logger.warn({ emailId: row.id }, "reconciled SENDING row to SENT from completed job");
          return;
        }
        if (state === "active" || state === "delayed" || state === "waiting" || state === "prioritized") {
          await prisma.scheduledEmail.update({
            where: { id: row.id },
            data: { status: "SCHEDULED" },
          });
          logger.info({ emailId: row.id }, "reset SENDING row whose job is still pending");
          return;
        }
      }
      // No live job (missing, or failed/stalled out) -> reschedule this row.
      await rescheduleRow(row.id);
    });

    // --- Mode 2/3: SCHEDULED rows whose job is missing or terminal --------
    let cursor: string | undefined;
    let repaired = 0;
    for (;;) {
      const page = await prisma.scheduledEmail.findMany({
        where: { status: "SCHEDULED" },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!page.length) break;
      cursor = page[page.length - 1].id;

      await forEachLimited(page, async (row) => {
        const job = await emailQueue.getJob(`send-${row.id}`);
        if (!job) {
          await rescheduleRow(row.id);
          repaired++;
          return;
        }
        const state = await job.getState();
        if (state === "completed") {
          // Job terminal but row still SCHEDULED: the send happened.
          await prisma.scheduledEmail.update({
            where: { id: row.id },
            data: { status: "SENT", sentAt: new Date() },
          });
          await syncDoc(row, "SENT");
          repaired++;
        } else if (state === "failed") {
          const reason = job.failedReason ?? "exhausted retries";
          if (/stall/i.test(reason)) {
            // A stall is infrastructure, not a delivery failure — try again.
            await rescheduleRow(row.id);
          } else {
            await prisma.scheduledEmail.update({
              where: { id: row.id },
              data: { status: "FAILED", lastError: reason.slice(0, 500) },
            });
            await syncDoc(row, "FAILED", reason);
          }
          repaired++;
        }
        // 'waiting'/'delayed'/'active' jobs are fine — the worker owns them.
      });
    }
    if (repaired) logger.warn({ repaired }, "stale reaper repaired scheduled rows");
  } catch (err) {
    logger.error({ err }, "stale reaper failed");
  }
}

async function rescheduleRow(rowId: string): Promise<void> {
  const row = await prisma.scheduledEmail.findUnique({ where: { id: rowId } });
  if (!row) return;

  await prisma.scheduledEmail.update({
    where: { id: row.id },
    data: { status: "SCHEDULED" },
  });

  const data: EmailJobData = {
    emailRecordId: row.id,
    senderEmail: row.senderEmail,
    recipientEmail: row.recipientEmail,
    subject: row.subject,
    body: row.body,
    batchId: row.batchId,
    userId: row.userId,
  };

  // BullMQ ignores add() when a job with the same id still exists in ANY state
  // (including failed / completed-but-retained), so drop a dead one first.
  // Never touch a job that is currently active.
  const existing = await emailQueue.getJob(`send-${row.id}`);
  if (existing) {
    const state = await existing.getState();
    if (state === "active") return;
    await existing.remove().catch(() => undefined);
  }

  // Keep the original target time (or the parked resume time) so future emails
  // still go out when scheduled; overdue ones go out almost immediately.
  const target = Math.max(row.scheduledAt.getTime(), row.nextAttemptAt?.getTime() ?? 0);
  await emailQueue.add("send", data, {
    jobId: `send-${row.id}`,
    delay: Math.max(1000, target - Date.now()),
    attempts: config.worker.maxAttempts,
    backoff: { type: "fixed", delay: config.worker.backoffMs },
  });
  logger.warn({ emailId: row.id }, "re-queued orphaned scheduled email");
}
