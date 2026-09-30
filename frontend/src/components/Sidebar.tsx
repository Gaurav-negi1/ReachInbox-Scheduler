import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type { SlackStatus } from "../types";

/**
 * App sidebar (260px, right border): ONB logo, user card (avatar, name,
 * email, chevron), outlined green Compose button, "CORE" label, Scheduled /
 * Sent nav rows with live counts, then a compact Slack connect row
 * (rate-limit alerts) and Logout.
 */
export function Sidebar({
  active,
  scheduledCount,
  sentCount,
  onNavigate,
  onCompose,
}: {
  active: "scheduled" | "sent";
  scheduledCount: number;
  sentCount: number;
  onNavigate: (tab: "scheduled" | "sent") => void;
  onCompose: () => void;
}) {
  const { user, logout } = useAuth();
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!user) return;
    api.slackStatus().then(setSlack).catch(() => undefined);
  }, [user]);

  const connectSlack = async () => {
    setConnecting(true);
    try {
      const { url } = await api.slackConnect();
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  };

  const NavIcon = ({ tab }: { tab: "scheduled" | "sent" }) =>
    tab === "scheduled" ? (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M12 7v5l3 2" />
      </svg>
    ) : (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
      </svg>
    );

  return (
    <aside className="flex h-screen w-[260px] shrink-0 flex-col border-r border-gray-200 bg-white pt-5 pb-4 pl-5 pr-4">
      {/* Logo */}
      <div className="select-none px-1 text-[26px] font-black tracking-tight text-gray-900" style={{ fontFamily: "Inter, sans-serif" }}>
        ONB
      </div>

      {/* User card */}
      <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-gray-200 px-3 py-2.5">
        {user?.avatarUrl ? (
          <img src={user.avatarUrl} alt={user.name} className="h-9 w-9 rounded-full object-cover" />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
            {user?.name?.[0]?.toUpperCase() ?? "?"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-gray-900">{user?.name}</div>
          <div className="truncate text-[11px] text-gray-400">{user?.email}</div>
        </div>
        <svg className="h-4 w-4 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Compose */}
      <button
        onClick={onCompose}
        className="mt-4 w-full rounded-lg border border-brand-500 py-2.5 text-sm font-medium text-brand-600 transition hover:bg-brand-50"
      >
        Compose
      </button>

      {/* Core nav */}
      <div className="mt-7 px-1 text-[11px] font-medium tracking-widest text-gray-400">CORE</div>
      <nav className="mt-2 space-y-1">
        <button
          onClick={() => onNavigate("scheduled")}
          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition ${
            active === "scheduled"
              ? "bg-brand-50 font-semibold text-brand-700"
              : "text-gray-600 hover:bg-gray-50"
          }`}
        >
          <NavIcon tab="scheduled" />
          <span className="flex-1 text-left">Scheduled</span>
          <span className="text-xs text-gray-400">{scheduledCount}</span>
        </button>
        <button
          onClick={() => onNavigate("sent")}
          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition ${
            active === "sent"
              ? "bg-brand-50 font-semibold text-brand-700"
              : "text-gray-600 hover:bg-gray-50"
          }`}
        >
          <NavIcon tab="sent" />
          <span className="flex-1 text-left">Sent</span>
          <span className="text-xs text-gray-400">{sentCount}</span>
        </button>
      </nav>

      <div className="flex-1" />

      {/* Slack + logout */}
      <div className="space-y-2 border-t border-gray-100 pt-3">
        {slack?.connected ? (
          <div className="flex items-center gap-2 px-1 text-xs text-emerald-600">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z" />
            </svg>
            Slack connected{slack.teamName ? ` · ${slack.teamName}` : ""}
          </div>
        ) : (
          <button
            onClick={connectSlack}
            disabled={connecting}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-gray-500 transition hover:text-gray-800 disabled:opacity-60"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z" />
            </svg>
            {connecting ? "Connecting…" : "Connect Slack for alerts"}
          </button>
        )}
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-gray-500 transition hover:text-gray-800"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12H3m0 0l4-4m-4 4l4 4m10 5a2 2 0 002-2V7a2 2 0 00-2-2h-6" />
          </svg>
          Logout
        </button>
      </div>
    </aside>
  );
}
