import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { config, QUEUE_NAME } from "../src/config";

/**
 * Read-only diagnostic: maps every SCHEDULED/SENDING row to its BullMQ job
 * state, and for delayed (parked) jobs shows the exact promote timestamp.
 * Also flags rows whose job is missing entirely (lost from Redis).
 *
 *   npx tsx scripts/queue-probe.ts
 */

async function main() {
  const prisma = new PrismaClient();
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, { connection });

  try {
    const rows = await prisma.scheduledEmail.findMany({
      where: { status: { in: ["SCHEDULED", "SENDING"] } },
      orderBy: { scheduledAt: "asc" },
      select: { id: true, recipientEmail: true, scheduledAt: true, batchId: true, hourlyLimit: true, attemptCount: true, nextAttemptAt: true },
    });

    const counts = await queue.getJobCounts("waiting", "delayed", "active", "completed", "failed");
    const now = Date.now();
    console.log(`\nnow: ${new Date().toISOString()}`);
    console.log(`queue counts: ${JSON.stringify(counts)}`);
    console.log(`SCHEDULED/SENDING rows: ${rows.length}\n`);

    for (const r of rows) {
      const job = await queue.getJob(`send-${r.id}`);
      if (!job) {
        console.log(
          `MISSING JOB  ${r.recipientEmail.padEnd(28)} scheduledAt=${r.scheduledAt.toISOString()} attempts=${r.attemptCount}`
        );
        continue;
      }
      const state = await job.getState();
      const late = r.scheduledAt.getTime() < now - 60_000;
      const extra =
        state === "delayed" && typeof (job as unknown as { delayedUntil?: number }).delayedUntil === "number"
          ? ` promoteAt=${new Date((job as unknown as { delayedUntil: number }).delayedUntil).toISOString()}`
          : "";
      console.log(
        `${late ? "OVERDUE " : "        "} ${state.padEnd(9)} ${r.recipientEmail.padEnd(28)} scheduledAt=${r.scheduledAt.toISOString()} hourlyLimit=${r.hourlyLimit ?? "-"} attempts=${r.attemptCount}${r.nextAttemptAt ? ` nextAttemptAt=${r.nextAttemptAt.toISOString()}` : ""}${extra}`
      );
    }

    const failed = await queue.getFailed(0, 9);
    if (failed.length) {
      console.log("\nrecent failed jobs:");
      for (const j of failed) {
        console.log(`  ${j.id} ${j.failedReason ?? ""} :: ${(j.stacktrace?.[0] ?? "").slice(0, 120)}`);
      }
    }
  } finally {
    await queue.close();
    await connection.quit().catch(() => undefined);
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
