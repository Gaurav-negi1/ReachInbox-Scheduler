import type Redis from "ioredis";
import { config } from "../config";

/**
 * Redis-backed, multi-instance-safe rate limiting + throttle for email sends.
 *
 * Keys:
 *   rl:hour:{hourWindow}:{scope}     -> count of sends in this hour window
 *   rl:throttle:global               -> ms timestamp when the next send is allowed
 *   rl:overflow:{window}:{scope}     -> overflow rank for limit-hit scopes
 *   rl:alert:{window}:{scope}        -> Slack alert dedupe (SET NX, multi-instance safe)
 *
 * hourWindow = floor(epochMs / 3600000). Counters expire after 2 hours.
 *
 * A single atomic Lua script claims a send slot: the min-delay throttle and ALL
 * hourly caps (global, per-sender, per-batch) are checked-and-claimed in ONE
 * Redis round trip. The clock is Redis TIME, so multiple app servers with skewed
 * clocks can never collectively exceed a cap or sneak past the throttle. Redis
 * executes scripts serially, so check-then-increment inside the script is
 * race-free — a denied claim never consumes capacity.
 *
 * When an hourly cap is hit, the caller takes a rank in the next window's
 * overflow queue and computes an exact future timestamp, so 1000+ emails drain
 * in arrival order, limit-per-window, instead of all retrying simultaneously.
 */

const HOUR_SECONDS = 3600;
const THROTTLE_KEY = "rl:throttle:global";

export type LimitReason = "global" | "sender" | "batch";

export type ClaimResult =
  | { allowed: true }
  | { allowed: false; reason: "throttle" | LimitReason; retryAtMs: number };

/**
 * KEYS[1] throttle key   KEYS[2] global counter   KEYS[3] sender counter   KEYS[4] batch counter
 * ARGV[1] minDelayMs     ARGV[2] globalCap        ARGV[3] senderCap        ARGV[4] batchCap
 * (cap <= 0 means "unlimited" for that scope; the script skips it)
 *
 * Returns:
 *   {1}                allowed — all counters incremented, throttle advanced
 *   {0, nextAllowedMs} min-delay throttle hit — nothing incremented
 *   {2, code}          hourly cap hit — code 2=global 3=sender 4=batch
 */
const CLAIM_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)

-- 1) Min-delay throttle: key holds the ms timestamp when the next send is allowed.
local nextAllowed = tonumber(redis.call('GET', KEYS[1]) or '0')
if now < nextAllowed then
  return {0, nextAllowed}
end

-- 2) Per-sender hourly cap.
local senderCap = tonumber(ARGV[3])
if senderCap > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') >= senderCap then
  return {2, 3}
end

-- 3) Per-batch hourly cap (compose-time "Hourly Limit").
local batchCap = tonumber(ARGV[4])
if batchCap > 0 and tonumber(redis.call('GET', KEYS[4]) or '0') >= batchCap then
  return {2, 4}
end

-- 4) Global hourly cap.
local globalCap = tonumber(ARGV[2])
if globalCap > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= globalCap then
  return {2, 2}
end

-- All checks passed: claim the slots (TTLs on first increment) and advance the throttle.
if senderCap > 0 then
  if redis.call('INCR', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], 7200) end
end
if batchCap > 0 then
  if redis.call('INCR', KEYS[4]) == 1 then redis.call('EXPIRE', KEYS[4], 7200) end
end
if globalCap > 0 then
  if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], 7200) end
end
local minDelay = tonumber(ARGV[1])
redis.call('SET', KEYS[1], now + minDelay, 'PX', minDelay + 60000)
return {1}
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
async function overflowRetryAtMs(
  redis: Redis,
  reason: LimitReason,
  senderEmail: string,
  batchId: string | null | undefined,
  limit: number
): Promise<number> {
  const nextWindow = hourWindow() + 1;
  const overflowKey = `rl:overflow:${nextWindow}:${scopeFor(reason, senderEmail, batchId)}`;
  const rank = await redis.incr(overflowKey);
  if (rank === 1) await redis.expire(overflowKey, 3 * HOUR_SECONDS);
  const idx = rank - 1;
  const capacity = Math.max(1, limit);
  const windowsAhead = 1 + Math.floor(idx / capacity);
  const posInWindow = idx % capacity;
  return (
    (nextWindow + windowsAhead - 1) * HOUR_SECONDS * 1000 +
    posInWindow * config.worker.minSendDelaySeconds * 1000
  );
}

/**
 * Atomically try to reserve permission to send one email now.
 * Order: min-delay throttle first (cheapest), then per-sender cap, then
 * per-batch cap (compose-time "Hourly Limit"), then global cap.
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
  const minDelayMs = config.worker.minSendDelaySeconds * 1000;

  const result = (await redis.eval(
    CLAIM_LUA,
    4,
    THROTTLE_KEY,
    globalHourKey(),
    senderHourKey(senderEmail),
    batchHourKey(batchId ?? "none"),
    String(minDelayMs),
    String(globalCap),
    String(senderCap),
    String(batchCap)
  )) as [number, number?];

  if (result[0] === 1) return { allowed: true };

  if (result[0] === 0) {
    // Min-delay throttle: the script returned the exact next-allowed timestamp.
    return { allowed: false, reason: "throttle", retryAtMs: Number(result[1]) };
  }

  // Hourly cap hit — nothing was incremented. Take an ordered overflow slot in
  // the next window so waiting jobs drain in arrival order, limit per window.
  const code = Number(result[1]);
  const reason: LimitReason = code === 3 ? "sender" : code === 4 ? "batch" : "global";
  const limit = reason === "global" ? globalCap : reason === "sender" ? senderCap : batchCap;
  const retryAtMs = await overflowRetryAtMs(redis, reason, senderEmail, batchId, limit);
  return { allowed: false, reason, retryAtMs };
}

export function releaseHourlySlots(
  redis: Redis,
  senderEmail: string,
  batchId?: string | null,
  batchLimit?: number | null
): Promise<void> {
  // Called when an SMTP send ultimately fails, so a failed attempt does not
  // permanently consume rate-limit capacity.
  const decrements: Array<Promise<unknown>> = [];
  if (config.worker.maxPerHourGlobal > 0) decrements.push(redis.decr(globalHourKey()));
  if (config.worker.maxPerHourPerSender > 0) decrements.push(redis.decr(senderHourKey(senderEmail)));
  if (batchId && batchLimit && batchLimit > 0) decrements.push(redis.decr(batchHourKey(batchId)));
  return Promise.all(decrements).then(() => undefined);
}

/** True only for the first limit-hit per scope per window — Redis NX dedupe (multi-instance safe). */
export async function shouldAlertRateLimit(
  redis: Redis,
  reason: LimitReason,
  senderEmail: string,
  batchId?: string | null
): Promise<boolean> {
  const key = `rl:alert:${hourWindow()}:${scopeFor(reason, senderEmail, batchId)}`;
  const result = await redis.set(key, "1", "EX", 7200, "NX");
  return result === "OK";
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
    const pattern = `rl:hour:${hourWindow()}:sender:*`;
    const keys = await redis.keys(pattern);
    for (const key of keys) {
      const email = key.slice(pattern.length - 1);
      perSender[email] = Number((await redis.get(key)) ?? 0);
    }
  }
  return {
    globalSentThisHour: globalCount,
    globalLimit: config.worker.maxPerHourGlobal,
    perSender,
    senderLimit: config.worker.maxPerHourPerSender,
    windowResetsInMs: msUntilNextHour(),
  };
}
