# ReachInbox Email Scheduler — Complete Project Guide

Everything you need to understand, run, configure, and deploy this project.

---

## 1. What this project is

A production-grade **email scheduling service + dashboard**: schedule thousands of emails for future delivery, backed by **BullMQ delayed jobs (no cron)**, persisted in **PostgreSQL**, sent over **Ethereal fake SMTP** from multiple senders, searchable in **Elasticsearch**, with real **Google OAuth** login and **Slack alerts** the moment an hourly limit is hit.

It is a tiny slice of what ReachInbox does under the hood: reliable scheduling and sending of emails at scale.

---

## 2. What we used, and why it matches the instructions

| Instruction requirement | What we use | Where |
|---|---|---|
| Backend in TypeScript | Node.js 20 + TypeScript 5 | [backend/](backend/) |
| Express.js | Express 4 (routes: auth, emails, slack, stats) | [backend/src/routes/](backend/src/routes/) |
| BullMQ + Redis, **no cron** | BullMQ 5 delayed jobs on Redis 7 (AOF persisted) | [backend/src/lib/queue.ts](backend/src/lib/queue.ts) |
| PostgreSQL | Postgres 16 + Prisma ORM (3 migrations) | [backend/prisma/schema.prisma](backend/prisma/schema.prisma) |
| Ethereal fake SMTP, multiple senders | Nodemailer + auto-provisioned Ethereal accounts per sender | [backend/src/lib/mailer.ts](backend/src/lib/mailer.ts) |
| Elasticsearch search | ES 8, fuzzy multi_match, lifecycle indexing | [backend/src/lib/elasticsearch.ts](backend/src/lib/elasticsearch.ts) |
| BullMQ live dashboard | Bull Board at `/admin/queues` (basic-auth protected) | [backend/src/app.ts](backend/src/app.ts) |
| Google OAuth login (real, no mock) | Passport-style hand-rolled OAuth2 flow + JWT session | [backend/src/routes/auth.ts](backend/src/routes/auth.ts) |
| Slack alert on rate-limit hit | Real Slack OAuth → webhook `chat.postMessage`, Redis-NX dedupe | [backend/src/lib/slack.ts](backend/src/lib/slack.ts) |
| Frontend: React/Next + Tailwind + TS | React 18 + Vite 6 + Tailwind 3 + TypeScript | [frontend/](frontend/) |
| Frontend matches Figma | Login card, ONB sidebar, list/compose/detail views | [frontend/src/](frontend/src/) |
| Docker for infra | docker-compose: postgres + redis + elasticsearch | [docker-compose.yml](docker-compose.yml) |
| Rate limiting env-configurable | All caps/delays/concurrency via env, zero hardcoding | [backend/src/config.ts](backend/src/config.ts) |

**Hard constraints honored:**
- **No cron anywhere** — no `node-cron`, no `agenda`, no OS crontab (verified by dependency grep). Every send is a BullMQ delayed job with a deterministic id.
- **Persistent across restarts** — jobs live in Redis (AOF `everysec`), state lives in Postgres. A startup reaper reconciles orphans. Verified live: kill mid-flight → restart → every email sent exactly once.
- **Idempotency** — deterministic job ids (`send-<rowId>`), DB claim gate (`UPDATE ... WHERE status IN ('SCHEDULED','SENDING')`), and a unique DB index `(senderEmail, recipientEmail, subject, scheduledAt)` with `skipDuplicates`. Identical re-submits are skipped, never double-sent.

---

## 3. How it works (architecture)

```
React dashboard (:5173) ──► Express API (:4000) ──► PostgreSQL (source of truth)
     │                            │
     │                            ├──► BullMQ delayed jobs ──► Redis (AOF-persisted)
     │                            │
     │                            └──► Worker(s): claim DB row → atomic Redis rate-limit claim
     │                                    → Ethereal SMTP → DB update → Elasticsearch index
     ▼
Google OAuth (login)          Slack OAuth (rate-limit alerts)        Bull Board (:4000/admin/queues)
```

