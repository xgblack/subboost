import { normalizeSavedSourcesForPersistence } from "@subboost/server-core/subscription";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import { prisma } from "./prisma";
import { readSubscriptionSecrets } from "./subscription-service";
import { countSourceNodes, sourceDisplay } from "./subscription-source-update-store";
import type { SourceUpdateHistoryPage, SubscriptionSourceSummary } from "./subscription-source-types";

export class SourceHistoryInputError extends Error {}

export async function listSubscriptionSources(
  ownerId: string,
  subscriptionId: string,
): Promise<SubscriptionSourceSummary[] | null> {
  const row = await prisma.subscription.findFirst({
    where: { id: subscriptionId, ownerId },
    include: { sourceUpdateStates: true },
  });
  if (!row) return null;
  const secrets = readSubscriptionSecrets(row);
  const sources = normalizeSavedSourcesForPersistence(secrets.config.sources, { fallbackUrls: secrets.urls });
  const hasUnownedNodes = secrets.nodes.some((node) => !getNodeSourceIds(node).length);
  return sources.map((source) => {
    const state = row.sourceUpdateStates.find((item) => item.sourceId === source.id);
    const nodeCount = countSourceNodes(secrets.nodes, source.id);
    const clientManaged = source.type === "url" && source.useProxyProviders === true;
    return {
      id: source.id,
      type: source.type,
      ...sourceDisplay(source),
      clientManaged,
      canRefresh: !clientManaged && !(hasUnownedNodes && !nodeCount),
      nodeCount,
      lastAttemptedAt: state?.lastAttemptedAt.toISOString() ?? null,
      lastSuccessfulAt: state?.lastSuccessfulAt?.toISOString() ?? null,
      lastResult: state?.lastResult ?? null,
      lastError: state?.lastError ?? null,
      warningCount: state?.warningCount ?? 0,
    };
  });
}

type HistoryCursor = { completedAt: Date; id: string };

export function parseSourceHistoryPage(search: URLSearchParams): {
  limit: number;
  cursor: HistoryCursor | null;
} {
  const rawLimit = search.get("limit");
  const limit = rawLimit === null ? 20 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > 100) throw new SourceHistoryInputError("每页记录数必须在 1 到 100 之间。");
  const encoded = search.get("cursor");
  if (!encoded) return { limit, cursor: null };
  try {
    if (encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const completedAt = new Date(value.completedAt);
    if (
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
      typeof value.completedAt !== "string" ||
      !Number.isFinite(completedAt.getTime())
    )
      throw new Error();
    return { limit, cursor: { id: value.id, completedAt } };
  } catch {
    throw new SourceHistoryInputError("更新记录的分页参数无效，请重新打开历史。");
  }
}

export async function getSubscriptionSourceHistory(
  ownerId: string,
  subscriptionId: string,
  sourceId: string,
  search: URLSearchParams,
): Promise<SourceUpdateHistoryPage | null> {
  const { limit, cursor } = parseSourceHistoryPage(search);
  const row = await prisma.subscription.findFirst({ where: { id: subscriptionId, ownerId } });
  if (!row) return null;
  const secrets = readSubscriptionSecrets(row);
  if (
    !normalizeSavedSourcesForPersistence(secrets.config.sources, { fallbackUrls: secrets.urls }).some(
      (source) => source.id === sourceId,
    )
  )
    return null;
  const records = await prisma.subscriptionSourceUpdateLog.findMany({
    where: {
      subscriptionId,
      sourceId,
      ...(cursor
        ? {
            OR: [
              { completedAt: { lt: cursor.completedAt } },
              { completedAt: cursor.completedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      sourceLabel: true,
      trigger: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
      result: true,
      nodeCountBefore: true,
      nodeCountAfter: true,
      nodesChanged: true,
      warningCount: true,
      errorMessage: true,
    },
  });
  const page = records.slice(0, limit);
  const last = page[page.length - 1];
  return {
    records: page.map((record) => ({
      ...record,
      startedAt: record.startedAt.toISOString(),
      completedAt: record.completedAt.toISOString(),
    })),
    nextCursor:
      records.length > limit && last
        ? Buffer.from(JSON.stringify({ completedAt: last.completedAt.toISOString(), id: last.id })).toString(
            "base64url",
          )
        : null,
  };
}
