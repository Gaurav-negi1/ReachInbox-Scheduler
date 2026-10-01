import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { RichTextEditor, stripHtml } from "./RichTextEditor";
import { FileCard } from "./FileCard";
import type { Sender, ScheduleResponse } from "../types";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function parseLeads(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
    ),
  ];
}

function quickOptions(): { label: string; at: Date }[] {
  const at = (dayOffset: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    if (d.getTime() < Date.now() + 60_000) d.setDate(d.getDate() + 1);
    return d;
  };
  return [
    { label: "Tomorrow", at: at(1, 9, 0) },
    { label: "Tomorrow, 10:00 AM", at: at(1, 10, 0) },
    { label: "Tomorrow, 11:00 AM", at: at(1, 11, 0) },
    { label: "Tomorrow, 3:00 PM", at: at(1, 15, 0) },
  ];
}

const fmt = (d: Date) =>
  d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Full-page Compose screen:
 *  - back arrow + title, paperclip + clock + green Send / Send Later
 *  - From: sender dropdown
 *  - To: recipient chips (+N overflow) with "Upload List" on the right
 *  - Subject, Delay between 2 emails, Hourly Limit
 *  - "Type Your Reply…" rich body area with formatting toolbar
 *  - Send Later popover: pick date & time + quick options + Cancel/Done
 */