### 3.1 Scheduling flow
1. `POST /api/emails/schedule` accepts **JSON or multipart/form-data** (payload JSON + up to 5 attachment files of 5 MB each), validates the batch (recipients, subject, body, valid `senderEmail`, `startAt`, `delaySeconds`, optional `hourlyLimit` per batch; max 10,000 recipients).
2. Unknown senders get a fresh **Ethereal SMTP account** created automatically and stored in `EmailSender` (multi-sender with zero manual setup).
3. One `ScheduledEmail` row per recipient is inserted with per-recipient `scheduledAt = startAt + i × delaySeconds` (preserves arrival order), all sharing a `batchId`; attachments are stored in Postgres (`Attachment` rows), one copy per email.
4. One BullMQ delayed job per row, id `send-<rowId>`, delay = `scheduledAt - now`. No cron. Future jobs fire at their exact time even days later.

### 3.2 Send flow (worker, concurrency `WORKER_CONCURRENCY` default 5)
1. **Claim gate:** conditional `UPDATE ScheduledEmail SET status='SENDING' WHERE id=? AND status IN ('SCHEDULED','SENDING')` — a redelivered job for an already-sent row is a no-op. This is the at-most-once guarantee.
2. **Rate-limit claim:** one atomic Lua script (`rl:` keys) checks the min-delay throttle + all three hourly caps **in a single Redis round trip, clocked by Redis `TIME`** (multi-instance clock-skew safe). Denied claims consume zero capacity.
3. **On a cap hit:** the job is **never dropped or failed**. It's parked with `job.moveToDelayed()` + `DelayedError` (sanctioned BullMQ pattern), resuming at a timestamp from an **overflow rank queue** (`rl:overflow:<window>:<scope>`): rank N drains at next-window-start + N×min-delay, spilling window-by-window — so 1000+ emails drain in arrival order, cap per window. A Slack alert fires (once per scope per window, Redis `SET NX` deduped).
4. **Send:** pooled nodemailer transporter per sender → Ethereal SMTP, with the rich-text HTML body (`bodyHtml`, sanitized on display) as the primary part, plain text as fallback, and any batch attachments loaded from Postgres and attached.
5. **Finish:** row → `SENT` with messageId + Ethereal preview URL; ES doc → `SENT`. On SMTP error: rate-limit slots are refunded (`releaseHourlySlots`), row returns to `SCHEDULED` for retry with backoff, and only the final attempt marks `FAILED` (and syncs the ES doc).

### 3.3 Persistence & crash recovery
- Redis AOF (`appendonly yes, appendfsync everysec`) keeps delayed jobs alive across restarts.
- On boot, the **stale reaper** ([backend/src/lib/staleReaper.ts](backend/src/lib/staleReaper.ts)) repairs two failure modes: (a) rows stuck `SENDING` are reconciled from the Bull job's true state (completed → `SENT`, pending → back to `SCHEDULED`); (b) overdue `SCHEDULED` rows whose job vanished are re-enqueued with the same deterministic id (BullMQ dedupes). ES docs are kept in sync.

### 3.4 Search
- Every email is indexed in ES **at schedule time** and updated through its lifecycle (`SENT` / `FAILED` / `CANCELLED`, including the `starred` flag), so scheduled AND sent emails are both searchable.
- `GET /api/emails/sent?search=...` runs fuzzy `multi_match` over recipient/subject/body/sender, user-scoped, `SENT`+`FAILED` statuses. The scheduled tab is Postgres-backed (authoritative).
- If ES is down, the sent endpoint **degrades gracefully to Postgres** with `degraded: true` instead of erroring.

### 3.5 Auth
- Real Google OAuth: `/api/auth/google/url` → consent → `/api/auth/google/callback` (state-cookie CSRF guard) → upsert user → signed JWT session cookie.
- Frontend sends `Authorization: Bearer <token>`; 401 clears state and redirects to login.
- Dev/demo helper: `POST /api/auth/dev-token {"email":...}` returns a bearer token (disabled when `NODE_ENV=production`).

