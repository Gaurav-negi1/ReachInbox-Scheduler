import { prisma } from "./prisma";
import { emailQueue } from "./queue";
import { logger } from "../logger";
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
      lastError: lastError ?? null,
    });
  } catch {
    // Search is best-effort; Postgres remains the source of truth.
  }
}

/**
 * Crash-recovery reconciler (runs once at boot; not a cron).
 *
 * Two failure modes after a crash are repaired here:
 *  1. Row stuck in SENDING  -> the process died after claiming but before the
 *     final DB write. Reconcile from the Bull job's true state if it exists.
 *  2. Row SCHEDULED but its Bull job is gone (enqueue failed, job TTL'd out,
 *     or Redis flushed) and it is now overdue -> re-enqueue it.
 *
 * Jobs carry deterministic ids (`send-<rowId>`), so re-adding can never
 * produce duplicate sends: BullMQ treats an existing id as the same job.
 */
export async function startStaleReaper(): Promise<void> {
  try {
    // --- Mode 1: orphaned SENDING rows -----------------------------------
    const sending = await prisma.scheduledEmail.findMany({
      where: { status: "SENDING", sentAt: null },
    });

    for (const row of sending) {
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
          continue;
        }
        if (state === "active" || state === "delayed" || state === "waiting") {
          await prisma.scheduledEmail.update({
            where: { id: row.id },
            data: { status: "SCHEDULED" },
          });
          logger.info({ emailId: row.id }, "reset SENDING row whose job is still pending");
          continue;
        }
      }
      // No live job -> reschedule this row.
      await rescheduleRow(row.id);
    }

    // --- Mode 2: overdue SCHEDULED rows with no live job ------------------
    const cutoff = new Date(Date.now() - 60_000); // 1 min grace
    const overdue = await prisma.scheduledEmail.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: cutoff } },
    });

    for (const row of overdue) {
      const job = await emailQueue.getJob(`send-${row.id}`);
      if (!job) {
        await rescheduleRow(row.id);
      } else {
        const state = await job.getState();
        if (state === "completed") {
          // Job terminal but row still SCHEDULED: sync from job outcome.
          await prisma.scheduledEmail.update({
            where: { id: row.id },
            data: { status: "SENT", sentAt: new Date() },
          });
          await syncDoc(row, "SENT");
        } else if (state === "failed") {
          // Job exhausted its attempts — reflect that in the row.
          const reason = job.failedReason ?? "exhausted retries";
          await prisma.scheduledEmail.update({
            where: { id: row.id },
            data: { status: "FAILED", lastError: reason.slice(0, 500) },
          });
          await syncDoc(row, "FAILED", reason);
        }
        // 'waiting'/'delayed'/'active' jobs are fine — the worker owns them.
      }
    }
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
  await emailQueue.add("send", data, {
    jobId: `send-${row.id}`,
    delay: 1000,
    attempts: 3,
    backoff: { type: "fixed", delay: 5000 },
  });
  logger.warn({ emailId: row.id }, "re-queued orphaned scheduled email");
}
