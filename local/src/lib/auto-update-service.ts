import {
  applyCronUpdateOutcome,
  createCronUpdateAccumulator,
  extractHostsFromSubscriptionUrls,
  finalizeCronUpdateSummary,
  prepareRefreshCacheResult,
  refreshNodeSnapshot,
  recordCronUpdateSkipped,
  resolveAutomaticRefreshCompletionDecision,
  resolveAutoUpdateScheduleState,
  resolveAutomaticRefreshUnexpectedFailureCompletion,
  resolveAutomaticRefreshFailureAnalysis,
  resolveSubscriptionAutoUpdateState,
  markAutomaticRefreshAttempted,
  type CronUpdateOutcome,
  type FinalCronUpdateSummary,
  type RefreshNodeSnapshotResult,
} from "@subboost/server-core/subscription";
import { encryptJson } from "./crypto";
import { prisma } from "./prisma";
import {
  buildSubscriptionCacheExpiry,
  buildSubscriptionFetchCallbacks,
  MAX_NODES_PER_SUBSCRIPTION,
  readSubscriptionSecrets,
  type SubscriptionRow,
} from "./subscription-service";
import { LOCAL_AUTO_UPDATE_MIN_SECONDS } from "./auto-update-policy";
import { JobLeaseLostError, type LocalJobLease } from "./job-lease";
import { localAutomaticRefreshStateHelpers } from "./auto-update-source-policy";
import { withSubscriptionRefreshLease, type SubscriptionRefreshLease } from "./subscription-refresh-lock";
import { persistSubscriptionRefresh } from "./subscription-source-update-store";

type AutoUpdateSubscriptionRow = SubscriptionRow & { owner: { username: string | null } };
const MAX_CONCURRENT_SUBSCRIPTIONS = 2;
const staleOutcome = (requestedHosts: string[]): CronUpdateOutcome => ({
  status: "skipped",
  requestedHosts,
  recordHosts: false,
});

export function resolveLocalAutoUpdateSchedule(subscription: SubscriptionRow, now: Date) {
  // Once initialized, only full refresh attempts advance the schedule. A source update must not defer its peers.
  const mark =
    subscription.autoUpdateState?.lastAttemptedAt ?? subscription.lastUpdatedAt ?? subscription.createdAt;
  return resolveAutoUpdateScheduleState({
    createdAt: subscription.createdAt,
    lastAttemptedAt: mark,
    now,
    intervalSeconds: Math.max(Number(subscription.autoUpdateInterval) || 0, LOCAL_AUTO_UPDATE_MIN_SECONDS),
  });
}

async function refreshAutomaticSubscription(
  subscription: AutoUpdateSubscriptionRow,
  lease: SubscriptionRefreshLease,
  assertCronLease?: () => Promise<void>,
): Promise<CronUpdateOutcome> {
  const currentState = resolveSubscriptionAutoUpdateState(subscription);
  const target = {
    id: subscription.id,
    name: subscription.name,
    userId: subscription.ownerId,
    username: subscription.owner.username,
    autoUpdateInterval: subscription.autoUpdateInterval,
  };
  const attemptedAt = new Date();
  let requestedHosts: string[] = [];
  let snapshot: RefreshNodeSnapshotResult | undefined;
  let persisted = false;
  try {
    const secrets = readSubscriptionSecrets(subscription);
    requestedHosts = extractHostsFromSubscriptionUrls(secrets.urls);
    snapshot = await refreshNodeSnapshot({
      config: secrets.config,
      urls: secrets.urls,
      storedNodes: secrets.nodes,
      signal: lease.signal,
      ...buildSubscriptionFetchCallbacks(lease.signal),
    });
    const { failureState, failureReason } = resolveAutomaticRefreshFailureAnalysis({
      currentState,
      snapshot,
      failedAt: attemptedAt,
    });
    const refreshResult = prepareRefreshCacheResult({
      config: secrets.config,
      snapshot,
      maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION,
    });
    const cachedAt = new Date();
    const decision = resolveAutomaticRefreshCompletionDecision({
      target,
      currentAutoUpdateState: currentState,
      prepared: { requestedHosts, refreshResult, failureState, failureReason },
      attemptedAt,
      successAttemptedAt: cachedAt,
      maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION,
      stateHelpers: localAutomaticRefreshStateHelpers,
    });
    await assertCronLease?.();
    const applied = decision.kind === "success";
    const nextState =
      decision.kind === "empty_result" ? decision.attemptedState : decision.nextAutoUpdateState.state;
    const disableForQuota =
      decision.kind === "node_quota_exceeded" && decision.nextAutoUpdateState.shouldDisableAutoUpdate;
    persisted = await persistSubscriptionRefresh({
      subscriptionId: subscription.id,
      expectedUpdatedAt: subscription.updatedAt,
      state: nextState,
      lease,
      data: {
        ...(applied
          ? {
              encryptedNodes: encryptJson(decision.refreshResult.cacheEntry.nodes),
              encryptedConfig: encryptJson(decision.refreshResult.refreshedConfig),
              encryptedSubscriptionInfo: encryptJson(decision.refreshResult.cacheEntry.subscriptionInfo),
              lastUpdatedAt: cachedAt,
              cacheExpiresAt: buildSubscriptionCacheExpiry(cachedAt),
            }
          : {}),
        ...(disableForQuota ? { autoUpdateInterval: null } : {}),
      },
      sourceUpdates: {
        snapshot,
        trigger: "automatic",
        applied,
        unappliedReason:
          decision.kind === "node_quota_exceeded"
            ? "节点数量超过配额，本次结果未应用"
            : "聚合结果没有可用节点，本次结果未应用",
      },
    });
    if (!persisted) return staleOutcome(requestedHosts);
    if (decision.kind === "node_quota_exceeded") {
      console.warn("[local-subscription-cron] node quota exceeded", {
        subscriptionId: subscription.id,
        actualNodeCount: nextState.lastNodeQuotaActual,
        effectiveNodeLimit: nextState.lastNodeQuotaLimit,
        nodeQuotaFailureCount: nextState.nodeQuotaFailureCount,
        autoUpdateDisabled: disableForQuota,
      });
    } else if (applied) {
      console.info("[local-subscription-cron] updated", {
        subscriptionId: subscription.id,
        nodeCount: decision.refreshResult.nodeCount,
        intervalSeconds: Math.max(
          Number(subscription.autoUpdateInterval) || 0,
          LOCAL_AUTO_UPDATE_MIN_SECONDS,
        ),
        externalFailureCount: nextState.externalFailureCount,
        autoUpdateDisabled: false,
      });
    }
    return decision.outcome;
  } catch (error) {
    lease.signal?.throwIfAborted();
    if (error instanceof JobLeaseLostError) throw error;
    const completion = resolveAutomaticRefreshUnexpectedFailureCompletion({
      target,
      requestedHosts,
      error: new Error("聚合配置生成或保存失败"),
      attemptStartedAt: attemptedAt,
      currentAutoUpdateState: currentState,
      stateHelpers: {
        buildAutomaticRefreshUnexpectedFailureState: (at) => markAutomaticRefreshAttempted(currentState, at),
      },
    });
    if (!persisted && completion.attemptedState) {
      try {
        await assertCronLease?.();
        const written = await persistSubscriptionRefresh({
          subscriptionId: subscription.id,
          expectedUpdatedAt: subscription.updatedAt,
          state: completion.attemptedState,
          lease,
          sourceUpdates: snapshot
            ? { snapshot, trigger: "automatic", applied: false, unappliedReason: completion.message }
            : undefined,
        });
        if (!written) return staleOutcome(requestedHosts);
      } catch (writeError) {
        lease.signal?.throwIfAborted();
        if (writeError instanceof JobLeaseLostError) throw writeError;
        console.error("[local-subscription-cron] unable to persist failed attempt", {
          subscriptionId: subscription.id,
        });
      }
    }
    console.error("[local-subscription-cron] failed", {
      subscriptionId: subscription.id,
      message: completion.message,
    });
    return completion.outcome;
  }
}

