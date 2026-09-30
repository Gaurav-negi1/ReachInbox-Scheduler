/* Integration harness: real Redis + real BullMQ + real worker/rateLimiter/reaper,
 * fake Prisma (in-memory), fake SMTP, local Slack-webhook catcher.
 * Usage: SCENARIO=cap|throttle|retry|markSent|reaper REDIS_URL=... tsx scripts/integration-harness.ts */
import http from "http";
import path from "path";

const SCENARIO = process.env.SCENARIO ?? "cap";
const realNow = Date.now.bind(Date);
// Shift the clock so the next clock-hour boundary is ~7s away.
const boundaryReal = Math.ceil(realNow() / 3_600_000) * 3_600_000;
const OFFSET = SCENARIO === "cap" ? boundaryReal - 7000 - realNow() : 0;
Date.now = () => realNow() + OFFSET;
const BOUNDARY = boundaryReal - OFFSET + OFFSET; // boundary in shifted time == boundaryReal
const t0 = Date.now();
const rel = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

// ---------- fakes ----------
type Row = Record<string, any>;
const db = new Map<string, Row>();
const alerts: Row[] = [];
const users = new Map<string, Row>();
let failSentUpdates = 0;
const sends: { to: string; at: number }[] = [];
let failNextSends = 0;
let sendCalls = 0;

const fakePrisma: any = {
  async $queryRaw(strings: TemplateStringsArray, ...vals: any[]) {
    const sql = strings.join("?");
    if (/SELECT 1/.test(sql)) return [{ "?column?": 1 }];
    const id = vals[0];
    const r = db.get(id);
    if (r && (r.status === "SCHEDULED" || r.status === "SENDING")) {
      r.status = "SENDING";
      r.attemptCount += 1;
      r.nextAttemptAt = null;
      return [{ id, status: r.status }];
    }
    return [];
  },
  scheduledEmail: {
    async findUnique({ where }: any) { const r = db.get(where.id); return r ? { ...r } : null; },
    async update({ where, data }: any) {
      const r = db.get(where.id)!;
      if (data.status === "SENT" && failSentUpdates > 0) { failSentUpdates--; throw new Error("injected db failure"); }
      for (const [k, v] of Object.entries<any>(data)) {
        if (v && typeof v === "object" && "decrement" in v) r[k] -= v.decrement; else r[k] = v;
      }
      return { ...r };
    },
    async findMany({ where, orderBy, take, skip, cursor }: any) {
      let rows = [...db.values()].filter((r) => !where?.status || (typeof where.status === "string" ? r.status === where.status : true));
      if (where?.sentAt === null) rows = rows.filter((r) => r.sentAt == null);
      rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (cursor) rows = rows.slice(rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
      return rows.slice(0, take ?? rows.length).map((r) => ({ ...r }));
    },
  },
  attachment: { async findMany() { return []; } },
  user: { async findUnique({ where }: any) { return users.get(where.id) ?? null; } },
  rateLimitAlert: { async create({ data }: any) { alerts.push(data); return data; } },
  async $disconnect() {},
};

function stub(modRel: string, exports: any) {
  const p = require.resolve(path.resolve(__dirname, "..", modRel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] } as any;
}
stub("src/lib/prisma.ts", { prisma: fakePrisma });
stub("src/lib/mailer.ts", {
  async sendMail(_s: string, o: any) {
    sendCalls++;
    if (failNextSends > 0) { failNextSends--; throw new Error("injected smtp failure"); }
    sends.push({ to: o.to, at: Date.now() });
    console.log(`${rel()}  SEND -> ${o.to}`);
    return { messageId: `<m-${sendCalls}>`, previewUrl: null };
  },
});
stub("src/lib/elasticsearch.ts", { async indexEmail() {}, async bulkIndexEmails() {}, esAvailable: () => false, async ensureEmailsIndex() {} });

// ---------- Slack webhook catcher ----------
const slackHits: string[] = [];
const hook = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { slackHits.push(b); res.end("ok"); console.log(`${rel()}  SLACK webhook POST received`); });
});

function mkRow(i: number, extra: Row = {}): Row {
  const id = `row-${String(i).padStart(3, "0")}`;
  return { id, userId: "u1", senderEmail: "s@x.test", recipientEmail: `r${i}@x.test`, subject: "hi", body: "b", bodyHtml: null,
    status: "SCHEDULED", scheduledAt: new Date(Date.now()), sentAt: null, attemptCount: 0, lastError: null, hourlyLimit: null,
    batchId: "batch-1", nextAttemptAt: null, starred: false, ...extra };
}

