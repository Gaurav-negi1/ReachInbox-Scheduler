import { Router } from "express";
import multer from "multer";
import { prisma } from "../lib/prisma";
import { toDTO, ScheduleService } from "../services/scheduleService";
import { requireAuth } from "../middleware/auth";
import { logger } from "../logger";
import type { EmailDoc } from "../lib/elasticsearch";
import { esAvailable } from "../lib/elasticsearch";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Attachments (compose uploads) ---------------------------------------
// Stored in Postgres (Bytes), shared per batch, attached to every SMTP send.
const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES },
});

type UploadedFile = { filename: string; mimetype: string; size: number; data: Buffer };
type AttachmentSummary = { id: string; filename: string; mimetype: string; size: number };

/**
 * POST /api/emails/schedule
 * Accepts multipart/form-data (field `payload` = JSON string, `attachments` =
 * files, per the Compose UI) or plain JSON. Validation is identical either way;
 * the server re-validates every recipient regardless of client-side parsing.
 */
router.post("/schedule", requireAuth, (req, res) => {
  const isMultipart = (req.headers["content-type"] ?? "").includes("multipart/form-data");

  const handle = (body: Record<string, unknown>, files: UploadedFile[]) => {
    const {
      recipients,
      subject,
      body: bodyText,
      bodyHtml,
      senderEmail,
      senderName,
      startAt,
      delaySeconds = 0,
      hourlyLimit = null,
    } = body as Record<string, string | string[] | number | null | undefined>;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients must be a non-empty array of email addresses" });
    }
    const valid = [...new Set(recipients.map((r: string) => String(r).trim().toLowerCase()))].filter((r: string) =>
      EMAIL_RE.test(r)
    );
    if (valid.length === 0) {
      return res.status(400).json({ error: "no valid email addresses in recipients" });
    }
    const trimmedSender = String(senderEmail ?? "").trim();
    if (!trimmedSender || !EMAIL_RE.test(trimmedSender)) {
      return res.status(400).json({ error: "senderEmail must be a valid email address" });
    }

    ScheduleService.schedule({
      recipients: valid,
      subject: String(subject ?? ""),
      body: String(bodyText ?? ""),
      bodyHtml: bodyHtml ? String(bodyHtml) : null,
      senderEmail: trimmedSender.toLowerCase(),
      senderName: senderName ? String(senderName) : undefined,
      startAt: (startAt ?? "") as string | Date,
      delaySeconds: Number(delaySeconds) || 0,
      hourlyLimit:
        hourlyLimit === null || hourlyLimit === undefined || hourlyLimit === ""
          ? null
          : Number(hourlyLimit),
      userId: req.user!.id,
      source: "API",
      files,
    })
      .then((result) => res.status(201).json(result))
      .catch((err) => {
        logger.error({ err }, "schedule request failed");
        const message = err instanceof Error ? err.message : "failed to schedule emails";
        res.status(400).json({ error: message });
      });
  };

  if (isMultipart) {
    upload.array("attachments", MAX_FILES)(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        const message =
          code === "LIMIT_FILE_SIZE"
            ? `Each attachment must be under ${MAX_FILE_BYTES / (1024 * 1024)} MB`
            : code === "LIMIT_FILE_COUNT"
              ? `You can attach up to ${MAX_FILES} files`
              : "Attachment upload failed";
        return res.status(400).json({ error: message });
      }
      const files = ((req.files as Express.Multer.File[]) ?? []).map((f) => ({
        filename: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        data: f.buffer,
      }));
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String((req.body as { payload?: string }).payload ?? "{}"));
      } catch {
        return res.status(400).json({ error: "payload must be a JSON string" });
      }
      return handle(payload, files);
    });
  } else {
    handle(req.body as Record<string, unknown>, []);
  }
});

const SENT_STATUSES = ["SENT", "FAILED"] as ("SENT" | "FAILED")[];

/** `filter` query param shared by both list endpoints: all | starred | failed. */
function parseFilter(v: unknown): "all" | "starred" | "failed" {
  return v === "starred" || v === "failed" ? v : "all";
}

/** Batch-shared attachment summaries for a set of emails (batchId -> files). */
async function attachmentSummaries(
  rows: { id: string; batchId: string | null }[]
): Promise<Map<string, AttachmentSummary[]>> {
  const byEmail = new Map<string, AttachmentSummary[]>();
  const batchIds = [...new Set(rows.map((r) => r.batchId).filter((b): b is string => !!b))];
  if (!batchIds.length) return byEmail;
  const atts = await prisma.attachment.findMany({
    where: { batchId: { in: batchIds }, emailId: { not: null } },
    select: { id: true, emailId: true, filename: true, mimetype: true, size: true },
    distinct: ["emailId", "filename"],
  });
  for (const a of atts) {
    if (!a.emailId) continue;
    const list = byEmail.get(a.emailId) ?? [];
    list.push({ id: a.id, filename: a.filename, mimetype: a.mimetype, size: a.size });
    byEmail.set(a.emailId, list);
  }
  return byEmail;
}

