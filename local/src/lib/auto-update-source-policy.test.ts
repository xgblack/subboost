import { describe, expect, it } from "vitest";
import {
  createResetSubscriptionAutoUpdateState,
  updateAutoUpdateFailureSourceState,
  parseAutoUpdateFailureSourceState,
  type RefreshNodeSnapshotResult,
} from "@subboost/server-core/subscription";
import { buildLocalManualRefreshState, localAutomaticRefreshStateHelpers } from "./auto-update-source-policy";

const sources = ["a", "b"].map((id) => ({ id, type: "url" as const, content: `https://${id}.example/sub` }));
const attemptedAt = new Date("2026-11-21T10:00:00Z");
const failures = sources.map((source) => ({ ...source, errorMessage: "HTTP 404", httpStatus: 404 }));

describe("local source update policy", () => {
  it("continues at the configured interval after repeated external failures, without stale disable metadata", () => {
    let current = createResetSubscriptionAutoUpdateState();
    for (let index = 0; index < 5; index++) {
      const failureState = updateAutoUpdateFailureSourceState({
        previousStateRaw: current.failureSourceState,
        sources,
        failedSources: failures,
        failedAt: attemptedAt,
      });
      const next = localAutomaticRefreshStateHelpers.buildAutomaticRefreshAutoUpdateState({
        failureState,
        attemptedAt,
        previousAutoUpdateInterval: 360,
        currentState: current,
      });
      expect(next.shouldDisableAutoUpdate).toBe(false);
      expect(next.state).toMatchObject({
        externalFailureCount: index + 1,
        disabledAt: null,
        disabledReason: null,
        disabledPreviousInterval: null,
      });
      current = next.state;
    }
  });

  it("preserves the separate node quota protection", () => {
    let current = createResetSubscriptionAutoUpdateState();
    for (let index = 0; index < 3; index++) {
      const next = localAutomaticRefreshStateHelpers.buildAutomaticRefreshNodeQuotaExceededState({
        currentState: current,
        attemptedAt,
        actualNodeCount: 10001,
        effectiveNodeLimit: 10000,
        previousAutoUpdateInterval: 360,
      });
      expect(next.shouldDisableAutoUpdate).toBe(index === 2);
      current = next.state;
    }
    expect(current.disabledReason).toBe("节点数连续超过配额");
  });

  it("a successful source update preserves another source's failure and the full refresh schedule", () => {
    const previous = updateAutoUpdateFailureSourceState({
      previousStateRaw: null,
      sources,
      failedSources: failures,
      failedAt: attemptedAt,
    });
    const scheduleMark = new Date("2026-11-21T09:00:00Z");
    const currentState = {
      ...createResetSubscriptionAutoUpdateState(),
      failureSourceState: previous.serializedSourceState,
      externalFailureCount: 1,
      lastAttemptedAt: scheduleMark,
    };
    const snapshot = { savedSources: sources, failedSources: [] } as unknown as RefreshNodeSnapshotResult;
    const result = buildLocalManualRefreshState({
      currentState,
      snapshot,
      attemptedAt,
      scheduleMark,
      targetSourceId: "a",
      applied: true,
    });
    expect(parseAutoUpdateFailureSourceState(result.failureSourceState)).toEqual({
      b: previous.sourceState.b,
    });
    expect(result.lastAttemptedAt).toEqual(scheduleMark);
    expect(result.externalFailureCount).toBe(1);
  });
});
