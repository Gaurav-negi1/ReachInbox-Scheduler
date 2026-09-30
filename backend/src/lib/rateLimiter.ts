import type Redis from "ioredis";
import { config } from "../config";

/**
 * Redis-backed, multi-instance-safe hourly rate limiting for email sends.
 *
 * Keys:
 *   rl:hour:{hourWindow}:{scope}     -> count of sends in this hour window
 *   rl:overflow:{window}:{scope}     -> overflow rank for limit-hit scopes
 *   rl:alert:{kind}:{window}:{scope} -> alert dedupe (SET NX, multi-instance safe)
 *
 * The min delay between individual sends is enforced as a slot RESERVATION in the
 * same script: once the hourly caps pass, the caller is handed the next free
 * send slot (`waitMs`, Redis-TIME based, shared by every worker/instance) and
 * sleeps in-process until it. This avoids the thundering herd you get from
 * "check throttle -> re-park the job -> everyone wakes together": each due job
 * gets its own distinct slot, in arrival order, with no DB/queue churn. Jobs
 * parked by an hourly cap never consume a throttle slot.
 *
 * A single atomic Lua script checks-and-claims ALL hourly caps (global,
 * per-sender, per-batch) in ONE Redis round trip. Redis executes scripts
 * serially, so check-then-increment is race-free across any number of workers
 * or app instances — a denied claim never consumes capacity.
 *
 * hourWindow = floor(epochMs / 3600000) (clock-hour aligned). Counters expire
 * after 2 hours.
 *
 * When an hourly cap is hit, the caller takes a rank in the next window's
 * overflow queue and computes an exact future timestamp, so 1000+ emails drain
 * in arrival order, `limit` per window, instead of all retrying together.
 */

const HOUR_SECONDS = 3600;
const THROTTLE_KEY = "rl:throttle:global";

export type LimitReason = "global" | "sender" | "batch";

export type ClaimResult =
  | { allowed: true; waitMs: number }
  | { allowed: false; reason: LimitReason; retryAtMs: number; queuedAhead: number };

/**
 * KEYS[1] global counter   KEYS[2] sender counter   KEYS[3] batch counter
 * KEYS[4] throttle cursor (ms timestamp of the next free send slot)
 * ARGV[1] globalCap        ARGV[2] senderCap        ARGV[3] batchCap
 * ARGV[4] minDelayMs
 * (cap <= 0 means "unlimited" for that scope; the script skips it)
 *
 * Returns:
 *   {1, w}  allowed — all counters incremented, send slot reserved; the caller
 *           must wait `w` ms (0 = send now) before sending
 *   {2, c}  hourly cap hit — c: 2=global 3=sender 4=batch (nothing incremented)
 */
const CLAIM_LUA = `
local globalCap = tonumber(ARGV[1])
local senderCap = tonumber(ARGV[2])
local batchCap  = tonumber(ARGV[3])
local minDelay  = tonumber(ARGV[4])

if senderCap > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= senderCap then
  return {2, 3}
end
if batchCap > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') >= batchCap then
  return {2, 4}
end
if globalCap > 0 and tonumber(redis.call('GET', KEYS[1]) or '0') >= globalCap then
  return {2, 2}
end

if senderCap > 0 then
  if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], 7200) end
end
if batchCap > 0 then
  if redis.call('INCR', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], 7200) end
end
if globalCap > 0 then
  if redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], 7200) end
end

-- Reserve the next free send slot (min-delay throttle) using Redis TIME so
-- app servers with skewed clocks cannot collectively beat the throttle.
local wait = 0
if minDelay > 0 then
  local t = redis.call('TIME')
  local now = t[1] * 1000 + math.floor(t[2] / 1000)
  local nextAt = tonumber(redis.call('GET', KEYS[4]) or '0')
  local slot = now
  if nextAt > now then slot = nextAt end
  redis.call('SET', KEYS[4], slot + minDelay, 'PX', (slot - now) + minDelay + 60000)
  wait = slot - now
end
return {1, wait}
`;

/** Decrement but never below zero, and never resurrect an expired key. */
const RELEASE_LUA = `
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`;

export function hourWindow(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / HOUR_SECONDS);
}

export function msUntilNextHour(atMs: number = Date.now()): number {
  const windowStart = hourWindow(atMs) * HOUR_SECONDS * 1000;
  return windowStart + HOUR_SECONDS * 1000 - atMs;
}

export function globalHourKey(atMs: number = Date.now()): string {
  return `rl:hour:${hourWindow(atMs)}:global`;
}

export function senderHourKey(senderEmail: string, atMs: number = Date.now()): string {
  return `rl:hour:${hourWindow(atMs)}:sender:${senderEmail}`;
}

export function batchHourKey(batchId: string, atMs: number = Date.now()): string {
  return `rl:hour:${hourWindow(atMs)}:batch:${batchId}`;
}

function scopeFor(reason: LimitReason, senderEmail: string, batchId?: string | null): string {
  return reason === "global"
    ? "global"
    : reason === "sender"
      ? `sender:${senderEmail}`
      : `batch:${batchId ?? "none"}`;
}

/**
 * Overflow rank for a limit-hit scope in the NEXT hour window. Rank N (0-based)
 * in a window with capacity `limit` drains at windowStart + N*minDelay, spilling
 * into later windows once each window's capacity is full — arrival order kept.
 */
