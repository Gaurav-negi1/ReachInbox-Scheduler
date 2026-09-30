// Central configuration loaded from environment variables.
// Everything tunable lives here — no magic numbers in business logic.
import dotenv from "dotenv";
dotenv.config();

function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  // Treat 0/negative/NaN as unset so stray env values (e.g. PORT=0) don't break boot.
  return Number.isFinite(n) && n > 0 ? n : def;
}

function str(name: string, def: string): string {
  return process.env[name] ?? def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

export const config = {
  env: str("NODE_ENV", "development"),
  port: num("PORT", 4000),
  databaseUrl: str(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/reachinbox?schema=public"
  ),
  redisUrl: str("REDIS_URL", "redis://localhost:6379"),
  elasticsearchUrl: str("ELASTICSEARCH_URL", "http://localhost:9200"),
  elasticsearchApiKey: str("ELASTICSEARCH_API_KEY", ""),

  bullBoardUser: str("BULL_BOARD_USER", "admin"),
  bullBoardPassword: str("BULL_BOARD_PASSWORD", "admin123"),

  google: {
    clientId: str("GOOGLE_CLIENT_ID", ""),
    clientSecret: str("GOOGLE_CLIENT_SECRET", ""),
    redirectUri: str("GOOGLE_REDIRECT_URI", "http://localhost:4000/api/auth/google/callback"),
  },
  slack: {
    clientId: str("SLACK_CLIENT_ID", ""),
    clientSecret: str("SLACK_CLIENT_SECRET", ""),
    redirectUri: str("SLACK_REDIRECT_URI", "http://localhost:4000/api/slack/callback"),
  },
  corsOrigins: str("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  sessionSecret: str("SESSION_SECRET", "dev-only-secret-change-me"),
  frontendUrl: str("FRONTEND_URL", "http://localhost:5173"),

  worker: {
    concurrency: num("WORKER_CONCURRENCY", 5),
    minSendDelaySeconds: num("MIN_SEND_DELAY_SECONDS", 2),
    maxPerHourGlobal: num("MAX_EMAILS_PER_HOUR", 200),
    maxPerHourPerSender: num("MAX_EMAILS_PER_HOUR_PER_SENDER", 0),
    maxAttempts: num("MAX_ATTEMPTS", 5),
    backoffMs: num("BACKOFF_MS", 5000),
    jobRetentionMs: num("JOB_RETENTION_MS", 3_600_000),
    useFakeSmtpSink: bool("USE_FAKE_SMTP_SINK", false),
  },
} as const;

export const QUEUE_NAME = "email-send";
export const SESSION_COOKIE = "ri_session";
