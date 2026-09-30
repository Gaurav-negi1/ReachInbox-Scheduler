# ReachInbox Email Scheduler

A production-grade **email scheduling service + dashboard**: schedule thousands of emails for future delivery, backed by **BullMQ + Redis** delayed jobs (no cron), persisted in **PostgreSQL**, sent over **Ethereal fake SMTP** from multiple senders, searchable in **Elasticsearch**, with real **Google OAuth** login and **Slack alerts** the moment an hourly limit is hit.

## Live demo

**URL:** https://reachinbox-scheduler.onrender.com  <!-- update with the actual Render URL after deploy -->

Hosted on Render's free tier (backend + frontend served from one origin in production mode). Notes:
- After a period of inactivity the service sleeps; the **first load may take up to ~60s** to wake. Subsequent requests are fast.
- Scheduled emails queued while asleep fire as soon as the service wakes — nothing is lost.
- Login uses **real Google OAuth**, so a live Google client must be configured for this domain.

Local setup and self-hosting instructions are below.

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js, **TypeScript**, Express.js |
| Queue | **BullMQ** (delayed jobs, no cron) |
| Database | **PostgreSQL** + Prisma ORM |
| Search | **Elasticsearch 8** |
| SMTP | **Ethereal Email** (fake SMTP, multi-sender) |
| Frontend | **React 18 (Vite) + TypeScript + Tailwind CSS** (matches the Outbox Labs Figma) |
| Infra | Docker Compose (Postgres, Redis, Elasticsearch) |
| Dashboards | Bull Board (live queue visibility, basic-auth) |

## Quick Start

### 0. Prerequisites
- Node.js 20+, Docker Desktop

### 1. Start infrastructure

```bash
docker compose up -d          # postgres + redis + elasticsearch
```

### 2. Configure environment

```bash
cp .env.example backend/.env  # then fill in the values marked below
```

Fill in `backend/.env`:

