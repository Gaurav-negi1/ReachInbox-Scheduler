// Shared types for BullMQ job payloads and email records.
export type EmailJobData = {
  emailRecordId: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body: string;
  batchId: string | null;
  userId: string | null;
};

export interface ScheduledEmailDTO {
  id: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body?: string;
  status: "SCHEDULED" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";
  scheduledAt: string;
  sentAt: string | null;
  attemptCount: number;
  lastError?: string | null;
  source: "API" | "CSV";
  batchId: string | null;
  hourlyLimit?: number | null;
  starred?: boolean;
  bodyHtml?: string | null;
  attachments?: { id: string; filename: string; mimetype: string; size: number }[];
}
