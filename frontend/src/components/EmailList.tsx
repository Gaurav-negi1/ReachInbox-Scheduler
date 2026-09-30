import { useState } from "react";
import { api } from "../api";
import { FilterMenu, type ListFilter } from "./FilterMenu";
import type { ScheduledEmail } from "../types";

function timeChip(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function dayChip(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const STATUS_STYLES: Record<string, string> = {
  SENT: "bg-brand-50 text-brand-700 ring-brand-200",
  SCHEDULED: "bg-amber-50 text-amber-700 ring-amber-200",
  SENDING: "bg-blue-50 text-blue-700 ring-blue-200",
  FAILED: "bg-red-50 text-red-600 ring-red-200",
  CANCELLED: "bg-gray-100 text-gray-500 ring-gray-200",
};

/**
 * Email list: full-width search bar with filter and refresh icons, then rows
 * of `To: <name>` + time pill + subject + status tag + body preview, with a
 * star on the right. Loading skeleton and empty state included.
 */
export function EmailList({
  items,
  loading,
  mode,
  search,
  filter,
  onSearchChange,
  onFilterChange,
  onRefresh,
  onOpen,
  onToggleStar,
  toast,
}: {
  items: ScheduledEmail[];
  loading: boolean;
  mode: "scheduled" | "sent";
  search: string;
  filter: ListFilter;
  onSearchChange: (s: string) => void;
  onFilterChange: (f: ListFilter) => void;
  onRefresh: () => void;
  onOpen?: (email: ScheduledEmail) => void;
  onToggleStar?: (id: string, next: boolean) => void;
  toast: (msg: string, kind: "success" | "error" | "info") => void;
}) {
  const [busyStar, setBusyStar] = useState<string | null>(null);

  const toggleStar = async (e: ScheduledEmail) => {
    if (!onToggleStar || busyStar === e.id) return;
    const next = !e.starred;
    onToggleStar(e.id, next); // optimistic
    setBusyStar(e.id);
    try {
      await api.setStarred(e.id, next);
    } catch {
      onToggleStar(e.id, !next); // revert
      toast("Couldn't update the star — try again", "error");
    } finally {
      setBusyStar(null);
    }
  };

  return (
    <section className="flex h-screen flex-1 flex-col overflow-hidden">
      {/* Search row */}
      <div className="flex items-center gap-3 px-6 pt-5">
        <div className="relative flex-1">
          <svg
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
          </svg>
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={
              mode === "sent"
                ? "Search sent emails — recipient, subject, body (Elasticsearch)"
                : "Search scheduled emails by recipient or subject"
            }
            className="w-full rounded-full bg-gray-100 py-2.5 pl-10 pr-4 text-sm text-gray-800 placeholder-gray-400 outline-none transition focus:bg-white focus:ring-2 focus:ring-brand-200"
          />
        </div>
        <FilterMenu mode={mode} value={filter} onChange={onFilterChange} />
        <button
          title="Refresh"
          onClick={onRefresh}
          className="rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
        >
          <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14.9-3M4 15a8 8 0 0014.9 3"
            />
          </svg>
        </button>
      </div>

      {/* Rows */}
      <div className="mt-3 flex-1 overflow-y-auto px-6 pb-6">
        {loading ? (
          <div className="space-y-3 pt-2">
            {[...Array(7)].map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
              <svg className="h-6 w-6 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
                />
              </svg>
            </div>
            <h3 className="mt-4 text-sm font-semibold text-gray-900">
              {mode === "scheduled" ? "No scheduled emails" : "No sent emails yet"}
            </h3>
            <p className="mt-1 max-w-xs text-sm text-gray-400">
              {mode === "scheduled"
                ? "Hit Compose to schedule your first sequence — it will appear here."
                : "Once the worker sends scheduled emails, they will show up here."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => onOpen?.(e)}
                  className="group flex w-full items-center gap-4 py-3.5 text-left transition hover:bg-gray-50/80"
                >
                  {/* To */}
                  <span className="w-56 shrink-0 truncate text-sm font-semibold text-gray-900">
                    To: {e.recipientEmail}
                  </span>

                  {/* Time pill */}
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      mode === "scheduled"
                        ? "bg-amber-50 text-amber-700 ring-amber-200"
                        : "bg-brand-50 text-brand-700 ring-brand-200"
                    }`}
                  >
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <circle cx="12" cy="12" r="9" />
                      <path strokeLinecap="round" d="M12 7v5l3 2" />
                    </svg>
                    {mode === "scheduled" ? timeChip(e.scheduledAt) : dayChip(e.sentAt)}
                  </span>

                  {/* Subject + status + preview */}
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-500">
                    <span className="font-medium text-gray-800">{e.subject}</span>
                    <span
                      className={`ml-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
                        STATUS_STYLES[e.status] ?? "bg-gray-100 text-gray-500 ring-gray-200"
                      }`}
                    >
                      {e.status.toLowerCase()}
                    </span>
                    <span className="ml-2 text-gray-400">- {e.body?.replace(/\s+/g, " ").slice(0, 90) ?? ""}</span>
                  </span>

                  {/* Star (functional, optimistic) */}
                  <span
                    role="button"
                    aria-label={e.starred ? "Unstar" : "Star"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void toggleStar(e);
                    }}
                    className={`shrink-0 p-1 transition ${
                      e.starred
                        ? "text-amber-400"
                        : "text-gray-300 opacity-0 transition group-hover:opacity-100 hover:text-gray-500"
                    }`}
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill={e.starred ? "currentColor" : "none"}
                      stroke="currentColor"
                      strokeWidth={1.6}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M11.48 3.5a.56.56 0 011.04 0l2.13 5.11 5.52.44a.56.56 0 01.32.98l-4.2 3.6 1.28 5.38a.56.56 0 01-.84.6L12 16.7l-4.73 2.9a.56.56 0 01-.84-.6l1.28-5.37-4.2-3.6a.56.56 0 01.32-.99l5.52-.44 2.13-5.1z"
                      />
                    </svg>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
