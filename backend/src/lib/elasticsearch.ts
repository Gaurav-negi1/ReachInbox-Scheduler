import { Client } from "@elastic/elasticsearch";
import type { MappingTypeMapping, QueryDslQueryContainer } from "@elastic/elasticsearch/lib/api/types";
import { config } from "../config";
import { logger } from "../logger";

export const EMAILS_INDEX = "emails";

export const esClient = new Client({
  node: config.elasticsearchUrl,
  ...(config.elasticsearchApiKey ? { auth: { apiKey: config.elasticsearchApiKey } } : {}),
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

export async function ensureEmailsIndex(): Promise<void> {
  const exists = await esClient.indices.exists({ index: EMAILS_INDEX });
  if (!exists) {
    await esClient.indices.create({
      index: EMAILS_INDEX,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: EMAILS_MAPPING,
    });
    logger.info({ index: EMAILS_INDEX }, "elasticsearch index created");
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

export async function indexEmail(doc: EmailDoc): Promise<void> {
  await esClient.index({
    index: EMAILS_INDEX,
    id: doc.id,
    document: { ...doc, lastError: doc.lastError ?? null },
    refresh: false,
  });
}

export async function deleteEmailDoc(id: string): Promise<void> {
  await esClient.delete({ index: EMAILS_INDEX, id }, { ignore: [404] });
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
