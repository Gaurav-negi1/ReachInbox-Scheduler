import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RateLimitAlert } from "../types";

const POLL_MS = 10_000;

/**
 * Header bell: polls /api/stats/alerts every 10s and shows an unread badge.
 * Opening the dropdown marks everything read by advancing the last-seen
 * timestamp (kept in localStorage so it survives reloads).
 */
export function AlertBell() {
  const [alerts, setAlerts] = useState<RateLimitAlert[]>([]);
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(() => {
    const raw = Number(localStorage.getItem("alertsLastSeenMs"));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  });
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    api
      .alerts(lastSeen)
      .then((r) => setAlerts(r.items))
      .catch(() => undefined);
  };

  useEffect(refresh, [lastSeen]);

  // Poll while the dashboard is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [lastSeen]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = lastSeen > 0 ? alerts.filter((a) => Date.parse(a.createdAt) > lastSeen).length : alerts.length;

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const now = Date.now();
      setLastSeen(now);
      localStorage.setItem("alertsLastSeenMs", String(now));
    }
  };

  const describe = (a: RateLimitAlert) => {
    const scope = a.reason === "global" ? "Global hourly limit" : a.scope;
    const when = new Date(a.createdAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return { scope, when };
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={toggleOpen}
        title="Rate-limit alerts"
        aria-label="Rate-limit alerts"
        className="relative rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
      >
        <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">
            Rate-limit alerts
          </div>
          {alerts.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-gray-400">
              No rate-limit events yet. Alerts appear here when an hourly cap is hit (and in Slack, if connected).
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-gray-100">
              {alerts.map((a) => {
                const { scope, when } = describe(a);
                return (
                  <li key={a.id} className="flex gap-3 px-4 py-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-gray-900">{scope} reached</div>
                      <div className="mt-0.5 text-xs text-gray-500">
                        Limit {a.limit}/h · {a.queuedAhead} parked · resumes next window
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-400">
                        {when}
                        {a.slackSent && (
                          <>
                            <span>·</span>
                            <span className="inline-flex items-center gap-0.5">
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z" />
                              </svg>
                              Slack sent
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