- **Google OAuth (required for login)** — create an OAuth client at
  [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
  (type *Web application*) and add `http://localhost:4000/api/auth/google/callback`
  as an authorized redirect URI. Copy the client id/secret into
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- **Slack OAuth (required for rate-limit alerts)** — create a Slack app at
  [api.slack.com/apps](https://api.slack.com/apps), add the scopes
  `chat:write`, `incoming-webhook`, `channels:read`, set the redirect URL to
  `http://localhost:4000/api/slack/callback`, and copy `SLACK_CLIENT_ID` /
  `SLACK_CLIENT_SECRET`.
- Everything else works out of the box (Postgres/Redis/ES URLs, worker tuning).

### 3. Install, migrate, run

```bash
npm install                                # workspaces: backend + frontend
npm run prisma:migrate --workspace backend # create schema
npm run dev                                # backend (:4000) + frontend (:5173)
```

- API: http://localhost:4000
- Dashboard UI: http://localhost:5173
- Bull Board: http://localhost:4000/admin/queues (user `admin`, pass `admin123`)

Run the worker as a separate process (optional — it also boots inside the API):

```bash
npm run worker --workspace backend
```

## Architecture

```
React dashboard ──► Express API ──► PostgreSQL (source of truth)
     │                    │
     │                    ├──► BullMQ delayed jobs ──► Redis (persistent)
     │                    │
     │                    └──► Worker(s): claim row → Redis rate-limit check
     │                            → Ethereal SMTP → DB update → ES index
     ▼
Google OAuth (login)      Slack OAuth (rate-limit alerts)
```

### How scheduling works

1. `POST /api/emails/schedule` validates the batch, auto-provisions an
   **Ethereal SMTP account** for an unknown sender (persisted in `EmailSender`),
   and inserts one `ScheduledEmail` row per recipient.
2. Each row gets a **BullMQ delayed job** with a deterministic id
   `send-<rowId>` scheduled for its `scheduledAt` timestamp. No cron anywhere.
3. Workers pick up jobs at their due time; the per-recipient `scheduledAt`
   offsets (`startAt + i × delaySeconds`) preserve arrival order.

### Persistence on restart

- **Jobs live in Redis** (AOF enabled in docker-compose), **state lives in
  Postgres** — a restart resumes exactly where things stopped:
  - Future delayed jobs fire at their original time.
  - Rows claimed as `SENDING` right before a crash are reconciled by the
    startup reaper (`backend/src/lib/staleReaper.ts`): completed jobs are
    marked `SENT`, lost jobs are re-enqueued, stuck rows are reset.
- **No duplicates / no restart-from-scratch:**
  - DB claim: the worker flips `SCHEDULED → SENDING` with a conditional
    `UPDATE ... WHERE status IN ('SCHEDULED','SENDING')` — a redelivered job
    for an already-sent row is a no-op.
  - Deterministic Bull job id (`send-<rowId>`) — re-adding the same job id is
    idempotent in BullMQ.
  - `createMany({ skipDuplicates: true })` + unique constraint
    `(sender, recipient, subject, scheduledAt)` makes re-submitting a batch
    safe — duplicates are skipped, never double-enqueued.

### Throughput, rate limiting & concurrency

| Mechanism | Implementation |
|---|---|
| Worker concurrency | `WORKER_CONCURRENCY` (default 5) — BullMQ workers run jobs in parallel; DB-claim gate keeps it safe |
| Min delay between sends | `MIN_SEND_DELAY_SECONDS` (default **2s**) — Redis `rl:throttle:global` holds the next-allowed timestamp; enforced inside the atomic claim script |
| Global hourly cap | `MAX_EMAILS_PER_HOUR` (default 200) — Redis counter `rl:hour:<window>:global` |
| Per-sender hourly cap | `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 0 = off) — Redis counter `rl:hour:<window>:sender:<email>` |
| Per-batch hourly cap | **"Hourly Limit" field in the Compose UI** (`hourlyLimit` on the schedule API) — Redis counter `rl:hour:<window>:batch:<batchId>`, scoped to that one batch |

- **One atomic Lua script** claims a send slot in a single Redis round trip:
  the min-delay throttle and all three hourly caps are checked-and-claimed
  together (Redis executes scripts serially, so check-then-increment is
  race-free and a denial never consumes capacity). The clock is **Redis TIME**,
  so multiple app servers with skewed clocks cannot collectively exceed a cap
  or sneak past the throttle. No in-memory counters anywhere.
- On a hit, the job is **not dropped or failed**: the DB row returns to
  `SCHEDULED` and the active job is parked via `job.moveToDelayed()` +
  `DelayedError` (the sanctioned BullMQ pattern — `changeDelay()` does not work
  on active jobs). The resume time comes from an **overflow rank queue**
  (`rl:overflow:<window>:<scope>`): rank N drains at next-window-start +
  N × min-delay, spilling into later windows once each window's capacity is
  full — so 1000+ emails drain in arrival order, cap per window.
- **Slack notification fires live** (webhook or `chat.postMessage`) the first
  time each scope trips the limit in a window — deduped with a Redis `SET NX`
  key (`rl:alert:<window>:<scope>`), so the single-alert guarantee holds
  across multiple worker instances too. No Slack connected → no-op,
  never a crash; connect later → works without redeploy.
- SMTP failures release their rate-limit slots (`releaseHourlySlots`) and
  retry with backoff; the row is only marked `FAILED` on the final attempt.

### Behavior under load (1000+ emails at once)

- Scheduling API inserts 1000 rows + enqueues 1000 delayed jobs in one batch
  (max batch size 10,000, validated).
- Workers pull at most `WORKER_CONCURRENCY` at a time; the 2s throttle gates
  actual SMTP sends to ≤ 1 per 2s; the hourly cap (200/h) pushes the rest
  forward window by window. Nothing is dropped — jobs keep their order and
  drain across subsequent windows.

### Elasticsearch indexing

- Emails are indexed **at schedule time** (`emails` index) with recipient,
  subject, body, sender, status, timestamps — and updated as they transition:
  → `SENT` on delivery, → `FAILED` on terminal SMTP failure (worker),
  → `CANCELLED` on cancel, and reconciled by the startup reaper. Scheduled
  and sent emails are therefore both fully searchable.
- `GET /api/emails/sent?search=...` runs a fuzzy `multi_match` across
  recipient/subject/body/sender, scoped to the user and to `SENT`/`FAILED`
  statuses. The scheduled tab stays Postgres-backed (fast, authoritative).
- If ES is down, the API **degrades gracefully to Postgres** (flagged in the
  response as `degraded: true`) instead of erroring.


**Backend**
- [x] Schedule API (`POST /api/emails/schedule`) with per-batch validation
- [x] BullMQ delayed jobs, no cron, Redis persistence
- [x] Postgres as source of truth + Prisma migrations
- [x] Multi-sender Ethereal SMTP (auto-provisioned accounts, pooled transports)
- [x] Idempotent scheduling + at-most-once sending (DB claim + job-id dedupe)
- [x] Startup crash recovery (orphaned `SENDING` / overdue rows re-queued)
- [x] Redis atomic rate limiting (global + per-sender + per-batch) + min-send throttle
- [x] Attachments: multipart upload (5 × 5 MB), stored in Postgres, attached to every SMTP send, downloadable
- [x] Star (persisted + ES-synced) and All/Starred/Failed filters on both lists
- [x] Rich-text HTML body (sent as HTML with plain-text fallback; DOMPurify-sanitized on display)
- [x] Slack alerts on limit hit (OAuth, live webhooks, disconnect-safe)
- [x] Elasticsearch indexing + fuzzy search + graceful degradation
- [x] Bull Board live queue dashboard (basic-auth)
- [x] Graceful shutdown (SIGINT/SIGTERM waits for in-flight sends)

**Frontend** 
- [x] Login card: real Google OAuth button + email/password visual form
- [x] App shell: ONB sidebar, user card (avatar/name/email), outlined green
      Compose, CORE nav with **live Scheduled/Sent counts**, Slack connect, logout
- [x] Email list: full-width search (ES-powered on Sent), **functional filter
      menu** (All / Starred / Failed), refresh, rows with `To:` + time pill +
      subject + status tag + body preview + **working star** (optimistic
      toggle, persisted per email and searchable via the Starred filter)
- [x] Full-page Compose: From sender dropdown, To **chips** (+N overflow,
      Enter/comma/backspace) with **Upload List** CSV/TXT ingest + detected count,
      Subject, **Delay between 2 emails**, **Hourly Limit** (per-batch cap sent
      to the backend), **file attachments** (up to 5 × 5 MB, uploaded with the
      batch and attached to every SMTP send), **rich-text HTML body** with a
      working formatting toolbar (undo/redo, bold/italic/underline/strike,
      lists, quote — sanitized with DOMPurify on display), **Send Later**
      popover (pick date & time + Tomorrow quick options + Cancel/Done)
- [x] Email detail view (read pane) with rendered rich-text body, **attachment
      chips with download**, and cancel-send for scheduled items
- [x] Loading skeletons, empty states, toasts
- [x] Real Google OAuth login (no mock), logout

## API summary

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/auth/google/url` | – | Google consent URL |
| GET | `/api/auth/google/callback` | – | OAuth callback → sets session |
| POST | `/api/auth/dev-token` | – | Dev-only bearer token (disabled in prod) |
| GET | `/api/auth/me` | Bearer | Current user |
| POST | `/api/emails/schedule` | Bearer | Schedule a batch (JSON **or** multipart with attachments) |
| GET | `/api/emails/scheduled` | Bearer | List scheduled (search/filter/paged) |
| GET | `/api/emails/sent` | Bearer | Search sent via ES (incl. failed) |
| GET | `/api/emails/:id` | Bearer | Email detail (body, HTML, attachments) |
| PATCH | `/api/emails/:id/star` | Bearer | Toggle star |
| GET | `/api/emails/:id/attachments/:attachmentId` | Bearer | Download an attachment |
| POST | `/api/emails/:id/cancel` | Bearer | Cancel a scheduled email |
| GET | `/api/slack/connect` | Bearer | Slack authorize URL |
| GET | `/api/slack/status` | Bearer | Slack connection state |
| GET | `/api/stats/rate-limit` | Bearer | Live rate-limit snapshot |
| GET | `/api/stats/worker` | Bearer | Effective worker config |
| GET | `/api/stats/queue` | Bearer | BullMQ job counts |
| GET | `/admin/queues` | Basic | Bull Board UI |
| GET | `/healthz` | – | Liveness probe |

### Example: schedule via curl

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/dev-token \
  -H 'Content-Type: application/json' -d '{"email":"me@test.com"}' | jq -r .token)

curl -X POST localhost:4000/api/emails/schedule \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "recipients": ["a@test.com", "b@test.com"],
    "subject": "Hello",
    "body": "World",
    "senderEmail": "outreach@ethereal.email",
    "startAt": "2026-01-01T10:00:00Z",
    "delaySeconds": 5
  }'
