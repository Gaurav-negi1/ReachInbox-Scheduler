-- AlterTable: worker-computed resume time for parked emails (throttle / hourly caps).
ALTER TABLE "ScheduledEmail" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);