/** GET /api/emails/scheduled?search=&filter=&page=&pageSize= — DB-backed list with search. */
router.get("/scheduled", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  const search = (req.query.search as string | undefined)?.trim();
  const filter = parseFilter(req.query.filter);

  const where = {
    status: filter === "failed" ? ("FAILED" as const) : ("SCHEDULED" as const),
    ...(filter === "starred" ? { starred: true } : {}),
    OR: [{ userId: null }, { userId }],
    ...(search
      ? {
          AND: [
            {
              OR: [
                { recipientEmail: { contains: search, mode: "insensitive" as const } },
                { subject: { contains: search, mode: "insensitive" as const } },
              ],
            },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.scheduledEmail.count({ where }),
    prisma.scheduledEmail.findMany({
      where,
      orderBy: { scheduledAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const atts = await attachmentSummaries(rows);

  res.json({
    total,
    page,
    pageSize,
    items: rows.map((r) => ({ ...toDTO(r), attachments: atts.get(r.id) ?? [] })),
  });
});

/** GET /api/emails/sent?search=&filter=&page=&pageSize= — Elasticsearch-backed search. */
router.get("/sent", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  const search = (req.query.search as string | undefined)?.trim();
  const filter = parseFilter(req.query.filter);

  // Elasticsearch is a best-effort layer: while the circuit breaker reports it
  // down, skip straight to the Postgres fallback (fast, no error noise).
  if (esAvailable()) {
    try {
      const { searchEmails } = await import("../lib/elasticsearch");
      const result = await searchEmails({
        userId,
        query: search,
        status: filter === "failed" ? ["FAILED"] : SENT_STATUSES,
        starred: filter === "starred" ? true : undefined,
        page,
        pageSize,
      });
      const items: EmailDoc[] = result.items;
      // ES docs carry no attachment rows; look up summaries per doc id.
      const emailRows = items.map((i) => ({ id: i.id, batchId: i.batchId ?? null }));
      const atts = await attachmentSummaries(emailRows);
      res.json({
        total: result.total,
        page,
        pageSize,
        items: items.map((i) => ({ ...i, attachments: atts.get(i.id) ?? [] })),
      });
      return;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "elasticsearch search failed — falling back to Postgres");
    }
  }
  // Postgres fallback: Postgres is the source of truth, so the list still
  // works (with `degraded: true` so the client can badge it) whenever ES is
  // unreachable or returns an error.
  {
    const where = {
      status: { in: filter === "failed" ? (["FAILED"] as ("SENT" | "FAILED")[]) : SENT_STATUSES },
      ...(filter === "starred" ? { starred: true } : {}),
      OR: [{ userId: null }, { userId }],
    };
    const [total, rows] = await Promise.all([
      prisma.scheduledEmail.count({ where }),
      prisma.scheduledEmail.findMany({
        where,
        orderBy: { sentAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const atts = await attachmentSummaries(rows);
    res.json({
      total,
      page,
      pageSize,
      items: rows.map((r) => ({ ...toDTO(r), attachments: atts.get(r.id) ?? [] })),
      degraded: true,
    });
  }
});

/** GET /api/emails/senders — distinct sender identities available for "From". */
router.get("/senders", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const senders = await prisma.emailSender.findMany({
    where: { OR: [{ userId }, { userId: null }], active: true },
    orderBy: { createdAt: "asc" },
    select: { email: true, name: true },
  });
  res.json({ items: senders });
});

/** GET /api/emails/:id — single email detail (scheduled or sent). */
router.get("/:id", requireAuth, async (req, res) => {
  const row = await prisma.scheduledEmail.findUnique({
    where: { id: req.params.id },
    include: { attachments: { select: { id: true, filename: true, mimetype: true, size: true } } },
  });
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.userId && row.userId !== req.user!.id) return res.status(403).json({ error: "forbidden" });
  res.json({ ...toDTO(row), attachments: row.attachments });
});

/** PATCH /api/emails/:id/star — toggle the star flag. */
router.patch("/:id/star", requireAuth, async (req, res) => {
  const row = await prisma.scheduledEmail.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.userId && row.userId !== req.user!.id) return res.status(403).json({ error: "forbidden" });

  const starred = Boolean((req.body as { starred?: boolean })?.starred);
  const updated = await prisma.scheduledEmail.update({
    where: { id: row.id },
    data: { starred },
  });

  // Keep the ES doc in sync (search must never break the UI on ES failure).
  const { indexEmail } = await import("../lib/elasticsearch");
  await indexEmail({
    id: updated.id,
    userId: updated.userId,
    senderEmail: updated.senderEmail,
    recipientEmail: updated.recipientEmail,
    subject: updated.subject,
    body: updated.body,
    status: updated.status,
    scheduledAt: updated.scheduledAt,
    sentAt: updated.sentAt,
    batchId: updated.batchId,
    starred: updated.starred,
    lastError: updated.lastError,
  }).catch(() => undefined);

  res.json({ id: updated.id, starred: updated.starred });
});

/** GET /api/emails/:id/attachments/:attachmentId — download one attachment. */
router.get("/:id/attachments/:attachmentId", requireAuth, async (req, res) => {
  const email = await prisma.scheduledEmail.findUnique({ where: { id: req.params.id } });
  if (!email) return res.status(404).json({ error: "not found" });
  if (email.userId && email.userId !== req.user!.id) return res.status(403).json({ error: "forbidden" });

  const att = await prisma.attachment.findUnique({ where: { id: req.params.attachmentId } });
  if (!att || att.emailId !== email.id) return res.status(404).json({ error: "attachment not found" });

  res.setHeader("Content-Type", att.mimetype || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${att.filename.replace(/"/g, "")}"`);
  res.setHeader("Content-Length", String(att.size));
  res.end(Buffer.from(att.data));
});

/** POST /api/emails/:id/cancel — cancel a scheduled email. */
router.post("/:id/cancel", requireAuth, async (req, res) => {
  const ok = await ScheduleService.cancel(req.params.id, req.user!.id);
  if (!ok) return res.status(400).json({ error: "cannot cancel (not found, not scheduled, or not yours)" });
  res.json({ ok: true });
});

export default router;