### 3.6 Rate-limiting scopes (all env-configurable)
| Scope | Env var | Redis key |
|---|---|---|
| Global hourly cap | `MAX_EMAILS_PER_HOUR` (default 200) | `rl:hour:<window>:global` |
| Per-sender hourly cap | `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 0 = off) | `rl:hour:<window>:sender:<email>` |
| Per-batch hourly cap (Compose UI "Hourly Limit") | per-request `hourlyLimit` | `rl:hour:<window>:batch:<batchId>` |
| Min delay between any two sends | `MIN_SEND_DELAY_SECONDS` (default 2) | `rl:throttle:global` |

---

## 4. What YOU need to do (environment additions)

### 4.1 Create `backend/.env`
```bash
cp .env.example backend/.env
```
Everything works out of the box **except the two OAuth pairs**, which you must fill in:

**Google (required for real login):**
1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) → Create credentials → OAuth client ID → **Web application**.
2. Authorized redirect URI: `http://localhost:4000/api/auth/google/callback`
3. Copy client id/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `backend/.env`.

**Slack (required for rate-limit alerts):**
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch.
2. OAuth & Permissions → Redirect URL: `http://localhost:4000/api/slack/callback`; add scopes `chat:write`, `incoming-webhook`, `channels:read`.
3. Copy `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` into `backend/.env`.

Until these are filled: the login page's Google button will error (use the dev-token flow for testing) and Slack alerts silently no-op. Everything else — scheduling, sending, persistence, rate limiting, ES search, Bull Board, the whole dashboard — runs without any credentials.

**Optional tuning** (all have sane defaults): `WORKER_CONCURRENCY=5`, `MIN_SEND_DELAY_SECONDS=2`, `MAX_EMAILS_PER_HOUR=200`, `MAX_EMAILS_PER_HOUR_PER_SENDER=0`, `MAX_ATTEMPTS=5`, `BACKOFF_MS=5000`, `BULL_BOARD_USER=admin`, `BULL_BOARD_PASSWORD=admin123`.

### 4.2 Prerequisites
- **Node.js 20+**
- **Docker Desktop** (for postgres/redis/elasticsearch)

---

## 5. How to run it (from zero)

```bash
# 1. Start infrastructure (postgres :5432, redis :6379, elasticsearch :9200)
docker compose up -d
docker compose ps          # wait until all three are "healthy"

# 2. Install dependencies (npm workspaces: backend + frontend)
npm install

# 3. Configure environment
cp .env.example backend/.env   # then fill Google/Slack creds (see 4.1)

# 4. Create the database schema
npm run prisma:migrate --workspace backend

# 5. Start both backend (:4000) and frontend (:5173) together
npm run dev
```

Then:
- **Dashboard UI:** http://localhost:5173
- **API:** http://localhost:4000 (health probe: `/healthz`)
- **Bull Board:** http://localhost:4000/admin/queues — user `admin`, pass `admin123`

**Optional — run the worker as a separate process** (it also boots inside the API for one-command demos):
```bash
npm run worker --workspace backend
```

### 5.1 Login without Google credentials (dev)
```bash
curl -X POST localhost:4000/api/auth/dev-token \
  -H 'Content-Type: application/json' -d '{"email":"me@test.com"}'
# → {"token":"eyJ..."} — the UI accepts pasting this; or use Postman with Bearer auth
```

### 5.2 Schedule via API (Postman/curl)
```bash
TOKEN=<paste dev token>

curl -X POST localhost:4000/api/emails/schedule \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "senderEmail": "outreach@mycompany.com",
    "recipients": ["a@test.com", "b@test.com", "c@test.com"],
    "subject": "Hello",
    "body": "World",
    "startAt": "2026-09-30T10:00:00Z",
    "delaySeconds": 5,
    "hourlyLimit": 50
  }'
```

