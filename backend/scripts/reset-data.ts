import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { config, QUEUE_NAME } from "../src/config";

/**
 * Wipes demo data: scheduled/sent emails, attachments, rate-limit alerts, all
 * BullMQ queue state and Redis rate-limit windows. Users, senders and Slack
 * connections are kept unless --all is passed.
 *
 *   npm run reset-data            # keep users/senders/Slack
 *   npm run reset-data -- --all   # also wipe users + senders
 *   npm run reset-data -- --dry-run
 *
 * Works against whatever DATABASE_URL / REDIS_URL point at (local compose or
 * the Render add-ons via the Render Shell).
 */

async function delPattern(redis: IORedis, pattern: string): Promise<number> {
  let cursor = "0";
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== "0");
  return deleted;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const wipeAll = args.has("--all");
  const dryRun = args.has("--dry-run");

  const prisma = new PrismaClient();
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  try {
    const emails = await prisma.scheduledEmail.count();
    const attachments = await prisma.attachment.count();
    const alerts = await prisma.rateLimitAlert.count();
    console.log(
      `Found: ${emails} scheduled/sent emails, ${attachments} attachment rows, ${alerts} rate-limit alerts.`
    );
    if (dryRun) {
      console.log("Dry run — nothing deleted.");
      return;
    }

    // Rows first: a reaper pass or in-flight job can only observe empty
    // tables, never half-deleted state. Queue history goes afterwards.
    const delAlerts = await prisma.rateLimitAlert.deleteMany({});
    const delAtts = await prisma.attachment.deleteMany({});
    const delEmails = await prisma.scheduledEmail.deleteMany({});
    console.log(
      `Deleted: ${delEmails.count} emails, ${delAtts.count} attachments, ${delAlerts.count} alerts.`
    );

    if (wipeAll) {
      const delSenders = await prisma.emailSender.deleteMany({});
      const delUsers = await prisma.user.deleteMany({});
      console.log(`Deleted: ${delUsers.count} users, ${delSenders.count} senders.`);
    }

    // Drop every BullMQ job (waiting/delayed/active/completed/failed) for the
    // queue, then clear rate-limit + alert-dedupe windows so caps restart.
    const queue = new Queue(QUEUE_NAME, { connection });
    await queue.obliterate({ force: true });
    await queue.close();
    const rlKeys = await delPattern(connection, "rl:*");
    console.log(`Queue obliterated; ${rlKeys} Redis rate-limit keys cleared.`);
    console.log("Done — the scheduler is a clean slate (resend the leads CSV to test again).");
  } finally {
    await connection.quit().catch(() => undefined);
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error("reset-data failed:", err);
  process.exit(1);
});
