import { Client } from "@elastic/elasticsearch";
import type { MappingTypeMapping, QueryDslQueryContainer } from "@elastic/elasticsearch/lib/api/types";
import { config } from "../config";
import { logger } from "../logger";

export const EMAILS_INDEX = "emails";

/**
 * Circuit breaker for the best-effort search layer. When Elasticsearch is
 * unreachable (e.g. no ES host provisioned in a deployment), requests would
 * otherwise burn the client's internal retries on every list/search call.
 * Once a failure is seen, all ES calls short-circuit instantly for a cooldown
 * window, then a single probe is allowed through to re-detect recovery.
 */
let esDownUntil = 0;
let lastBreakerLogAt = 0;
const ES_COOLDOWN_MS = 30_000;
const BREAKER_LOG_SUPPRESS_MS = 60_000;

export function esAvailable(): boolean {
  return Date.now() >= esDownUntil;
}

function tripBreaker(err: unknown): void {
  esDownUntil = Date.now() + ES_COOLDOWN_MS;
  const now = Date.now();
  if (now - lastBreakerLogAt > BREAKER_LOG_SUPPRESS_MS) {
    lastBreakerLogAt = now;
    logger.warn(
      { err: (err as Error).message, retryProbeInMs: ES_COOLDOWN_MS },
      "elasticsearch unreachable — search degraded to Postgres (circuit open)"
    );
  }
}

export const esClient = new Client({
  node: config.elasticsearchUrl,
  ...(config.elasticsearchApiKey ? { auth: { apiKey: config.elasticsearchApiKey } } : {}),
  // Fail fast: search is best-effort, so a dead ES must not hold HTTP requests
  // for the client's default 30s timeout × 3 retries.
  requestTimeout: 3_000,
  maxRetries: 0,
});

const EMAILS_MAPPING: MappingTypeMapping = {
  properties: {
    id: { type: "keyword" },
    userId: { type: "keyword" },
    senderEmail: { type: "keyword" },
    recipientEmail: { type: "text", fields: { keyword: { type: "keyword" } } },
    subject: { type: "text" },
    body: { type: "text" },
    status: { type: "keyword" },
    scheduledAt: { type: "date" },
    sentAt: { type: "date" },
    batchId: { type: "keyword" },
    starred: { type: "boolean" },
    lastError: { type: "text" },
  },
};

/**
 * Ensure the emails index exists. Never throws: search is a best-effort layer
 * on top of Postgres (source of truth), so an unreachable ES must not break
 * scheduling or sending. Callers (schedule flow, boot) rely on this guarantee.
 */
export async function ensureEmailsIndex(): Promise<void> {
  if (!esAvailable()) return;
  try {
    const exists = await esClient.indices.exists({ index: EMAILS_INDEX });
    if (!exists) {
      await esClient.indices.create({
        index: EMAILS_INDEX,
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: EMAILS_MAPPING,
      });
      logger.info({ index: EMAILS_INDEX }, "elasticsearch index created");
    }
  } catch (err) {
    tripBreaker(err);
  }
}

export type EmailDoc = {
  id: string;
  userId: string | null;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: Date | string;
  sentAt: Date | string | null;
  batchId: string | null;
  starred?: boolean;
  lastError?: string | null;
};

/**
 * Mirror an email document into Elasticsearch. Best-effort by contract: ES is
 * a derived search layer over Postgres (source of truth), so an indexing
 * failure must never propagate into the caller's transaction. Callers that
 * want explicit handling can still catch; a warn-level log is recorded here.
 */
export async function indexEmail(doc: EmailDoc): Promise<void> {
  if (!esAvailable()) return;
  try {
    await esClient.index({
      index: EMAILS_INDEX,
      id: doc.id,
      document: { ...doc, lastError: doc.lastError ?? null },
      refresh: false,
    });
  } catch (err) {
    tripBreaker(err);
    logger.debug({ emailId: doc.id }, "elasticsearch index skipped (search may be stale)");
  }
}

export async function deleteEmailDoc(id: string): Promise<void> {
  if (!esAvailable()) return;
  try {
    await esClient.delete({ index: EMAILS_INDEX, id }, { ignore: [404] });
  } catch (err) {
    tripBreaker(err);
    logger.debug({ emailId: id }, "elasticsearch delete skipped");
  }
}

export type SearchParams = {
  userId?: string | null;
  query?: string;
  status?: string | string[];
  starred?: boolean;
  page?: number;
  pageSize?: number;
};

export async function searchEmails(params: SearchParams): Promise<{
  total: number;
  items: EmailDoc[];
}> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));

  const must: QueryDslQueryContainer[] = [];
  if (params.userId) must.push({ term: { userId: params.userId } });
  if (params.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    must.push({ terms: { status: statuses } });
  }
  if (params.starred !== undefined) must.push({ term: { starred: params.starred } });
  if (params.query) {
    must.push({
      multi_match: {
        query: params.query,
        fields: ["recipientEmail^2", "recipientEmail.keyword^3", "subject^2", "body", "senderEmail"],
        fuzziness: "AUTO",
      },
    });
  }

  if (!esAvailable()) throw new Error("elasticsearch circuit open — use Postgres fallback");

  const resp = await esClient.search({
    index: EMAILS_INDEX,
    from: (page - 1) * pageSize,
    size: pageSize,
    query: must.length ? { bool: { must } } : { match_all: {} },
    sort: params.query
      ? ["_score", { scheduledAt: { order: "desc" as const } }]
      : [{ scheduledAt: { order: "desc" as const } }],
  });

  const hits = resp.hits.hits;
  return {
    total: typeof resp.hits.total === "number" ? resp.hits.total : resp.hits.total?.value ?? 0,
    items: hits.map((h) => ({ ...(h._source as EmailDoc) })),
  };
}
