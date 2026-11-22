import { beforeEach, describe, expect, it, vi } from "vitest";
import { runLocalSubscriptionAutoUpdateCron } from "./auto-update-service";
import { JobLeaseLostError } from "./job-lease";

const mocks = vi.hoisted(() => ({
  applyCronUpdateOutcome: vi.fn(),
  buildSubscriptionCacheExpiry: vi.fn(),
  buildSubscriptionFetchCallbacks: vi.fn(),
  createCronUpdateAccumulator: vi.fn(),
  encryptJson: vi.fn(),
  extractHostsFromSubscriptionUrls: vi.fn(),
  finalizeCronUpdateSummary: vi.fn(),
  prepareRefreshCacheResult: vi.fn(),
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    subscription: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    subscriptionAutoUpdateState: {
      upsert: vi.fn(),
    },
  },
  readSubscriptionSecrets: vi.fn(),
  recordCronUpdateSkipped: vi.fn(),
  refreshNodeSnapshot: vi.fn(),
  resolveAutomaticRefreshCompletionDecision: vi.fn(),
  resolveAutomaticRefreshFailureAnalysis: vi.fn(),
  resolveAutomaticRefreshUnexpectedFailureCompletion: vi.fn(),
  resolveAutoUpdateScheduleState: vi.fn(),
  resolveSubscriptionAutoUpdateState: vi.fn(),
}));

vi.mock("@subboost/server-core/subscription", async (importOriginal) => ({
  ...await importOriginal<typeof import("@subboost/server-core/subscription")>(),
  applyCronUpdateOutcome: mocks.applyCronUpdateOutcome,
  createCronUpdateAccumulator: mocks.createCronUpdateAccumulator,
  extractHostsFromSubscriptionUrls: mocks.extractHostsFromSubscriptionUrls,
  finalizeCronUpdateSummary: mocks.finalizeCronUpdateSummary,
  prepareRefreshCacheResult: mocks.prepareRefreshCacheResult,
  recordCronUpdateSkipped: mocks.recordCronUpdateSkipped,
  refreshNodeSnapshot: mocks.refreshNodeSnapshot,
  resolveAutomaticRefreshCompletionDecision: mocks.resolveAutomaticRefreshCompletionDecision,
  resolveAutomaticRefreshFailureAnalysis: mocks.resolveAutomaticRefreshFailureAnalysis,
  resolveAutomaticRefreshUnexpectedFailureCompletion: mocks.resolveAutomaticRefreshUnexpectedFailureCompletion,
  resolveAutoUpdateScheduleState: mocks.resolveAutoUpdateScheduleState,
  resolveSubscriptionAutoUpdateState: mocks.resolveSubscriptionAutoUpdateState,
}));
vi.mock("./crypto", () => ({ encryptJson: mocks.encryptJson }));
vi.mock("./prisma", () => ({ prisma: mocks.prisma }));
vi.mock("./subscription-service", () => ({
  buildSubscriptionCacheExpiry: mocks.buildSubscriptionCacheExpiry,
  buildSubscriptionFetchCallbacks: mocks.buildSubscriptionFetchCallbacks,
  MAX_NODES_PER_SUBSCRIPTION: 500,
  readSubscriptionSecrets: mocks.readSubscriptionSecrets,
}));

const now = new Date("2026-06-06T00:00:00.000Z");
const subscription = {
  id: "sub-1",
  name: "Sub",
  ownerId: "admin-1",
  owner: { username: "ry" },
  autoUpdateInterval: 60,
  createdAt: new Date("2026-06-05T00:00:00.000Z"),
  lastUpdatedAt: null,
  autoUpdateState: null,
  updatedAt: new Date("2026-06-05T00:00:00.000Z"),
};

function accumulator(total: number) {
  return { total, skipped: 0, outcomes: [] as unknown[] };
}