async function overflowRetryAt(
  redis: Redis,
  reason: LimitReason,
  senderEmail: string,
  batchId: string | null | undefined,
  limit: number
): Promise<{ retryAtMs: number; queuedAhead: number }> {
  const nextWindow = hourWindow() + 1;
  const overflowKey = `rl:overflow:${nextWindow}:${scopeFor(reason, senderEmail, batchId)}`;
  const rank = await redis.incr(overflowKey);
  if (rank === 1) await redis.expire(overflowKey, 3 * HOUR_SECONDS);
  const idx = rank - 1;
  const capacity = Math.max(1, limit);
  const windowsAhead = 1 + Math.floor(idx / capacity);
  const posInWindow = idx % capacity;
  return {
    retryAtMs:
      (nextWindow + windowsAhead - 1) * HOUR_SECONDS * 1000 +
      posInWindow * config.worker.minSendDelaySeconds * 1000,
    queuedAhead: idx,
  };
}

/**
 * Atomically try to reserve hourly capacity to send one email now.
 * Order: per-sender cap, per-batch cap (compose-time "Hourly Limit"), global cap.
 */
export async function tryClaimSendSlot(
  redis: Redis,
  senderEmail: string,
  batchId?: string | null,
  batchLimit?: number | null
): Promise<ClaimResult> {
  const globalCap = Math.max(0, Math.floor(config.worker.maxPerHourGlobal));
  const senderCap = Math.max(0, Math.floor(config.worker.maxPerHourPerSender));
  const batchCap = batchId && batchLimit && batchLimit > 0 ? Math.floor(batchLimit) : 0;

  const minDelayMs = Math.max(0, Math.floor(config.worker.minSendDelaySeconds * 1000));

  const now = Date.now();
  const result = (await redis.eval(
    CLAIM_LUA,
    4,
    globalHourKey(now),
    senderHourKey(senderEmail, now),
    batchHourKey(batchId ?? "none", now),
    THROTTLE_KEY,
    String(globalCap),
    String(senderCap),
    String(batchCap),
    String(minDelayMs)
  )) as [number, number?];

  if (result[0] === 1) return { allowed: true, waitMs: Number(result[1] ?? 0) };

  // Hourly cap hit — nothing was incremented. Take an ordered overflow slot in
  // the next window so waiting jobs drain in arrival order, limit per window.
  const code = Number(result[1]);
  const reason: LimitReason = code === 3 ? "sender" : code === 4 ? "batch" : "global";
  const limit = reason === "global" ? globalCap : reason === "sender" ? senderCap : batchCap;
  const { retryAtMs, queuedAhead } = await overflowRetryAt(redis, reason, senderEmail, batchId, limit);
  return { allowed: false, reason, retryAtMs, queuedAhead };
}

/**
 * Give back the capacity claimed by tryClaimSendSlot (used when an SMTP attempt
 * fails, so a failed attempt does not permanently consume the hourly budget).
 * `claimedAtMs` pins the release to the window the slot was claimed in.
 */
export async function releaseHourlySlots(
  redis: Redis,
  senderEmail: string,
  batchId: string | null | undefined,
  batchLimit: number | null | undefined,
  claimedAtMs: number = Date.now()
): Promise<void> {
  const keys: string[] = [];
  if (config.worker.maxPerHourGlobal > 0) keys.push(globalHourKey(claimedAtMs));
  if (config.worker.maxPerHourPerSender > 0) keys.push(senderHourKey(senderEmail, claimedAtMs));
  if (batchId && batchLimit && batchLimit > 0) keys.push(batchHourKey(batchId, claimedAtMs));
  if (!keys.length) return;
  await redis.eval(RELEASE_LUA, keys.length, ...keys);
}

export type AlertKind = "app" | "slack";

/**
 * True only for the first caller per (kind, scope, window) — Redis NX dedupe
 * (multi-instance safe). `app` dedupes the in-app alert row; `slack` dedupes
 * the Slack message separately so that connecting Slack mid-window still gets
 * the next hit delivered.
 */
export async function shouldAlertRateLimit(
  redis: Redis,
  reason: LimitReason,
  senderEmail: string,
  batchId?: string | null,
  kind: AlertKind = "app"
): Promise<boolean> {
  const key = `rl:alert:${kind}:${hourWindow()}:${scopeFor(reason, senderEmail, batchId)}`;
  const result = await redis.set(key, "1", "EX", 7200, "NX");
  return result === "OK";
}

/** Undo an alert claim (e.g. Slack delivery failed / Slack not connected). */
export async function releaseAlert(
  redis: Redis,
  reason: LimitReason,
  senderEmail: string,
  batchId?: string | null,
  kind: AlertKind = "app"
): Promise<void> {
  await redis.del(`rl:alert:${kind}:${hourWindow()}:${scopeFor(reason, senderEmail, batchId)}`);
}

export async function getRateLimitSnapshot(redis: Redis): Promise<{
  globalSentThisHour: number;
  globalLimit: number;
  perSender: Record<string, number>;
  senderLimit: number;
  windowResetsInMs: number;
}> {
  const globalCount = Number((await redis.get(globalHourKey())) ?? 0);
  const perSender: Record<string, number> = {};
  if (config.worker.maxPerHourPerSender > 0) {
    const prefix = `rl:hour:${hourWindow()}:sender:`;
    // SCAN (non-blocking) instead of KEYS, which is O(N) and blocks Redis.
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        perSender[key.slice(prefix.length)] = Number((await redis.get(key)) ?? 0);
      }
    } while (cursor !== "0");
  }
  return {
    globalSentThisHour: globalCount,
    globalLimit: config.worker.maxPerHourGlobal,
    perSender,
    senderLimit: config.worker.maxPerHourPerSender,
    windowResetsInMs: msUntilNextHour(),
  };
}
