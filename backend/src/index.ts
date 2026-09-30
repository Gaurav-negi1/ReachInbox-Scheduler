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
  startWorker();
  startStaleReaper();

  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.port, () => {
    logger.info(`API listening on http://localhost:${config.port}`);
    logger.info(`Bull Board: http://localhost:${config.port}/admin/queues`);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down...");
    server.close();
    await emailQueue.close();
    await connection.quit().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
