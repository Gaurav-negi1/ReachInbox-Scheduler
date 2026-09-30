import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { emailQueue } from "../lib/queue";
import { logger } from "../logger";
import { ensureEmailsIndex } from "../lib/elasticsearch";
import { config } from "../config";
import type { ScheduledEmail } from "@prisma/client";
import type { ScheduledEmailDTO } from "../lib/types";

export function toDTO(e: ScheduledEmail): ScheduledEmailDTO {
  return {
    id: e.id,
    senderEmail: e.senderEmail,
    recipientEmail: e.recipientEmail,
    subject: e.subject,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    sentAt: e.sentAt?.toISOString() ?? null,
    nextAttemptAt: e.nextAttemptAt?.toISOString() ?? null,
    attemptCount: e.attemptCount,
    lastError: e.lastError,
    source: e.source,
    batchId: e.batchId,
    hourlyLimit: e.hourlyLimit,
    starred: e.starred,
    bodyHtml: e.bodyHtml ?? null,
  };
}

export type CreateScheduleInput = {
  recipients: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  senderEmail: string;
  startAt: string | Date;
  delaySeconds: number;
  hourlyLimit?: number | null;
  userId: string | null;
  source: "API" | "CSV";
  senderName?: string;
  files?: { filename: string; mimetype: string; size: number; data: Buffer }[];
};

const MAX_BATCH = 10_000;

export type ScheduleResult = {
  batchId: string;
  created: number;
  skipped: number;
  earliestScheduledAt: string;
};

function validate(input: CreateScheduleInput): void {
  const issues: string[] = [];
  if (!input.recipients?.length) issues.push("recipients must not be empty");
  if (input.recipients.length > MAX_BATCH) issues.push(`recipients exceeds max batch size of ${MAX_BATCH}`);
  if (!input.subject?.trim()) issues.push("subject is required");
  if (!input.body?.trim()) issues.push("body is required");
  if (Number.isNaN(new Date(input.startAt).getTime())) issues.push("startAt must be a valid ISO date");
  if (!Number.isFinite(input.delaySeconds) || input.delaySeconds < 0) {
    issues.push("delaySeconds must be >= 0");
  }
  if (
    input.hourlyLimit !== undefined &&
    input.hourlyLimit !== null &&
    (!Number.isInteger(input.hourlyLimit) || input.hourlyLimit < 1)
  ) {
    issues.push("hourlyLimit must be a positive integer or null");
  }
  if (issues.length) throw new Error(issues.join("; "));
}

