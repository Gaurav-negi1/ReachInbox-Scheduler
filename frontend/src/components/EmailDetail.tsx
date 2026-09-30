import { useMemo } from "react";
import DOMPurify from "dompurify";
import { api } from "../api";
import { FileCard } from "./FileCard";
import type { ScheduledEmail } from "../types";

function fmtLong(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Email detail (read view): back arrow + subject title, avatar,
 * sender/recipient meta line with timestamp, then the body, plus a Cancel
 * action for anything still scheduled.
 */
export function EmailDetail({
  email,
  onBack,
  onCancel,
}: {
  email: ScheduledEmail;
  onBack: () => void;
  onCancel?: (id: string) => void;
}) {
  const cancellable = email.status === "SCHEDULED";
  // Rich HTML bodies are sanitized before render; plain-text bodies fall through.
  const safeHtml = useMemo(
    () => (email.bodyHtml ? DOMPurify.sanitize(email.bodyHtml) : null),
    [email.bodyHtml]
  );
  return (
    <section className="flex h-screen flex-1 flex-col overflow-hidden bg-white">
      <div className="flex items-center justify-between px-6 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <button onClick={onBack} className="rounded-full p-1.5 text-gray-700 transition hover:bg-gray-100">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5m0 0l7 7m-7-7l7-7" />
            </svg>
          </button>
          <h1 className="truncate text-lg font-semibold text-gray-900">{email.subject}</h1>
        </div>
        <div className="flex items-center gap-2">
          {cancellable && onCancel && (
            <button
              onClick={() => onCancel(email.id)}
              className="rounded-full border border-red-200 px-4 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50"
            >
              Cancel send
            </button>
          )}
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
            {email.senderEmail[0]?.toUpperCase() ?? "?"}
          </div>
        </div>
      </div>

      <div className="mt-6 flex-1 overflow-y-auto px-10 pb-10">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">{email.senderEmail}</span>
                <span className="text-xs text-gray-400">&lt;{email.senderEmail}&gt;</span>
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                to <span className="font-medium text-gray-700">{email.recipientEmail}</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-400">{fmtLong(email.sentAt ?? email.scheduledAt)}</div>
              {email.status === "SCHEDULED" && email.nextAttemptAt && (
                <div className="mt-1 text-[11px] font-medium text-blue-600">
                  Retrying {fmtLong(email.nextAttemptAt)} (rate limit)
                </div>
              )}
              <span
                className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
                  email.status === "SENT"
                    ? "bg-brand-50 text-brand-700 ring-brand-200"
                    : email.status === "FAILED"
                      ? "bg-red-50 text-red-600 ring-red-200"
                      : "bg-amber-50 text-amber-700 ring-amber-200"
                }`}
              >
                {email.status.toLowerCase()}
              </span>
            </div>
          </div>

          {safeHtml ? (
            <div
              className="editor mt-8 text-[15px] leading-relaxed text-gray-800"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          ) : (
            <div className="mt-8 whitespace-pre-wrap text-[15px] leading-relaxed text-gray-800">{email.body}</div>
          )}

          {email.attachments && email.attachments.length > 0 && (
            <div className="mt-6" aria-label="Attachments">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Attachments</div>
              <div className="flex flex-wrap gap-3">
                {email.attachments.map((a) => (
                  <FileCard
                    key={a.id}
                    name={a.filename}
                    size={a.size}
                    onDownload={() => void api.attachmentUrl(email.id, a.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {email.lastError && (
            <div className="mt-8 rounded-lg bg-red-50 px-4 py-3 text-xs text-red-600 ring-1 ring-inset ring-red-100">
              Last error: {email.lastError}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