export async function runLocalSubscriptionAutoUpdateCron(
  now = new Date(),
  options: { assertLease?: () => Promise<void>; signal?: AbortSignal; lease?: LocalJobLease } = {},
): Promise<FinalCronUpdateSummary> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const assertCronLease = async () => {
    signal.throwIfAborted();
    try { await options.assertLease?.(); }
    catch (error) {
      controller.abort(error);
      throw error;
    }
    signal.throwIfAborted();
  };
  await assertCronLease();
  const subscriptions = await prisma.subscription.findMany({
    where: { autoUpdateInterval: { not: null } },
    include: { owner: { select: { username: true } }, autoUpdateState: true },
  });
  const accumulator = createCronUpdateAccumulator(subscriptions.length);
  let nextIndex = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const subscription = subscriptions[nextIndex++];
      if (!subscription) return;
      await assertCronLease();
      if (!resolveLocalAutoUpdateSchedule(subscription, now).due) {
        recordCronUpdateSkipped(accumulator);
        continue;
      }
      const startedAt = Date.now();
      let outcome: CronUpdateOutcome | undefined;
      console.info("[local-subscription-cron] started", { subscriptionId: subscription.id });
      try {
        const result = await withSubscriptionRefreshLease(subscription.id, async (lease) => {
          const current = await prisma.subscription.findUnique({
            where: { id: subscription.id },
            include: { owner: { select: { username: true } }, autoUpdateState: true },
          });
          lease.signal?.throwIfAborted();
          if (!current || current.autoUpdateInterval === null || !resolveLocalAutoUpdateSchedule(current, now).due)
            return staleOutcome([]);
          return refreshAutomaticSubscription(current, lease, assertCronLease);
        }, { signal, cronLease: options.lease });
        outcome = result.busy ? staleOutcome([]) : result.value;
      } catch (error) {
        // A global failure cancels every worker. A subscription-local failure does not.
        signal.throwIfAborted();
        if (error instanceof JobLeaseLostError && options.lease && error.leaseName === options.lease.name) {
          controller.abort(error);
          throw error;
        }
        console.error("[local-subscription-cron] subscription task failed", {
          subscriptionId: subscription.id, leaseLost: error instanceof JobLeaseLostError,
        });
        outcome = {
          status: "failed", requestedHosts: [], recordHosts: false,
          resultsError: `Subscription ${subscription.id}: 更新失败，已保留原快照`,
        };
      } finally {
        console.info("[local-subscription-cron] finished", {
          subscriptionId: subscription.id, durationMs: Date.now() - startedAt,
          status: outcome?.status ?? "cancelled",
        });
      }
      applyCronUpdateOutcome(accumulator, outcome);
    }
  };
  // Await cleanup of every active worker even if global ownership was lost.
  await Promise.allSettled(Array.from({ length: Math.min(MAX_CONCURRENT_SUBSCRIPTIONS, subscriptions.length) },
    () => worker().catch((error) => { controller.abort(error); throw error; })));
  await assertCronLease();
  return finalizeCronUpdateSummary(accumulator, { maxTopHosts: 50, maxTopUsers: 50 });
}
