import {
  classifyStableExternalAutoUpdateFailure,
  normalizeSavedSourcesForPersistence,
  type RefreshNodeSnapshotResult,
  type SavedSource,
  type SubscriptionAutoUpdateStateFields,
} from "@subboost/server-core/subscription";
import { maskUrlForPublicDisplay, sanitizePublicErrorText } from "@subboost/core/subscription/import-error";
import type { ParsedNode } from "@subboost/core/types/node";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import type { Prisma } from "../generated/prisma";
import { decryptJson, decryptJsonObject } from "./crypto";
import { prisma } from "./prisma";
import { assertSubscriptionRefreshLease, type SubscriptionRefreshLease } from "./subscription-refresh-lock";
import type { SourceUpdateResult, SourceUpdateTrigger } from "./subscription-source-types";

export const SOURCE_UPDATE_HISTORY_LIMIT = 200;

export function sourceDisplay(source: SavedSource) {
  let address = source.type === "yaml" ? "静态 YAML" : "节点文本";
  if (source.type === "url") {
    try {
      new URL(source.content);
      address = maskUrlForPublicDisplay(source.content);
    } catch {
      address = "订阅 URL";
    }
  }
  const label = Array.from(sanitizePublicErrorText(source.tag) || address)
    .slice(0, 240)
    .join("");
  return { label, address };
}

export function sameSavedSource(left: SavedSource, right: SavedSource): boolean {
  return (
    left.type === right.type &&
    left.content === right.content &&
    Boolean(left.useProxyProviders) === Boolean(right.useProxyProviders) &&
    left.userinfoUrl === right.userinfoUrl &&
    left.userinfoUserAgent === right.userinfoUserAgent
  );
}

export function countSourceNodes(nodes: ParsedNode[], sourceId: string): number {
  return nodes.filter((node) => getNodeSourceIds(node).includes(sourceId)).length;
}

type SourceUpdateWrite = {
  subscriptionId: string;
  snapshot: RefreshNodeSnapshotResult;
  trigger: SourceUpdateTrigger;
  applied: boolean;
  unappliedReason?: string;
  updateCurrentState?: boolean;
  allowedSources?: SavedSource[];
};

export async function recordSourceUpdateResults(tx: Prisma.TransactionClient, params: SourceUpdateWrite) {
  for (const attempt of params.snapshot.sourceResults ?? []) {
    const source = params.snapshot.savedSources.find((item) => item.id === attempt.sourceId);
    if (!source) continue;
    if (
      params.allowedSources &&
      !params.allowedSources.some((item) => item.id === source.id && sameSavedSource(item, source))
    )
      continue;
    const failed = attempt.outcome === "failed";
    const result: SourceUpdateResult = failed
      ? "failed"
      : !params.applied
        ? "not_applied"
        : attempt.nodesChanged
          ? "applied"
          : "unchanged";
    const failure = params.snapshot.failedSources.find((item) => item.id === source.id);
    // Never persist parser excerpts or upstream response text: errors may contain node credentials.
    const errorMessage = failed
      ? sanitizePublicErrorText(
          failure ? classifyStableExternalAutoUpdateFailure(failure).reason : "订阅源更新失败",
        )
          .replace("失败原因不满足稳定外部失败口径", "订阅源请求失败，请检查地址或稍后重试")
          .slice(0, 240)
      : !params.applied
        ? (params.unappliedReason ?? "本次结果未应用").slice(0, 240)
        : null;
    const nodeCountAfter = params.applied && !failed ? attempt.nodeCountAfter : attempt.nodeCountBefore;
    const warningCount = Math.max(0, attempt.warningCount);
    await tx.subscriptionSourceUpdateLog.create({
      data: {
        subscriptionId: params.subscriptionId,
        sourceId: source.id,
        sourceType: source.type,
        sourceLabel: sourceDisplay(source).label,
        trigger: params.trigger,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        durationMs: Math.min(
          2_147_483_647,
          Math.max(0, attempt.durationMs ?? attempt.completedAt.getTime() - attempt.startedAt.getTime()),
        ),
        result,
        nodeCountBefore: attempt.nodeCountBefore,
        nodeCountAfter,
        nodesChanged: params.applied && !failed && attempt.nodesChanged,
        warningCount,
        errorCategory: attempt.errorCategory ?? null,
        httpStatus: attempt.httpStatus ?? null,
        errorMessage,
      },
    });
    if (params.updateCurrentState !== false) {
      const state = {
        lastAttemptedAt: attempt.startedAt,
        lastResult: result,
        lastError: errorMessage,
        nodeCount: nodeCountAfter,
        warningCount,
        ...(params.applied && !failed ? { lastSuccessfulAt: attempt.completedAt } : {}),
      };
      await tx.subscriptionSourceUpdateState.upsert({
        where: { subscriptionId_sourceId: { subscriptionId: params.subscriptionId, sourceId: source.id } },
        create: { subscriptionId: params.subscriptionId, sourceId: source.id, ...state },
        update: state,
      });
    }
    const expired = await tx.subscriptionSourceUpdateLog.findMany({
      where: { subscriptionId: params.subscriptionId, sourceId: source.id },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      skip: SOURCE_UPDATE_HISTORY_LIMIT,
      select: { id: true },
    });
    if (expired.length)
      await tx.subscriptionSourceUpdateLog.deleteMany({
        where: { id: { in: expired.map((item) => item.id) } },
      });
  }
}