export function ComposePage({
  onBack,
  onScheduled,
  toast,
}: {
  onBack: () => void;
  onScheduled: () => void;
  toast: (msg: string, kind: "success" | "error" | "info") => void;
}) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [senderEmail, setSenderEmail] = useState("");
  // When the user has no senders yet (fresh account / after a data reset), the
  // From field becomes an editable input: the first send provisions the typed
  // address under THIS account. The old hardcoded fallback option made that
  // impossible — it always suggested an address another user may already own.
  const [newSenderMode, setNewSenderMode] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [toInput, setToInput] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delaySeconds, setDelaySeconds] = useState("00");
  const [hourlyLimit, setHourlyLimit] = useState("00");
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [customDt, setCustomDt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  const quick = useMemo(quickOptions, []);

  useEffect(() => {
    api
      .senders()
      .then(({ items }) => {
        setSenders(items);
        if (items.length > 0) setSenderEmail((cur) => cur || items[0].email);
      })
      .catch(() => undefined);
  }, []);

  const addChips = (raw: string) => {
    const parsed = parseLeads(raw);
    if (parsed.length) setRecipients((cur) => [...new Set([...cur, ...parsed])]);
    setToInput("");
  };

  const handleFile = async (f: File | null) => {
    if (!f) return;
    const parsed = parseLeads(await f.text());
    if (parsed.length === 0) {
      toast("No valid email addresses found in the file", "error");
      return;
    }
    setRecipients((cur) => [...new Set([...cur, ...parsed])]);
    toast(`${parsed.length} email${parsed.length === 1 ? "" : "s"} detected in ${f.name}`, "success");
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const tooBig = incoming.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) toast(`"${tooBig.name}" is over 5 MB`, "error");
    else if (files.length + incoming.length > MAX_FILES) toast(`You can attach up to ${MAX_FILES} files`, "error");
    else setFiles((cur) => [...cur, ...incoming]);
  };

  const submit = async () => {
    if (recipients.length === 0) return toast("Add at least one recipient (type or Upload List)", "error");
    if (!subject.trim()) return toast("Subject is required", "error");
    if (!stripHtml(body)) return toast("Body is required", "error");
    if (!scheduleAt) return toast("Pick a send time via Send Later (clock icon)", "error");

    setSubmitting(true);
    try {
      const res: ScheduleResponse = await api.schedule(
        {
          recipients,
          subject,
          body: stripHtml(body),
          bodyHtml: body,
          senderEmail: senderEmail || "outreach@reachinbox.test",
          startAt: scheduleAt.toISOString(),
          delaySeconds: Math.max(0, Number(delaySeconds) || 0),
          hourlyLimit: Number(hourlyLimit) > 0 ? Number(hourlyLimit) : null,
        },
        files
      );
      toast(`Scheduled ${res.created} email${res.created === 1 ? "" : "s"} for ${fmt(scheduleAt)}`, "success");
      onScheduled();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to schedule", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const shownChips = recipients.slice(0, 3);
  const overflow = recipients.length - shownChips.length;

  return (
    <section className="flex h-screen flex-1 flex-col overflow-hidden bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-full p-1.5 text-gray-700 transition hover:bg-gray-100">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5m0 0l7 7m-7-7l7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-semibold text-gray-900">Compose New Email</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            title="Attach files"
            onClick={() => attachRef.current?.click()}
            className={`relative rounded-full p-2 transition hover:bg-gray-100 ${
              files.length ? "text-brand-600" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20 13" />
            </svg>
            {files.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-[10px] font-semibold text-white">
                {files.length}
              </span>
            )}
          </button>
          <div className="relative">
            <button
              title="Send Later"
              onClick={() => setSendLaterOpen((o) => !o)}
              className={`rounded-full p-2 transition ${
                scheduleAt ? "text-brand-600 bg-brand-50" : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              }`}
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <circle cx="12" cy="12" r="9" />
                <path strokeLinecap="round" d="M12 7v5l3 2" />
              </svg>
            </button>

            {sendLaterOpen && (
              <div className="absolute right-0 top-11 z-30 w-72 rounded-xl border border-gray-200 bg-white p-4 shadow-xl">
                <div className="text-sm font-semibold text-gray-900">Send Later</div>
                <input
                  type="datetime-local"
                  value={customDt}
                  onChange={(e) => setCustomDt(e.target.value)}
                  className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
                />
                <div className="mt-2 space-y-1">
                  {quick.map((q) => (
                    <button
                      key={q.label}
                      onClick={() => {
                        setScheduleAt(q.at);
                        setCustomDt("");
                      }}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm transition hover:bg-gray-50 ${
                        scheduleAt?.getTime() === q.at.getTime() ? "bg-brand-50 text-brand-700" : "text-gray-700"
                      }`}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
                {customDt && (
                  <button
                    onClick={() => setScheduleAt(new Date(customDt))}
                    className="mt-2 w-full rounded-lg bg-gray-50 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    Custom: {new Date(customDt) > new Date() ? fmt(new Date(customDt)) : "pick a future time"}
                  </button>
                )}
                <div className="mt-3 flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
                  <button
                    onClick={() => setSendLaterOpen(false)}
                    className="rounded-lg px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (customDt && new Date(customDt) > new Date()) setScheduleAt(new Date(customDt));
                      setSendLaterOpen(false);
                    }}
                    className="rounded-full border border-brand-500 px-5 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-full border border-brand-500 px-5 py-1.5 text-sm font-medium text-brand-600 transition hover:bg-brand-50 disabled:opacity-60"
          >
            {submitting ? "Scheduling…" : scheduleAt ? "Send Later" : "Send"}
          </button>
        </div>
      </div>

      {/* Fields */}
      <div className="mt-6 flex-1 overflow-y-auto px-10">
        <div className="mx-auto max-w-3xl space-y-5 pb-10">          {/* From */}
          <div className="flex items-center gap-4">
            <label className="w-14 shrink-0 text-sm text-gray-500">From</label>
            <div className="relative">
              {newSenderMode || senders.length === 0 ? (
                <input
                  value={senderEmail}
                  onChange={(e) => setSenderEmail(e.target.value)}
                  placeholder="outreach@reachinbox.test"
                  title="Type any From address — a fresh Ethereal SMTP account is provisioned for it on first send"
                  className="w-72 rounded-lg bg-gray-100 py-2 pl-3 pr-3 text-sm font-medium text-gray-800 outline-none focus:ring-2 focus:ring-brand-200"
                />
              ) : (
                <>
                  <select
                    value={senderEmail}
                    onChange={(e) => {
                      if (e.target.value === "__new__") {
                        setNewSenderMode(true);
                        setSenderEmail("");
                      } else {
                        setSenderEmail(e.target.value);
                      }
                    }}
                    className="appearance-none rounded-lg bg-gray-100 py-2 pl-3 pr-9 text-sm font-medium text-gray-800 outline-none focus:ring-2 focus:ring-brand-200"
                  >
                    {senders.map((s) => (
                      <option key={s.email} value={s.email}>
                        {s.email}
                      </option>
                    ))}
                    {!senders.some((s) => s.email === senderEmail) && senderEmail && (
                      <option value={senderEmail}>{senderEmail}</option>
                    )}
                    <option value="__new__">➕ New sender address…</option>
                  </select>
                  <svg
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </>
              )}
            </div>
          </div>

          {/* To */}
          <div className="flex items-start gap-4">
            <label className="w-14 shrink-0 pt-2 text-sm text-gray-500">To</label>
            <div className="flex min-h-[42px] flex-1 flex-wrap items-center gap-2 border-b border-gray-200 pb-2">
              {shownChips.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1.5 rounded-full border border-brand-500 px-3 py-1 text-xs font-medium text-gray-700"
                >
                  {r}
                  <button
                    onClick={() => setRecipients((cur) => cur.filter((x) => x !== r))}
                    className="text-gray-400 hover:text-gray-700"
                  >
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              {overflow > 0 && (
                <span className="inline-flex items-center rounded-full border border-brand-500 px-2.5 py-1 text-xs font-medium text-brand-600">
                  +{overflow}
                </span>
              )}
              <input
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addChips(toInput);
                  } else if (e.key === "Backspace" && !toInput && recipients.length) {
                    setRecipients((cur) => cur.slice(0, -1));
                  }
                }}
                onBlur={() => addChips(toInput)}
                placeholder={recipients.length === 0 ? "recipient@example.com" : ""}
                className="min-w-[180px] flex-1 bg-transparent text-sm text-gray-800 placeholder-gray-400 outline-none"
              />
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex shrink-0 items-center gap-1.5 pt-2 text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
              </svg>
              Upload List
            </button>
          </div>

          {/* Subject */}
          <div className="flex items-center gap-4">
            <label className="w-14 shrink-0 text-sm text-gray-500">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 border-b border-gray-200 bg-transparent py-2 text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-brand-500"
            />
          </div>

          {/* Delay + Hourly */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-700">Delay between 2 emails</span>
              <input
                type="number"
                min={0}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(e.target.value)}
                className="w-16 rounded-lg bg-gray-100 px-3 py-2 text-center text-sm outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-700">Hourly Limit</span>
              <input
                type="number"
                min={0}
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(e.target.value)}
                className="w-16 rounded-lg bg-gray-100 px-3 py-2 text-center text-sm outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>
          </div>

          {/* Attachments */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-3" aria-label="Attachments">
              {files.map((f, i) => (
                <FileCard key={`${f.name}-${i}`} name={f.name} size={f.size} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
              ))}
            </div>
          )}

          {/* Body editor */}
          <RichTextEditor value={body} onChange={setBody} />
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          void handleFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <input
        ref={attachRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </section>
  );
}