### 5.3 Verify the full demo loop
1. Compose in the UI → recipient chips / Upload List (CSV/TXT shows the detected count) → subject + body → set Delay + Hourly Limit → Send Later → pick time → Send.
2. Watch the Scheduled nav count; rows flip to Sent as workers fire.
3. Open an Ethereal preview URL from the API response/log to see the rendered fake email at ethereal.email.
4. Search in Sent (ES fuzzy search); check Bull Board for live queue counts.
5. **Restart test:** Ctrl+C the backend → `npm run dev:backend` → future emails still send on time; nothing re-sends.
6. **Rate-limit test:** set `MAX_EMAILS_PER_HOUR=5` in `backend/.env` (or Hourly Limit = 2 in Compose), schedule 20 emails → only the cap sends, the rest park as delayed and drain next window in order; Slack pings once (if connected).

---

## 6. Version control notes

The repo is structured as a monorepo (root `package.json` with `backend/` + `frontend/` workspaces).

**What is intentionally not committed** (see [.gitignore](.gitignore)):
- `backend/.env` — real credentials stay local; `.env.example` is the committed template
- `node_modules/`, `dist/` builds, logs

`.env.example` documents every variable with setup links (Google Cloud Console, Slack app),
so a fresh clone only needs: `cp .env.example backend/.env`, fill the two OAuth pairs, and
follow the README Quick Start.

---

## 7. Deployment (if needed beyond local demo)

The design is deploy-ready beyond the local demo. **In production mode**
(`NODE_ENV=production`), the backend also serves the built React app from
`frontend/dist` on the same origin, so one URL hosts the whole application and
the frontend's relative `/api` calls need no CORS or proxy configuration:

- **Anything with Docker:** `docker compose up -d` covers the datastores. For the apps, build images (`npm run build` produces `backend/dist` + `frontend/dist`) and run behind any reverse proxy; set env vars instead of `.env` files.
- **Render/Railway/Fly.io recipe (backend + frontend in one service):**
  1. Create Postgres, Redis, and (optionally) Elasticsearch add-ons — or use Elastic Cloud.
  2. One web service: build command `npm install && npm run build --workspaces` (backend `tsc` + Vite bundle), start command `npm run start --workspace backend`.
  3. Environment: `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `ELASTICSEARCH_URL`, `SESSION_SECRET` (32+ random chars), `BULL_BOARD_USER/PASSWORD`, and public URLs in `FRONTEND_URL` / `CORS_ORIGINS` / `GOOGLE_REDIRECT_URI` / `SLACK_REDIRECT_URI`.
  4. Optional second service for the worker (`npm run worker --workspace backend`) with the same env — BullMQ/Redis makes multi-instance safe.
  5. Add the public redirect URIs (`https://<app>/api/auth/google/callback`, `https://<app>/api/slack/callback`) in the Google Cloud Console and Slack app settings.
- **Production notes:** `NODE_ENV=production` disables `/api/auth/dev-token`, serves `frontend/dist`, and switches session cookies to `secure`; change `BULL_BOARD_USER/PASSWORD` and `SESSION_SECRET`; keep `JOB_RETENTION_MS` for queue hygiene; scale workers horizontally — the Redis-atomic rate limiter keeps caps correct across instances by design.

---

## 8. Assumptions & trade-offs

1. **In-process worker by default** — one command for the demo, fully separable (`npm run worker`).
2. **Ethereal auto-provisioning** — unknown senders get fresh Ethereal accounts, persisted.
3. **Min-send delay is global** (shared-IP provider throttling model); per-sender throttling is a small change.
4. **Fixed epoch-hour windows**, not rolling — cheaper, explainable, good enough for provider caps.
5. **Client-side CSV parsing** for instant feedback; the server re-validates every recipient anyway.
6. **Search is best-effort** — ES failure never blocks scheduling or sending; Postgres is truth.
7. **Bull Board protected by basic auth** for the demo; swap for SSO behind a proxy in production.