```

## Environment variables

See [.env.example](.env.example) — every knob is documented there
(worker concurrency, delays, caps, Bull Board creds, OAuth, ES/Redis/DB URLs).

**Deeper documentation:** [PROJECT_GUIDE.md](PROJECT_GUIDE.md) — full architecture
walkthrough, step-by-step OAuth setup, deployment instructions, and the
requirement→implementation mapping table.

## Demo walkthrough

1. Login with Google → ONB shell with sidebar counts.
2. Compose → add recipient chips / Upload List → subject + body → set Delay
   between 2 emails + Hourly Limit → clock icon → Send Later → pick time → Done → Send.
3. Watch the **Scheduled** nav; rows flip to **Sent** as workers fire (auto-refresh).
4. Click a row → detail view; search in **Sent** (ES-backed fuzzy search).
5. Bull Board shows live waiting/delayed/active/completed jobs.
6. Restart test: `Ctrl+C` the backend → `npm run dev:backend` → future emails
   still send on time, nothing re-sends.
7. Rate-limit demo: set `MAX_EMAILS_PER_HOUR=5` (or Hourly Limit = 2 in Compose),
   schedule 20 emails → only the cap sends, Slack pings, the rest resume next hour.

## Deployment (Render)

The app deploys as **one web service** — in production mode (`NODE_ENV=production`) the
Express server serves the built React app from `frontend/dist`, so a single URL hosts
everything and the frontend's relative `/api` calls need no CORS or proxy setup.

1. **Postgres** — Render → New + → Postgres (free tier). Copy the *Internal Database URL*.
2. **Redis** — Render → New + → Key Value (free tier). Copy the *Internal Redis URL*.
3. **Web Service** — Render → New + → Web Service → connect the repo:
   - Build: `npm install && npm run build --workspaces && npm run prisma:deploy --workspace backend`
   - Start: `npm run start --workspace backend`
   - Env vars: `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`,
     `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD`, `FRONTEND_URL` + `CORS_ORIGINS` +
     `GOOGLE_REDIRECT_URI` + `SLACK_REDIRECT_URI` set to the deployed URL, and the
     Google/Slack OAuth credentials.
4. **OAuth redirects** — in Google Cloud Console and the Slack app settings, add the
   deployed callback URLs (`/api/auth/google/callback`, `/api/slack/callback`).
5. Optional: a cron ping (e.g. cron-job.org hitting `/healthz` every 10 min) keeps the
   free service awake so the first visitor request is instant.

Elasticsearch is optional in deployment: without it, sent-email search automatically
degrades to Postgres (responses carry `"degraded": true`). Full details and cloud-ES
configuration: [PROJECT_GUIDE.md](PROJECT_GUIDE.md) §7.

## Assumptions & trade-offs

1. **In-process worker**: the worker boots inside the API process for a simple
   single-command demo, but is fully separable (`npm run worker`) — BullMQ and
   Redis make it scale-out ready.
2. **Ethereal auto-provisioning**: unknown senders get a fresh Ethereal
   account created and persisted, so multi-sender works without manual setup.
3. **Min-send delay is global**, not per sender — mirrors how real provider
   throttling works for a shared IP. Per-sender throttling would be a small
   change (key the throttle timestamp by sender).
4. **Hourly windows are fixed** (epoch-hour buckets), not rolling — cheaper,
   good enough for provider caps, trivially explainable.
5. **Slack alerting is per window, per scope** — one ping per scope each hour window,
   deduped with a Redis `SET NX` key so it holds across multiple worker instances.
6. **`POST /api/auth/dev-token`** exists purely for demo/Postman testing and
   is disabled in production.
7. **Ordering under rate-limiting** is preserved within a window via
   per-recipient offsets + FIFO worker pickup; strict global FIFO across
   windows is not guaranteed (and isn't in real email systems either).
8. **CSV parsing is client-side** (fast feedback while composing); the server
   independently re-validates every recipient before scheduling.
