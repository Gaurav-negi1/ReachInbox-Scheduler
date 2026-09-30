import "dotenv/config";
import http from "http";
import { createApp } from "./app";
import { logger } from "./logger";
import { config } from "./config";
import { prisma } from "./lib/prisma";
import { connectRedis, emailQueue, connection } from "./lib/queue";
import { ensureEmailsIndex } from "./lib/elasticsearch";
import { startWorker } from "./worker";
import { startStaleReaper } from "./lib/staleReaper";
import { resyncSearchIndex } from "./lib/searchSync";

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  logger.info("postgres reachable");

  await connectRedis();

  try {
    await ensureEmailsIndex();
    logger.info("elasticsearch ready");
  } catch (err) {
    logger.warn({ err }, "elasticsearch unavailable — sent-email search will fall back to Postgres");
  }

  // API and worker run in one process for simple deploys; startWorker() can be
  // lifted into a separate process via `npm run worker` without code changes —
  // BullMQ + Redis are shared either way.
  const worker = startWorker();
  // Boot-time repairs (run once, not a cron): re-enqueue lost jobs / reconcile
  // half-finished sends, then resync the search index from Postgres.
  void startStaleReaper()
    .then(() => resyncSearchIndex())
    .catch((err) => logger.error({ err }, "boot reconciliation failed"));

  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.port, () => {
    logger.info(`API listening on http://localhost:${config.port}`);
    logger.info(`Bull Board: http://localhost:${config.port}/admin/queues`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down...");
    // Hard stop if something hangs, so a deploy/restart is never wedged.
    setTimeout(() => process.exit(1), 30_000).unref();
    server.close();
    // Let in-flight sends finish BEFORE closing Redis/Prisma underneath them.
    // Killing a send mid-flight would leave its row in SENDING and its job
    // stalled, and is the main way a restart could re-deliver an email.
    await worker.close().catch((err) => logger.error({ err }, "worker close failed"));
    await emailQueue.close();
    await connection.quit().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Express 4 does not catch rejections from async handlers; never let a stray
// rejection take the API *and* the embedded worker down.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});

void main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
