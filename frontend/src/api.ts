import type { Paginated, ScheduleResponse, ScheduledEmail, SlackStatus, RateLimitSnapshot, WorkerConfig, User, Sender, AlertsResponse } from "./types";

const BASE = "/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("token");
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.href = "/";
    throw new Error("Session expired — please log in again");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ---- auth ----
  googleUrl: () => request<{ url: string }>("/auth/google/url"),
  me: () => request<{ user: User }>("/auth/me"),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  // ---- emails ----
  // Multipart when files are attached (payload JSON + files), JSON otherwise.
  schedule: (
    payload: {
      recipients: string[];
      subject: string;
      body: string;
      bodyHtml?: string | null;
      senderEmail: string;
      senderName?: string;
      startAt: string;
      delaySeconds: number;
      hourlyLimit?: number | null;
    },
    files: File[] = []
  ) => {
    if (files.length === 0) {
      return request<ScheduleResponse>("/emails/schedule", { method: "POST", body: JSON.stringify(payload) });
    }
    const token = localStorage.getItem("token");
    const form = new FormData();
    form.append("payload", JSON.stringify(payload));
    files.forEach((f) => form.append("attachments", f));
    return fetch(`${BASE}/emails/schedule`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    }).then(async (res) => {
      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "/";
        throw new Error("Session expired — please log in again");
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      return (await res.json()) as ScheduleResponse;
    });
  },

  senders: () => request<{ items: Sender[] }>("/emails/senders"),
  emailDetail: (id: string) => request<ScheduledEmail>(`/emails/${id}`),

  scheduled: (params: { search?: string; filter?: string; page?: number; pageSize?: number }) =>
    request<Paginated<ScheduledEmail>>(`/emails/scheduled?${new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v!)])
    )}`),

  sent: (params: { search?: string; filter?: string; page?: number; pageSize?: number }) =>
    request<Paginated<ScheduledEmail>>(`/emails/sent?${new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v!)])
    )}`),

  setStarred: (id: string, starred: boolean) =>
    request<{ id: string; starred: boolean }>(`/emails/${id}/star`, {
      method: "PATCH",
      body: JSON.stringify({ starred }),
    }),

  attachmentUrl: (emailId: string, attachmentId: string) => {
    const token = localStorage.getItem("token");
    // fetch+blob keeps the Bearer auth flow (no token in the URL).
    return fetch(`${BASE}/emails/${emailId}/attachments/${attachmentId}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }).then(async (res) => {
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  },

  cancel: (id: string) => request<{ ok: boolean }>(`/emails/${id}/cancel`, { method: "POST" }),

  // ---- slack ----
  slackStatus: () => request<SlackStatus>("/slack/status"),
  slackConnect: () => request<{ url: string }>("/slack/connect"),
  slackDisconnect: () => request<{ ok: boolean }>("/slack/disconnect", { method: "POST" }),

  // ---- alerts ----
  alerts: (since = 0) => request<AlertsResponse>(`/stats/alerts?since=${encodeURIComponent(since)}`),

  // ---- stats ----
  rateLimit: () => request<RateLimitSnapshot>("/stats/rate-limit"),
  worker: () => request<WorkerConfig>("/stats/worker"),
  queue: () => request<Record<string, number>>("/stats/queue"),
};
