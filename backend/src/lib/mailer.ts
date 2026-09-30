import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { prisma } from "./prisma";
import { logger } from "../logger";

/**
 * Ethereal Email (https://ethereal.email) is a fake SMTP service: mails never
 * reach real inboxes. Accounts can be created on the fly via Nodemailer's
 * well-known API; credentials are then persisted in Postgres so restarts
 * reuse the same senders instead of creating a new account per process.
 */

export type SenderIdentity = {
  email: string;
  name: string | null;
};

const transporters = new Map<string, Transporter>();

export async function createEtherealAccount(
  name?: string
): Promise<{ email: string; name: string | null; user: string; pass: string }> {
  const testAccount = await nodemailer.createTestAccount();
  const email = testAccount.user; // e.g. "xxxx@ethereal.email"
  return { email, name: name ?? "ReachInbox Sender", user: testAccount.user, pass: testAccount.pass };
}

export function buildTransport(user: string, pass: string): Transporter {
  // Ethereal: host smtp.ethereal.email, port 587, STARTTLS.
  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Get (or lazily create) a pooled transporter for a sender identity. */
export async function getTransportFor(senderEmail: string): Promise<Transporter> {
  const cached = transporters.get(senderEmail);
  if (cached) return cached;

  const sender = await prisma.emailSender.findUnique({ where: { email: senderEmail } });
  if (!sender?.smtpUser || !sender.smtpPass) {
    throw new Error(`Sender ${senderEmail} has no SMTP credentials`);
  }

  const transporter = buildTransport(sender.smtpUser, sender.smtpPass);
  transporters.set(senderEmail, transporter);
  return transporter;
}

export async function sendMail(
  senderEmail: string,
  options: {
    to: string;
    subject: string;
    text: string;
    html?: string | null;
    attachments?: { filename: string; content: Buffer; contentType?: string }[];
  }
): Promise<{ messageId: string; previewUrl: string | null }> {
  const transporter = await getTransportFor(senderEmail);
  const sender = await prisma.emailSender.findUnique({ where: { email: senderEmail } });
  const info = await transporter.sendMail({
    from: `"${sender?.name ?? "ReachInbox"}" <${senderEmail}>`,
    to: options.to,
    subject: options.subject,
    text: options.text,
    ...(options.html ? { html: options.html } : {}),
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
  });
  logger.info({ from: senderEmail, to: options.to, messageId: info.messageId }, "smtp send ok");
  const preview = nodemailer.getTestMessageUrl(info);
  return { messageId: info.messageId, previewUrl: typeof preview === "string" ? preview : null };
}

export async function verifyAllTransports(): Promise<void> {
  for (const [email, t] of transporters) {
    try {
      await t.verify();
      logger.info({ sender: email }, "smtp transport verified");
    } catch (err) {
      logger.error({ sender: email, err }, "smtp transport verify failed");
    }
  }
}
