import "dotenv/config";
import { ScheduleService } from "../src/services/scheduleService";
import { prisma } from "../src/lib/prisma";
import { emailQueue, connection } from "../src/lib/queue";

/**
 * Controlled experiment: 4 recipients, hourly limit 2 → 2 send immediately,
 * 2 must park into the next top-of-hour window and auto-send when it opens.
 *
 *   npx tsx scripts/exp-promotion.ts
 */

async function main() {
  const startAt = new Date(Date.now() + 15_000);
  const r = await ScheduleService.schedule({
    recipients: ["exp.a@example.com", "exp.b@example.com", "exp.c@example.com", "exp.d@example.com"],
    subject: "promotion-experiment",
    body: "verify delayed-job promotion across the hourly window",
    senderEmail: "outreach@reachinbox.test",
    startAt,
    delaySeconds: 1,
    hourlyLimit: 2,
    userId: null,
    source: "API",
  });
  console.log("scheduled batch", r.batchId);
  console.log("startAt:", r.earliestScheduledAt, "(limit=2 → exp.a/exp.b now, exp.c/exp.d parked to next window)");

  // Watch states for up to 3 minutes.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 10_000));
    const rows = await prisma.scheduledEmail.findMany({ where: { batchId: r.batchId }, orderBy: { scheduledAt: "asc" } });
    const summary = rows
      .map((x) => `${x.recipientEmail.slice(4, 5)}:${x.status}${x.sentAt ? "@" + x.sentAt.toISOString().slice(11, 19) : ""}`)
      .join("  ");
    const counts = await emailQueue.getJobCounts("delayed", "completed", "failed");
    console.log(new Date().toISOString().slice(11, 19), `| ${summary} | delayed=${counts.delayed} done=${counts.completed} fail=${counts.failed}`);
    if (rows.every((x) => x.status === "SENT" || x.status === "FAILED")) break;
  }
  const final = await prisma.scheduledEmail.findMany({ where: { batchId: r.batchId } });
  const sent = final.filter((x) => x.status === "SENT").length;
  console.log(`\nRESULT: ${sent}/4 SENT`);
  await emailQueue.close();
  await connection.quit().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(sent === 4 ? 0 : 1);
}

void main().catch((err) => {
  console.error("experiment failed:", err);
  process.exit(1);
});