async function main() {
  const { connection, emailQueue } = await import("../src/lib/queue");
  await connection.flushall();
  await new Promise<void>((r) => hook.listen(0, r));
  const hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/hook`;
  users.set("u1", { id: "u1", slackWebhook: hookUrl });
  const { startWorker } = await import("../src/worker");
  const { startStaleReaper } = await import("../src/lib/staleReaper");
  const { config } = await import("../src/config");
  const opts = { attempts: 3, backoff: { type: "fixed" as const, delay: 1000 } };
  const enqueue = async (row: Row, delay = 0) => emailQueue.add("send", {
    emailRecordId: row.id, senderEmail: row.senderEmail, recipientEmail: row.recipientEmail, subject: "hi", body: "b", batchId: row.batchId, userId: row.userId,
  }, { jobId: `send-${row.id}`, delay, ...opts });
  const waitFor = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); };
  const report = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`); if (!ok) process.exitCode = 1; };
  console.log(`scenario=${SCENARIO} cfg=${JSON.stringify({ c: config.worker.concurrency, d: config.worker.minSendDelaySeconds, g: config.worker.maxPerHourGlobal })}`);

  let worker = startWorker();

  if (SCENARIO === "cap") {
    // global cap 3, 6 emails due now, hour boundary in ~7s.
    for (let i = 1; i <= 6; i++) { const r = mkRow(i); db.set(r.id, r); await enqueue(r); }
    await waitFor(() => sends.length >= 3, 15000);
    await new Promise((r) => setTimeout(r, 2500));
    report("only 3 sent inside first window", sends.length === 3, `(sent=${sends.length})`);
    const parked = [...db.values()].filter((r) => r.status === "SCHEDULED");
    report("3 rows parked as SCHEDULED with nextAttemptAt in next window",
      parked.length === 3 && parked.every((r) => r.nextAttemptAt && r.nextAttemptAt.getTime() >= BOUNDARY), `(parked=${parked.length})`);
    report("parked rows were not counted as delivery attempts", parked.every((r) => r.attemptCount === 0));
    report("Slack webhook hit exactly once for the window (deduped)", slackHits.length === 1, `(hits=${slackHits.length})`);
    report("in-app alert row recorded once with slackSent=true", alerts.length === 1 && alerts[0].slackSent === true);
    const counts0 = await emailQueue.getJobCounts("delayed", "active", "waiting");
    report("parked jobs sit in BullMQ 'delayed' (not stuck active)", counts0.delayed === 3 && counts0.active === 0, JSON.stringify(counts0));
    await waitFor(() => sends.length >= 6, 25000);
    report("all 6 sent after window rolled over", sends.length === 6, `(sent=${sends.length})`);
    const late = sends.slice(3);
    report("parked emails sent only AFTER the hour boundary", late.every((s) => s.at >= BOUNDARY), `(first late send ${((late[0]?.at ?? 0) - BOUNDARY)}ms after boundary)`);
    report("no duplicates", new Set(sends.map((s) => s.to)).size === 6);
    report("min delay respected between sends (>=~1s apart)", sends.slice(1).every((s, i) => s.at - sends[i].at >= 900), `(gaps ${sends.slice(1).map((s, i) => s.at - sends[i].at).join(",")}ms)`);
  }

  if (SCENARIO === "slacklate") {
    // cap=1: Slack NOT connected at first hit; connect it; next hit in SAME window must notify.
    users.set("u1", { id: "u1" });
    for (let i = 1; i <= 2; i++) { const r = mkRow(i); db.set(r.id, r); await enqueue(r); }
    await waitFor(() => alerts.length >= 1, 8000);
    report("no Slack + limit hit -> no crash, in-app alert recorded, nothing posted", alerts.length === 1 && alerts[0].slackSent === false && slackHits.length === 0);
    users.set("u1", { id: "u1", slackWebhook: hookUrl }); // user connects Slack now
    const r3 = mkRow(3); db.set(r3.id, r3); await enqueue(r3);
    await waitFor(() => slackHits.length >= 1, 8000);
    report("after connecting Slack (same window, no redeploy) next hit is delivered", slackHits.length === 1, `(hits=${slackHits.length})`);
    await new Promise((r) => setTimeout(r, 1500));
    const r4 = mkRow(4); db.set(r4.id, r4); await enqueue(r4);
    await new Promise((r) => setTimeout(r, 2500));
    report("...and is then deduped for the rest of the window", slackHits.length === 1, `(hits=${slackHits.length})`);
  }

  if (SCENARIO === "load") {
    const N = 1000;
    for (let i = 1; i <= N; i++) { const r = mkRow(i); db.set(r.id, r); }
    const t1 = Date.now();
    await emailQueue.addBulk([...db.values()].map((row) => ({ name: "send", data: { emailRecordId: row.id, senderEmail: row.senderEmail, recipientEmail: row.recipientEmail, subject: "hi", body: "b", batchId: row.batchId, userId: row.userId }, opts: { jobId: `send-${row.id}`, ...opts } })));
    await waitFor(() => [...db.values()].every((r) => r.status === "SENT" || r.nextAttemptAt), 60000);
    const c = await emailQueue.getJobCounts("delayed", "active", "waiting", "completed", "failed");
    console.log(`drained first pass in ${Date.now() - t1}ms counts=${JSON.stringify(c)}`);
    const parked = [...db.values()].filter((r) => r.status === "SCHEDULED");
    const byWindow = new Map<number, number>();
    for (const r of parked) { const w = Math.floor(r.nextAttemptAt.getTime() / 3_600_000) - Math.floor(Date.now() / 3_600_000); byWindow.set(w, (byWindow.get(w) ?? 0) + 1); }
    report("exactly the cap (200) sent in this window", sends.length === 200, `(sent=${sends.length})`);
    report("800 parked in BullMQ delayed, none dropped/failed", parked.length === 800 && c.delayed === 800 && c.failed === 0, JSON.stringify(c));
    report("overflow drains 200 per future hour window, in order", JSON.stringify([...byWindow.entries()].sort()) === JSON.stringify([[1,200],[2,200],[3,200],[4,200]]), JSON.stringify([...byWindow.entries()].sort()));
    report("one Slack alert for the whole burst", slackHits.length === 1, `(hits=${slackHits.length})`);
  }

  if (SCENARIO === "throttle") {
    for (let i = 1; i <= 6; i++) { const r = mkRow(i); db.set(r.id, r); await enqueue(r); }
    await waitFor(() => sends.length >= 6, 20000);
    report("all 6 sent", sends.length === 6);
    const gaps = sends.slice(1).map((s, i) => s.at - sends[i].at);
    report("sends spaced >= min delay", gaps.every((g) => g >= 900), `(gaps ${gaps.join(",")}ms)`);
    report("each job processed once (no re-park churn)", [...db.values()].every((r) => r.attemptCount === 1), `(attempts ${[...db.values()].map((r) => r.attemptCount)})`);
  }

  if (SCENARIO === "retry") {
    failNextSends = 1;
    const r = mkRow(1); db.set(r.id, r); await enqueue(r);
    await waitFor(() => sends.length >= 1, 10000);
    await new Promise((res) => setTimeout(res, 500));
    report("failed attempt retried and delivered once", sendCalls === 2 && sends.length === 1 && db.get(r.id)!.status === "SENT", `(smtp calls=${sendCalls}, status=${db.get(r.id)!.status})`);
    const key = `rl:hour:${Math.floor(Date.now() / 3_600_000)}:global`;
    report("rate-limit slot released on failed attempt (counter == 1 after 1 success)", (await connection.get(key)) === "1", `(counter=${await connection.get(key)})`);
  }

  if (SCENARIO === "markSent") {
    failSentUpdates = 3; // DB down for the post-send write
    const r = mkRow(1); db.set(r.id, r); await enqueue(r);
    await new Promise((res) => setTimeout(res, 6000));
    report("email delivered exactly ONCE even though DB write failed", sendCalls === 1, `(smtp calls=${sendCalls})`);
    report("row left SENDING for the reaper (not retried/resent)", db.get(r.id)!.status === "SENDING");
    await worker.close();
    await startStaleReaper();
    report("reaper promotes SENDING+completed-job row to SENT", db.get(r.id)!.status === "SENT", `(status=${db.get(r.id)!.status})`);
    worker = startWorker();
  }

  if (SCENARIO === "reaper") {
    // Redis "lost": rows exist, no jobs. One overdue, one due in 5s.
    const a = mkRow(1, { scheduledAt: new Date(Date.now() - 120_000) });
    const b = mkRow(2, { scheduledAt: new Date(Date.now() + 5000) });
    db.set(a.id, a); db.set(b.id, b);
    await startStaleReaper();
    const jb = await emailQueue.getJob(`send-${b.id}`);
    report("future row re-enqueued with its ORIGINAL delay (not sent early)", !!jb && (jb.opts.delay ?? 0) > 3000, `(delay=${jb?.opts.delay})`);
    await waitFor(() => sends.length >= 2, 15000);
    const sb = sends.find((s) => s.to === "r2@x.test");
    report("overdue sent promptly, future sent on time", sends.length === 2 && !!sb && sb.at - t0 >= 4500, `(r2 at ${sb ? sb.at - t0 : "-"}ms)`);
    // run reaper again: must not duplicate
    await startStaleReaper();
    await new Promise((r) => setTimeout(r, 2500));
    report("re-running reaper does not duplicate", sends.length === 2);
  }

  await worker.close(); await emailQueue.close(); await connection.quit(); hook.close();
  process.exit(process.exitCode ?? 0);
}
void main().catch((e) => { console.error(e); process.exit(1); });
