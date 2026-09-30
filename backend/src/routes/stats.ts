import { Router } from "express";
import { connection, emailQueue } from "../lib/queue";
import { getRateLimitSnapshot } from "../lib/rateLimiter";
import { requireAuth } from "../middleware/auth";
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

export default router;
