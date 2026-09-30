import { prisma } from "./prisma";
import { logger } from "../logger";
import { bulkIndexEmails, ensureEmailsIndex, esAvailable, type EmailDoc } from "./elasticsearch";

/**
 * Boot-time resync of recently-changed rows from Postgres (source of truth)
 * into Elasticsearch. Indexing is best-effort at write time, so an email sent
 * while ES was down would otherwise read SCHEDULED (or be missing) in the search
 * index forever and never show up in the Sent tab once ES came back.
 * Idempotent (documents are keyed by row id). Runs once; not a cron.
 */
export async function resyncSearchIndex(lookbackMs = 7 * 24 * 3600 * 1000): Promise<void> {
  await ensureEmailsIndex();
  if (!esAvailable()) return;

  const since = new Date(Date.now() - lookbackMs);
  const PAGE = 500;
  let cursor: string | undefined;
  let total = 0;

  for (;;) {
    const rows = await prisma.scheduledEmail.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    total += rows.length;

    const docs: EmailDoc[] = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      senderEmail: r.senderEmail,
      recipientEmail: r.recipientEmail,
      subject: r.subject,
      body: r.body,
      status: r.status,
      scheduledAt: r.scheduledAt,
      sentAt: r.sentAt,
      batchId: r.batchId,
      starred: r.starred,
      lastError: r.lastError,
    }));
    await bulkIndexEmails(docs);
    if (!esAvailable()) break;
  }
  if (total) logger.info({ total }, "search index resynced from Postgres");
}
