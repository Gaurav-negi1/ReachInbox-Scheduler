import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { config, QUEUE_NAME } from "../config";
import { logger } from "../logger";
import type { EmailJobData } from "./types";

// BullMQ requires maxRetriesPerRequest: null for blocking connections (workers).
const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue<EmailJobData>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: config.worker.maxAttempts,
    backoff: { type: "fixed", delay: config.worker.backoffMs },
    removeOnComplete: { age: config.worker.jobRetentionMs, count: 5000 },
    removeOnFail: { age: config.worker.jobRetentionMs },
  },
});

export async function connectRedis(): Promise<void> {
  const ping = await connection.ping();
  logger.info({ ping }, "redis connected");
}

export { connection };
export type { ConnectionOptions };