describe("local subscription auto update service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mocks.createCronUpdateAccumulator.mockImplementation(accumulator);
    mocks.recordCronUpdateSkipped.mockImplementation((acc) => {
      acc.skipped += 1;
    });
    mocks.applyCronUpdateOutcome.mockImplementation((acc, outcome) => {
      acc.outcomes.push(outcome);
    });
    mocks.finalizeCronUpdateSummary.mockImplementation((acc, options) => ({ ...acc, options }));
    mocks.prisma.subscription.findMany.mockResolvedValue([subscription]);
    mocks.prisma.subscription.findUnique.mockResolvedValue(subscription);
    mocks.prisma.$queryRaw.mockResolvedValue([{ id: subscription.id, name: "subscription-refresh:sub-1", ownerToken: "test", expiresAt: new Date(Date.now() + 300000) }]);
    mocks.prisma.$executeRaw.mockResolvedValue(1);
    mocks.prisma.subscription.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.subscriptionAutoUpdateState.upsert.mockResolvedValue({ upsert: true });
    mocks.prisma.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.prisma.$queryRaw,
      subscription: { updateMany: mocks.prisma.subscription.updateMany },
      subscriptionAutoUpdateState: { upsert: mocks.prisma.subscriptionAutoUpdateState.upsert },
    }));
    mocks.resolveSubscriptionAutoUpdateState.mockReturnValue({ lastAttemptedAt: null, externalFailureCount: 0 });
    mocks.resolveAutoUpdateScheduleState.mockReturnValue({ due: true });
    mocks.readSubscriptionSecrets.mockReturnValue({ config: { rules: [] }, urls: ["https://airport.example/sub"], nodes: [] });
    mocks.extractHostsFromSubscriptionUrls.mockReturnValue(["airport.example"]);
    mocks.buildSubscriptionFetchCallbacks.mockReturnValue({ fetchSubscription: vi.fn() });
    mocks.refreshNodeSnapshot.mockResolvedValue({ savedSources: [{ url: "https://airport.example/sub" }] });
    mocks.resolveAutomaticRefreshFailureAnalysis.mockReturnValue({
      failureState: { externalFailureCount: 1 },
      failureReason: "all sources failed",
    });
    mocks.prepareRefreshCacheResult.mockReturnValue({
      ok: true,
      refreshedConfig: { rules: [], sources: [{ url: "https://airport.example/sub" }] },
      cacheEntry: { nodes: [{ name: "A" }], subscriptionInfo: { upload: 1 } },
      nodeCount: 1,
    });
    mocks.resolveAutomaticRefreshCompletionDecision.mockReturnValue({
      kind: "success",
      refreshResult: { ok: true, refreshedConfig: { rules: [], sources: [{ url: "https://airport.example/sub" }] }, cacheEntry: { nodes: [{ name: "A" }], subscriptionInfo: { upload: 1 } }, nodeCount: 1 },
      nextAutoUpdateState: {
        state: { lastAttemptedAt: now, externalFailureCount: 0 },
        shouldDisableAutoUpdate: false,
      },
      outcome: { kind: "updated", subscriptionId: "sub-1" },
    });
    mocks.resolveAutomaticRefreshUnexpectedFailureCompletion.mockReturnValue({
      attemptedState: { lastAttemptedAt: now, externalFailureCount: 1 },
      message: "unexpected",
      outcome: { kind: "failed", subscriptionId: "sub-1" },
    });
    mocks.encryptJson.mockImplementation((value) => ({ encrypted: value }));
    mocks.buildSubscriptionCacheExpiry.mockReturnValue(new Date("2026-06-07T00:00:00.000Z"));
  });

  it("uses the local six-minute minimum interval when saved values are lower", async () => {
    await runLocalSubscriptionAutoUpdateCron(now);

    expect(mocks.resolveAutoUpdateScheduleState).toHaveBeenCalledWith(
      expect.objectContaining({ intervalSeconds: 360 })
    );
  });

  it("skips subscriptions that are not due", async () => {
    mocks.resolveAutoUpdateScheduleState.mockReturnValueOnce({ due: false });

    await expect(runLocalSubscriptionAutoUpdateCron(now)).resolves.toEqual(
      expect.objectContaining({ total: 1, skipped: 1 })
    );

    expect(mocks.refreshNodeSnapshot).not.toHaveBeenCalled();
    expect(mocks.applyCronUpdateOutcome).not.toHaveBeenCalled();
  });

  it("refreshes due subscriptions and writes encrypted cache state", async () => {
    const result = await runLocalSubscriptionAutoUpdateCron(now);

    expect(result).toEqual(expect.objectContaining({ total: 1, outcomes: [{ kind: "updated", subscriptionId: "sub-1" }] }));
    expect(mocks.refreshNodeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { rules: [] },
        urls: ["https://airport.example/sub"],
        storedNodes: [],
      })
    );
    expect(mocks.prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-1", updatedAt: subscription.updatedAt },
        data: expect.objectContaining({
          encryptedNodes: { encrypted: [{ name: "A" }] },
          encryptedConfig: { encrypted: { rules: [], sources: [{ url: "https://airport.example/sub" }] } },
          encryptedSubscriptionInfo: { encrypted: { upload: 1 } },
        }),
      })
    );
    expect(mocks.prisma.subscriptionAutoUpdateState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subscriptionId: "sub-1" } })
    );
  });

  it("records all-source failures without clearing the automatic update interval", async () => {
    mocks.prepareRefreshCacheResult.mockReturnValueOnce({ ok: false, reason: "no_nodes" });
    mocks.resolveAutomaticRefreshCompletionDecision.mockReturnValueOnce({
      kind: "all_sources_failed",
      nextAutoUpdateState: {
        state: { lastAttemptedAt: now, externalFailureCount: 3 },
        shouldDisableAutoUpdate: true,
      },
      outcome: { kind: "failed", subscriptionId: "sub-1" },
    });

    await expect(runLocalSubscriptionAutoUpdateCron(now)).resolves.toEqual(
      expect.objectContaining({ outcomes: [{ kind: "failed", subscriptionId: "sub-1" }] })
    );

    expect(mocks.prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ autoUpdateInterval: null }) })
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("records attempted state for partial refresh failures", async () => {
    mocks.prepareRefreshCacheResult.mockReturnValueOnce({ ok: false, reason: "partial" });
    mocks.resolveAutomaticRefreshCompletionDecision.mockReturnValueOnce({
      kind: "retry",
      attemptedState: { lastAttemptedAt: now, externalFailureCount: 1 },
      outcome: { kind: "failed", subscriptionId: "sub-1" },
    });

    await runLocalSubscriptionAutoUpdateCron(now);

    expect(mocks.prisma.subscriptionAutoUpdateState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ externalFailureCount: 1 }),
        update: expect.objectContaining({ externalFailureCount: 1 }),
      })
    );
    expect(mocks.applyCronUpdateOutcome).toHaveBeenCalledWith(expect.anything(), {
      kind: "failed",
      subscriptionId: "sub-1",
    });
  });

  it("persists quota failure facts and disables on the third failure without writing cache data", async () => {
    const quotaState = {
      externalFailureCount: 2,
      failureSourceState: "external-state",
      lastFailedAt: null,
      lastAttemptedAt: now,
      nodeQuotaFailureCount: 3,
      lastNodeQuotaExceededAt: now,
      lastNodeQuotaActual: 501,
      lastNodeQuotaLimit: 500,
      disabledAt: now,
      disabledReason: "节点数连续超过配额",
      disabledPreviousInterval: 60,
    };
    mocks.prepareRefreshCacheResult.mockReturnValueOnce({
      ok: false,
      reason: "node_quota_exceeded",
      nodeCount: 501,
      maxNodesPerSubscription: 500,
    });
    mocks.resolveAutomaticRefreshCompletionDecision.mockReturnValueOnce({
      kind: "node_quota_exceeded",
      nextAutoUpdateState: {
        state: quotaState,
        externalFailureCount: 2,
        shouldDisableAutoUpdate: true,
      },
      outcome: { kind: "failed", subscriptionId: "sub-1" },
    });

    await runLocalSubscriptionAutoUpdateCron(now);

    expect(mocks.prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ autoUpdateInterval: null }),
      })
    );
    expect(mocks.prisma.subscriptionAutoUpdateState.upsert).toHaveBeenCalledWith({
      where: { subscriptionId: "sub-1" },
      create: { subscriptionId: "sub-1", ...quotaState },
      update: quotaState,
    });
    expect(mocks.encryptJson).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[local-subscription-cron] node quota exceeded",
      expect.objectContaining({
        subscriptionId: "sub-1",
        actualNodeCount: 501,
        effectiveNodeLimit: 500,
        nodeQuotaFailureCount: 3,
        autoUpdateDisabled: true,
      })
    );
  });

  it("keeps automatic updates enabled before the quota failure threshold", async () => {
    const quotaState = {
      externalFailureCount: 2,
      nodeQuotaFailureCount: 2,
      lastNodeQuotaActual: 501,
      lastNodeQuotaLimit: 500,
    };
    mocks.prepareRefreshCacheResult.mockReturnValueOnce({
      ok: false,
      reason: "node_quota_exceeded",
      nodeCount: 501,
      maxNodesPerSubscription: 500,
    });
    mocks.resolveAutomaticRefreshCompletionDecision.mockReturnValueOnce({
      kind: "node_quota_exceeded",
      nextAutoUpdateState: {
        state: quotaState,
        externalFailureCount: 2,
        shouldDisableAutoUpdate: false,
      },
      outcome: { kind: "failed", subscriptionId: "sub-1" },
    });

    await runLocalSubscriptionAutoUpdateCron(now);

    expect(mocks.prisma.subscription.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty(
      "autoUpdateInterval"
    );
    expect(mocks.prisma.subscriptionAutoUpdateState.upsert).toHaveBeenCalledWith({
      where: { subscriptionId: "sub-1" },
      create: { subscriptionId: "sub-1", ...quotaState },
      update: quotaState,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[local-subscription-cron] node quota exceeded",
      expect.objectContaining({ nodeQuotaFailureCount: 2, autoUpdateDisabled: false })
    );
  });

  it("captures unexpected failures and keeps the cron summary going", async () => {
    mocks.readSubscriptionSecrets.mockImplementationOnce(() => {
      throw new Error("decrypt failed");
    });
    mocks.prisma.$transaction.mockRejectedValueOnce(new Error("state write failed"));

    await expect(runLocalSubscriptionAutoUpdateCron(now)).resolves.toEqual(
      expect.objectContaining({ outcomes: [{ kind: "failed", subscriptionId: "sub-1" }] })
    );

    expect(mocks.resolveAutomaticRefreshUnexpectedFailureCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedHosts: [],
        error: expect.any(Error),
        attemptStartedAt: expect.any(Date),
      })
    );
    expect(console.error).toHaveBeenCalledWith(
      "[local-subscription-cron] failed",
      expect.objectContaining({ subscriptionId: "sub-1", message: "unexpected" })
    );
  });

  it("treats a CAS miss as a stale skip without publishing success", async () => {
    mocks.prisma.subscription.updateMany.mockResolvedValueOnce({ count: 0 });

    await runLocalSubscriptionAutoUpdateCron(now);

    expect(mocks.prisma.subscriptionAutoUpdateState.upsert).not.toHaveBeenCalled();
    expect(mocks.applyCronUpdateOutcome).toHaveBeenCalledWith(expect.anything(), {
      status: "skipped",
      requestedHosts: ["airport.example"],
      recordHosts: false,
    });
    expect(console.info).not.toHaveBeenCalledWith("[local-subscription-cron] updated", expect.anything());
    expect(console.info).toHaveBeenCalledWith("[local-subscription-cron] finished", expect.objectContaining({ status: "skipped" }));
  });

  function concurrentFixtures(count = 3) {
    const rows = Array.from({ length: count }, (_, i) => ({ ...subscription, id: `sub-${i + 1}` }));
    mocks.prisma.subscription.findMany.mockResolvedValue(rows);
    mocks.prisma.subscription.findUnique.mockImplementation(async ({ where }) => rows.find((row) => row.id === where.id));
    mocks.prisma.$queryRaw.mockImplementation(async (_sql, name, token) => [{ name, ownerToken: token, expiresAt: new Date(Date.now() + 300000) }]);
    mocks.readSubscriptionSecrets.mockImplementation((row) => ({ config: { id: row.id }, urls: [], nodes: [] }));
    mocks.resolveAutomaticRefreshCompletionDecision.mockImplementation(({ target }) => ({
      kind: "success",
      refreshResult: { refreshedConfig: {}, cacheEntry: { nodes: [], subscriptionInfo: {} }, nodeCount: 0 },
      nextAutoUpdateState: { state: { externalFailureCount: 0 }, shouldDisableAutoUpdate: false },
      outcome: { status: "updated", requestedHosts: [], recordHosts: true, updatedSubscription: { subscriptionId: target.id } },
    }));
    return rows;
  }

  it("commits B and starts C while A is pending, with at most two active aggregates", async () => {
    concurrentFixtures(4);
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    mocks.refreshNodeSnapshot.mockImplementation(async ({ config }) => {
      started.push(config.id);
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => releases.set(config.id, resolve));
      active--;
      return {};
    });
    const pending = runLocalSubscriptionAutoUpdateCron(now);
    try {
      await vi.waitFor(() => expect(started).toEqual(["sub-1", "sub-2"]));
      releases.get("sub-2")!();
      await vi.waitFor(() => expect(started).toEqual(["sub-1", "sub-2", "sub-3"]));
      expect(mocks.prisma.subscription.updateMany.mock.calls.map(([call]) => call.where.id)).toEqual(["sub-2"]);
      releases.get("sub-3")!();
      await vi.waitFor(() => expect(started).toHaveLength(4));
      releases.get("sub-4")!();
      await vi.waitFor(() => expect(mocks.prisma.subscription.updateMany).toHaveBeenCalledTimes(3));
      expect(peak).toBe(2);
      releases.get("sub-1")!();
      await pending;
      expect(mocks.prisma.subscription.updateMany.mock.calls.map(([call]) => call.where.id)).toEqual(["sub-2", "sub-3", "sub-4", "sub-1"]);
    } finally {
      for (const release of releases.values()) release();
    }
  });

  it("isolates a subscription-local lease failure and completes its peers", async () => {
    concurrentFixtures();
    mocks.refreshNodeSnapshot.mockImplementation(async ({ config }) => {
      if (config.id === "sub-1") throw new JobLeaseLostError("subscription-refresh:sub-1");
      return {};
    });
    await runLocalSubscriptionAutoUpdateCron(now);
    expect(mocks.prisma.subscription.updateMany.mock.calls.map(([call]) => call.where.id).sort()).toEqual(["sub-2", "sub-3"]);
    expect(mocks.applyCronUpdateOutcome).toHaveBeenCalledTimes(3);
    expect(mocks.applyCronUpdateOutcome.mock.calls.some(([, outcome]) => outcome.status === "failed")).toBe(true);
  });

  it("isolates lock acquisition failures instead of rejecting the entire batch", async () => {
    concurrentFixtures();
    mocks.prisma.$queryRaw.mockRejectedValueOnce(new Error("synthetic acquisition failure"));
    await expect(runLocalSubscriptionAutoUpdateCron(now)).resolves.toBeDefined();
    expect(mocks.prisma.subscription.updateMany).toHaveBeenCalledTimes(2);
  });

  it("cancels both active aggregates after global lease loss and waits for their cleanup", async () => {
    concurrentFixtures(4);
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    mocks.refreshNodeSnapshot.mockImplementation(async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => cleanups.push(() => reject(signal.reason)), { once: true });
    }));
    let finished = false;
    const pending = runLocalSubscriptionAutoUpdateCron(now, { signal: controller.signal });
    const rejected = expect(pending.finally(() => { finished = true; })).rejects.toThrow("Local job lease lost");
    try {
      await vi.waitFor(() => expect(mocks.refreshNodeSnapshot).toHaveBeenCalledTimes(2));
      controller.abort(new JobLeaseLostError("local-subscription-auto-update"));
      await vi.waitFor(() => expect(cleanups).toHaveLength(2));
      expect(finished).toBe(false);
      cleanups[0]();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);
      cleanups[1]();
      await rejected;
      expect(mocks.refreshNodeSnapshot).toHaveBeenCalledTimes(2);
      expect(mocks.prisma.subscription.updateMany).not.toHaveBeenCalled();
      expect(mocks.prisma.$executeRaw.mock.calls.filter(([sql]) => String(sql).includes("DELETE"))).toHaveLength(2);
    } finally { cleanups.forEach((cleanup) => cleanup()); }
  });
});
