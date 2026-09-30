export type EmailStatus = "SCHEDULED" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
}

export interface ScheduledEmail {
  id: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body?: string;
  bodyHtml?: string | null;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  nextAttemptAt?: string | null;
  attemptCount: number;
  lastError?: string | null;
  source: "API" | "CSV";
  batchId: string | null;
  hourlyLimit?: number | null;
  starred?: boolean;
  attachments?: AttachmentInfo[];
}

export interface ScheduleResponse {
  batchId: string;
  created: number;
  skipped: number;
  earliestScheduledAt: string;
}

export interface Paginated<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface SlackStatus {
  connected: boolean;
  teamName: string | null;
  channel: string | null;
}

export interface RateLimitSnapshot {
  globalSentThisHour: number;
  globalLimit: number;
  perSender: Record<string, number>;
  senderLimit: number;
  windowResetsInMs: number;
}

export interface WorkerConfig {
  concurrency: number;
  minSendDelaySeconds: number;
  maxPerHourGlobal: number;
  maxPerHourPerSender: number;
}

export interface Sender {
  email: string;
  name: string | null;
}

export interface RateLimitAlert {
  id: string;
  reason: "global" | "sender" | "batch";
  scope: string;
  limit: number;
  queuedAhead: number;
  slackSent: boolean;
  createdAt: string;
}

export interface AlertsResponse {
  unread: number;
  items: RateLimitAlert[];
}