/** The snapshot, state and success history commit together; failed CAS attempts only add history. */
export async function persistSubscriptionRefresh(params: {
  subscriptionId: string;
  expectedUpdatedAt: Date;
  state: SubscriptionAutoUpdateStateFields;
  data?: Prisma.SubscriptionUpdateManyMutationInput;
  lease: SubscriptionRefreshLease;
  sourceUpdates?: Omit<SourceUpdateWrite, "subscriptionId">;
}): Promise<boolean> {
  await params.lease.assertOwned();
  return prisma.$transaction(async (tx) => {
    await assertSubscriptionRefreshLease(tx, params.lease);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Subscription" WHERE "id" = ${params.subscriptionId} FOR UPDATE
    `;
    if (!locked.length) return false;
    params.lease.signal?.throwIfAborted();
    const updated = await tx.subscription.updateMany({
      where: { id: params.subscriptionId, updatedAt: params.expectedUpdatedAt },
      data: { ...params.data, updatedAt: new Date() },
    });
    if (updated.count !== 1) {
      if (params.sourceUpdates?.snapshot.sourceResults?.length) {
        const current = await tx.subscription.findUnique({ where: { id: params.subscriptionId } });
        if (current)
          await recordSourceUpdateResults(tx, {
            ...params.sourceUpdates,
            subscriptionId: params.subscriptionId,
            applied: false,
            updateCurrentState: false,
            unappliedReason: "配置在更新期间已变更，本次结果未应用",
            allowedSources: normalizeSavedSourcesForPersistence(
              decryptJsonObject(current.encryptedConfig).sources,
              {
                fallbackUrls: decryptJson<string[]>(current.encryptedUrls, []),
              },
            ),
          });
      }
      params.lease.signal?.throwIfAborted();
      return false;
    }
    await tx.subscriptionAutoUpdateState.upsert({
      where: { subscriptionId: params.subscriptionId },
      create: { subscriptionId: params.subscriptionId, ...params.state },
      update: params.state,
    });
    if (params.sourceUpdates)
      await recordSourceUpdateResults(tx, { ...params.sourceUpdates, subscriptionId: params.subscriptionId });
    params.lease.signal?.throwIfAborted();
    return true;
  });
}

export async function syncSourceUpdateStates(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  before: SavedSource[],
  after: SavedSource[],
  nodes: ParsedNode[],
) {
  const removedIds = before
    .filter((source) => !after.some((item) => item.id === source.id))
    .map((source) => source.id);
  const replacedIds = before
    .filter((source) => after.some((item) => item.id === source.id && !sameSavedSource(source, item)))
    .map((source) => source.id);
  if (removedIds.length)
    await tx.subscriptionSourceUpdateLog.deleteMany({
      where: { subscriptionId, sourceId: { in: removedIds } },
    });
  if (removedIds.length || replacedIds.length)
    await tx.subscriptionSourceUpdateState.deleteMany({
      where: { subscriptionId, sourceId: { in: [...removedIds, ...replacedIds] } },
    });
  for (const source of after) {
    await tx.subscriptionSourceUpdateState.updateMany({
      where: { subscriptionId, sourceId: source.id },
      data: { nodeCount: countSourceNodes(nodes, source.id) },
    });
  }
}
