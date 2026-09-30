import { Router } from "express";
import { connection, emailQueue } from "../lib/queue";
import { getRateLimitSnapshot } from "../lib/rateLimiter";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { config } from "../config";

const router = Router();

router.use(requireAuth);

router.get("/rate-limit", async (_req, res) => {
  const snapshot = await getRateLimitSnapshot(connection);
  res.json(snapshot);
});

router.get("/worker", async (_req, res) => {
  res.json({
    concurrency: config.worker.concurrency,
    minSendDelaySeconds: config.worker.minSendDelaySeconds,
    maxPerHourGlobal: config.worker.maxPerHourGlobal,
    maxPerHourPerSender: config.worker.maxPerHourPerSender,
  });
});

router.get("/queue", async (_req, res) => {
  const counts = await emailQueue.getJobCounts("waiting", "delayed", "active", "completed", "failed");
  res.json(counts);
});

/**
 * GET /api/stats/alerts — recent in-app rate-limit alerts for the bell feed.
 * Newer than `since` (epoch ms) are "unread"; the client passes its last-seen
 * timestamp to compute the badge. Latest 50 are returned.
 */
router.get("/alerts", async (req, res) => {
  const sinceMs = Number(req.query.since ?? 0);
  const rows = await prisma.rateLimitAlert.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({
    unread: sinceMs > 0 ? rows.filter((r) => r.createdAt.getTime() > sinceMs).length : rows.length,
    items: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      scope: r.scope,
      limit: r.limit,
      queuedAhead: r.queuedAhead,
      slackSent: r.slackSent,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

export default router;
