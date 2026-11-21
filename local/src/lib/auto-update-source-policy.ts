import {
  AUTO_UPDATE_DISABLED_REASON,
  buildAutomaticRefreshAutoUpdateState,
  buildAutomaticRefreshNodeQuotaExceededState,
  markAutomaticRefreshAttempted,
  parseAutoUpdateFailureSourceState,
  serializeAutoUpdateFailureSourceState,
  updateAutoUpdateFailureSourceState,
  type AutomaticRefreshCompletionStateHelpers,
  type RefreshNodeSnapshotResult,
  type SubscriptionAutoUpdateStateFields,
} from "@subboost/server-core/subscription";

export const localAutomaticRefreshStateHelpers: AutomaticRefreshCompletionStateHelpers = {
  buildAutomaticRefreshAutoUpdateState: (params) => {
    const result = buildAutomaticRefreshAutoUpdateState(params);
    return {
      ...result,
      shouldDisableAutoUpdate: false,
      state: { ...result.state, disabledAt: null, disabledReason: null, disabledPreviousInterval: null },
    };
  },
  buildAutomaticRefreshNodeQuotaExceededState,
  markAutomaticRefreshAttempted,
};

/** Only attempted sources affect their failure streak; a manual source update is not a full attempt. */
export function buildLocalManualRefreshState(params: {
  currentState: SubscriptionAutoUpdateStateFields;
  snapshot: RefreshNodeSnapshotResult;
  attemptedAt: Date;
  scheduleMark: Date;
  targetSourceId?: string;
  applied: boolean;
}): SubscriptionAutoUpdateStateFields {
  const { currentState, snapshot, targetSourceId } = params;
  const sources = snapshot.savedSources.filter(
    (source) =>
      !(source.type === "url" && source.useProxyProviders) &&
      (!targetSourceId || source.id === targetSourceId),
  );
  const updated = updateAutoUpdateFailureSourceState({
    previousStateRaw: currentState.failureSourceState,
    sources,
    failedSources: snapshot.failedSources,
    failedAt: params.attemptedAt,
  });
  const failures = targetSourceId ? parseAutoUpdateFailureSourceState(currentState.failureSourceState) : {};
  for (const source of sources) delete failures[source.id];
  Object.assign(failures, updated.sourceState);
  const externalFailureCount = Math.max(0, ...Object.values(failures).map((failure) => failure.count));
  return {
    ...currentState,
    failureSourceState: serializeAutoUpdateFailureSourceState(failures),
    externalFailureCount,
    lastFailedAt: externalFailureCount
      ? new Date(Math.max(...Object.values(failures).map((failure) => Date.parse(failure.lastFailedAt))))
      : null,
    lastAttemptedAt: targetSourceId ? params.scheduleMark : params.attemptedAt,
    ...(params.applied && !targetSourceId
      ? {
          nodeQuotaFailureCount: 0,
          lastNodeQuotaExceededAt: null,
          lastNodeQuotaActual: null,
          lastNodeQuotaLimit: null,
          disabledAt: null,
          disabledReason: null,
          disabledPreviousInterval: null,
        }
      : {}),
    ...(currentState.disabledReason === AUTO_UPDATE_DISABLED_REASON
      ? {
          disabledAt: null,
          disabledReason: null,
          disabledPreviousInterval: null,
        }
      : {}),
  };
}