export const ScheduleService = {
  /**
   * Create one DB row per recipient plus one BullMQ delayed job per email.
   * All rows share a batchId. Per-recipient scheduledAt offsets preserve
   * ordering; the worker additionally enforces the minimum send delay and
   * hourly caps via Redis, pushing overflow into the next hour window.
   */
  async schedule(input: CreateScheduleInput): Promise<ScheduleResult> {
    validate(input);
    await ensureEmailsIndex();

    const startAt = new Date(input.startAt);
    const batchId = randomUUID();

    // Resolve or auto-create the sender with fresh Ethereal SMTP credentials.
    let sender = await prisma.emailSender.findUnique({ where: { email: input.senderEmail } });
    if (!sender) {
      const { createEtherealAccount } = await import("../lib/mailer");
      const acct = await createEtherealAccount(input.senderName);
      sender = await prisma.emailSender.create({
        data: {
          email: input.senderEmail,
          name: input.senderName ?? "ReachInbox Sender",
          userId: input.userId,
          smtpUser: acct.user,
          smtpPass: acct.pass,
        },
      });
      logger.info({ sender: sender.email }, "created new Ethereal sender account");
    }

    const rows = input.recipients.map((recipientEmail, i) => ({
      senderEmail: input.senderEmail,
      recipientEmail,
      subject: input.subject,
      body: input.body,
      bodyHtml: input.bodyHtml ?? null,
      status: "SCHEDULED" as const,
      scheduledAt: new Date(startAt.getTime() + i * input.delaySeconds * 1000),
      source: input.source,
      hourlyLimit: input.hourlyLimit ?? null,
      batchId,
      userId: input.userId,
    }));

    // skipDuplicates makes re-submission of the same batch idempotent at the
    // DB level (unique on sender+recipient+subject+scheduledAt).
    const result = await prisma.scheduledEmail.createMany({ data: rows, skipDuplicates: true });

    // Read back what actually landed so job payloads match DB rows 1:1.
    const inserted = await prisma.scheduledEmail.findMany({
      where: { batchId },
      orderBy: { scheduledAt: "asc" },
    });

    // Persist uploaded attachments per inserted email (files are shared by the
    // whole batch; each row gets its own copy so SMTP sends are independent).
    if (input.files?.length) {
      await prisma.attachment.createMany({
        data: inserted.flatMap((row) =>
          input.files!.map((f) => ({
            emailId: row.id,
            batchId,
            filename: f.filename.slice(0, 255),
            mimetype: f.mimetype || "application/octet-stream",
            size: f.size,
            data: Uint8Array.from(f.data),
          }))
        ),
      });
      logger.info({ batchId, files: input.files.length, emails: inserted.length }, "attachments stored");
    }

    // Index SCHEDULED rows into Elasticsearch immediately so scheduled and
    // sent emails are both searchable. The Sent tab filters by status, so
    // these docs only surface in scheduled search.
    // Best-effort: ES being down never blocks scheduling (Postgres is truth).
    const { indexEmail } = await import("../lib/elasticsearch");
    await Promise.allSettled(
      inserted.map((row) =>
        indexEmail({
          id: row.id,
          userId: row.userId,
          senderEmail: row.senderEmail,
          recipientEmail: row.recipientEmail,
          subject: row.subject,
          body: row.body,
          status: row.status,
          scheduledAt: row.scheduledAt,
          starred: row.starred,
          sentAt: null,
          batchId: row.batchId,
        }).catch(() => undefined)
      )
    );

    if (result.count < rows.length) {
      logger.warn(
        { batchId, requested: rows.length, created: result.count },
        "duplicate recipients skipped (idempotent re-submit)"
      );
    }

    await Promise.all(
      inserted.map((row) =>
        emailQueue.add(
          "send",
          {
            emailRecordId: row.id,
            senderEmail: row.senderEmail,
            recipientEmail: row.recipientEmail,
            subject: row.subject,
            body: row.body,
            batchId: row.batchId,
            userId: row.userId,
          },
          {
            // Deterministic job id = idempotency: re-adding an existing job
            // id is a no-op in BullMQ, so restarts/re-submits never duplicate.
            jobId: `send-${row.id}`,
            delay: Math.max(0, row.scheduledAt.getTime() - Date.now()),
            attempts: config.worker.maxAttempts,
            backoff: { type: "fixed", delay: config.worker.backoffMs },
          }
        )
      )
    );

    return {
      batchId,
      created: result.count,
      skipped: rows.length - result.count,
      earliestScheduledAt: (inserted[0]?.scheduledAt ?? startAt).toISOString(),
    };
  },

  /** Cancel a still-scheduled email: flip DB status and drop the Bull job. */
  async cancel(id: string, userId: string | null): Promise<boolean> {
    const row = await prisma.scheduledEmail.findUnique({ where: { id } });
    if (!row || row.status !== "SCHEDULED") return false;
    if (userId && row.userId && row.userId !== userId) return false;

    await prisma.scheduledEmail.update({ where: { id }, data: { status: "CANCELLED" } });
    const job = await emailQueue.getJob(`send-${id}`);
    if (job) await job.remove().catch(() => undefined);

    // Keep the ES doc in sync so a cancelled email no longer reads SCHEDULED.
    const { indexEmail } = await import("../lib/elasticsearch");
    await indexEmail({
      id: row.id,
      userId: row.userId,
      senderEmail: row.senderEmail,
      recipientEmail: row.recipientEmail,
      subject: row.subject,
      body: row.body,
      status: "CANCELLED",
      scheduledAt: row.scheduledAt,
      sentAt: null,
      batchId: row.batchId,
    }).catch(() => undefined);
    return true;
  },
};
