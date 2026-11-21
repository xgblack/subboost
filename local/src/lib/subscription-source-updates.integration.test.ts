import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshNodeSnapshot } from "@subboost/server-core/subscription";
import type { ParsedNode } from "@subboost/core/types/node";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./source-import", () => ({
  importSourceUrlDirect: transport.fetch,
  fetchSourceUserInfoHeadersDirect: vi.fn(async () => undefined),
}));

const databaseUrl = process.env.SUBBOOST_TEST_DATABASE_URL;
const sources = ["a", "b"].map((id) => ({
  id,
  type: "url" as const,
  content: `https://${id}.example/sub?token=test-only`,
  subscriptionUserInfo: { total: 10000 },
}));
const node = (id: string, password = "fixture-old"): ParsedNode => ({
  type: "trojan",
  name: id,
  server: `${id}.example`,
  port: 443,
  password,
  _sourceIds: [id],
  _originName: id,
});
const success = (id: string, password = "fixture-new") => ({
  ok: true,
  parsedNodes: [node(id, password)],
  parseErrors: [],
  headers: { "subscription-userinfo": "total=20000" },
});
const failure = {
  ok: false,
  responseStatus: 404,
  error: "HTTP 404 password: fixture-never-log-this",
  errorInfo: { category: "network", httpStatus: 404, message: "fixture-never-log-this" },
};

// Explicit opt-in: this suite must never select the application's configured database.
describe.runIf(Boolean(databaseUrl))("subscription source updates with PostgreSQL", () => {
  let prisma: typeof import("./prisma").prisma;
  let service: typeof import("./subscription-service");
  let sourceService: typeof import("./subscription-source-service");
  let store: typeof import("./subscription-source-update-store");
  let locks: typeof import("./subscription-refresh-lock");
  let crypto: typeof import("./crypto");
  let cron: typeof import("./auto-update-service");
  let ownerId: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/subboost_source_updates_test")
      throw new Error("A dedicated localhost test database is required");
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    vi.stubEnv("ENCRYPTION_KEY", "source-update-integration-test-encryption-key-only");
    vi.stubEnv("APP_URL", "http://127.0.0.1:3001");
    prisma = (await import("./prisma")).prisma;
    service = await import("./subscription-service");
    sourceService = await import("./subscription-source-service");
    store = await import("./subscription-source-update-store");
    locks = await import("./subscription-refresh-lock");
    crypto = await import("./crypto");
    cron = await import("./auto-update-service");
  });
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    ownerId = (
      await prisma.localAdmin.create({
        data: { username: `source-test-${randomUUID()}`, passwordHash: "test-fixture-only" },
      })
    ).id;
    transport.fetch
      .mockReset()
      .mockImplementation(async ({ url }: { url: string }) => success(new URL(url).hostname[0]));
  });
  afterEach(async () => {
    await prisma.localAdmin.delete({ where: { id: ownerId } });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const created = await service.createSubscription(ownerId, {
      name: "Source update fixture",
      urls: sources.map((source) => source.content),
      nodes: [node("a"), node("b")],
      config: { sources },
      autoUpdateInterval: 360,
    });
    return prisma.subscription.update({
      where: { id: created.id },
      data: {
        createdAt: new Date(Date.now() - 86_400_000),
        updatedAt: new Date(Date.now() - 86_400_000),
        lastUpdatedAt: new Date(Date.now() - 3_600_000),
      },
      include: { autoUpdateState: true },
    });
  }

  it("old subscriptions have current node counts but no fabricated per-source success time", async () => {
    const row = await fixture();
    const listed = await sourceService.listSubscriptionSources(ownerId, row.id);
    expect(listed).toHaveLength(2);
    expect(listed?.map((source) => [source.nodeCount, source.lastSuccessfulAt, source.lastResult])).toEqual([
      [1, null, null],
      [1, null, null],
    ]);
    expect(JSON.stringify(listed)).not.toContain("test-only");
    expect(await sourceService.listSubscriptionSources("other-owner", row.id)).toBeNull();
    expect(
      await sourceService.getSubscriptionSourceHistory(ownerId, row.id, "missing", new URLSearchParams()),
    ).toBeNull();
  });

  it("four failures never pause the aggregate, while a healthy source keeps updating", async () => {
    const row = await fixture();
    for (let round = 0; round < 4; round++) {
      transport.fetch.mockImplementation(async ({ url }: { url: string }) =>
        url.includes("b.example") ? failure : success("a", `round-${round}`),
      );
      const summary = await cron.runLocalSubscriptionAutoUpdateCron(new Date(Date.now() + 3_600_000));
      expect(summary.results.updated).toBe(1);
      const current = await prisma.subscription.findUniqueOrThrow({
        where: { id: row.id },
        include: { autoUpdateState: true },
      });
      const saved = service.readSubscriptionSecrets(current);
      expect(current.autoUpdateInterval).toBe(360);
      expect(current.autoUpdateState).toMatchObject({
        externalFailureCount: round + 1,
        disabledAt: null,
        disabledReason: null,
      });
      expect(saved.nodes.find((item) => item.name === "a")).toMatchObject({ password: `round-${round}` });
      expect(saved.nodes.find((item) => item.name === "b")).toMatchObject({ password: "fixture-old" });
      expect(saved.subscriptionInfo.total).toBe(30000);
    }
    const logs = await prisma.subscriptionSourceUpdateLog.findMany({ where: { subscriptionId: row.id } });
    expect(logs).toHaveLength(8);
    expect(logs.filter((log) => log.sourceId === "b").every((log) => log.result === "failed")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("fixture-never-log-this");
    expect(JSON.stringify(logs)).not.toContain("token=test-only");
  });

  it("all failures retain the published snapshot and later recover without enabling automatic updates again", async () => {
    const row = await fixture();
    transport.fetch.mockResolvedValue(failure);
    expect((await cron.runLocalSubscriptionAutoUpdateCron(new Date())).results.failed).toBe(1);
    const failed = await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } });
    expect(failed.encryptedNodes).toBe(row.encryptedNodes);
    expect(failed.lastUpdatedAt).toEqual(row.lastUpdatedAt);
    expect(failed.autoUpdateInterval).toBe(360);
    transport.fetch.mockImplementation(async ({ url }: { url: string }) => success(new URL(url).hostname[0]));
    expect(
      (await cron.runLocalSubscriptionAutoUpdateCron(new Date(Date.now() + 3_600_000))).results.updated,
    ).toBe(1);
    const states = await sourceService.listSubscriptionSources(ownerId, row.id);
    expect(
      states?.every((source) => source.lastResult === "applied" && source.lastSuccessfulAt !== null),
    ).toBe(true);
  });

  it("single-source refresh preserves peers and publishes through the original link without deferring the full schedule", async () => {
    const row = await fixture();
    const lastSuccess = new Date(Date.now() - 86_400_000);
    await prisma.subscriptionSourceUpdateState.create({
      data: {
        subscriptionId: row.id,
        sourceId: "b",
        lastAttemptedAt: lastSuccess,
        lastSuccessfulAt: lastSuccess,
        lastResult: "failed",
        lastError: "HTTP 404",
        nodeCount: 1,
      },
    });
    const result = await service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" });
    expect(result?.ok).toBe(true);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.fetch.mock.calls[0][0].url).toBe(sources[0].content);
    const current = await prisma.subscription.findUniqueOrThrow({
      where: { id: row.id },
      include: { autoUpdateState: true },
    });
    expect(current.token).toBe(row.token);
    expect(current.autoUpdateState?.lastAttemptedAt).toEqual(row.lastUpdatedAt);
    expect(cron.resolveLocalAutoUpdateSchedule(current, new Date()).due).toBe(true);
    expect(service.readSubscriptionSecrets(current).nodes.find((item) => item.name === "b")).toMatchObject(
      node("b"),
    );
    expect(service.readSubscriptionSecrets(current).subscriptionInfo.total).toBe(30000);
    expect((await service.generateSubscriptionYaml(row.token))?.yaml).toContain("fixture-new");
    expect(
      (await sourceService.listSubscriptionSources(ownerId, row.id))?.find((source) => source.id === "b"),
    ).toMatchObject({ lastResult: "failed", lastSuccessfulAt: lastSuccess.toISOString() });
    const history = await sourceService.getSubscriptionSourceHistory(
      ownerId,
      row.id,
      "a",
      new URLSearchParams(),
    );
    expect(history?.records[0]).toMatchObject({
      trigger: "manual_source",
      result: "applied",
      nodeCountBefore: 1,
      nodeCountAfter: 1,
      nodesChanged: true,
    });
  });

  it("rejects competing manual and automatic refreshes before they fetch or add history", async () => {
    const row = await fixture();
    let release!: (value: ReturnType<typeof success>) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.fetch.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const first = service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" });
    await ready;
    try {
      expect(await service.refreshSubscription(ownerId, row.id, { targetSourceId: "b" })).toMatchObject({
        ok: false,
        response: { status: 409, body: { code: "REFRESH_BUSY" } },
      });
      expect((await cron.runLocalSubscriptionAutoUpdateCron(new Date())).results.skipped).toBe(1);
      expect(transport.fetch).toHaveBeenCalledTimes(1);
    } finally {
      release(success("a"));
    }
    expect((await first)?.ok).toBe(true);
    expect(await prisma.subscriptionSourceUpdateLog.count({ where: { subscriptionId: row.id } })).toBe(1);
  });

  it("an intervening edit wins, and fetched data is recorded as not applied without a false success state", async () => {
    const row = await fixture();
    let release!: (value: ReturnType<typeof success>) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.fetch.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" });
    await ready;
    try {
      await service.updateSubscription(ownerId, row.id, { name: "Concurrent edit" });
    } finally {
      release(success("a"));
    }
    expect(await pending).toMatchObject({ ok: false, response: { status: 409 } });
    const current = await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } });
    expect(current.name).toBe("Concurrent edit");
    expect(current.encryptedNodes).toBe(row.encryptedNodes);
    expect(await prisma.subscriptionSourceUpdateState.count({ where: { subscriptionId: row.id } })).toBe(0);
    expect(
      await prisma.subscriptionSourceUpdateLog.findFirst({ where: { subscriptionId: row.id } }),
    ).toMatchObject({ result: "not_applied" });
  });

  it("normal client downloads do not create a refresh configuration conflict", async () => {
    const row = await fixture();
    let release!: (value: ReturnType<typeof success>) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.fetch.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" });
    await ready;
    try {
      await service.generateSubscriptionYaml(row.token);
      const downloaded = await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } });
      expect(downloaded.lastAccessedAt).not.toBeNull();
      expect(downloaded.updatedAt).toEqual(row.updatedAt);
    } finally {
      release(success("a"));
    }
    expect((await pending)?.ok).toBe(true);
  });

  it("a history write failure rolls back the snapshot and source success state in the same transaction", async () => {
    const row = await fixture();
    const snapshot = await refreshNodeSnapshot({
      config: { sources },
      urls: [],
      storedNodes: [node("a"), node("b")],
      targetSourceId: "a",
      fetchUrlNodes: async () => ({ ok: true, nodes: [node("a", "new")] }),
    });
    snapshot.sourceResults![0].completedAt = new Date(NaN);
    await expect(
      locks.withSubscriptionRefreshLease(row.id, (lease) =>
        store.persistSubscriptionRefresh({
          subscriptionId: row.id,
          expectedUpdatedAt: row.updatedAt,
          lease,
          state: {
            externalFailureCount: 0,
            failureSourceState: null,
            lastFailedAt: null,
            lastAttemptedAt: new Date(),
            nodeQuotaFailureCount: 0,
            lastNodeQuotaExceededAt: null,
            lastNodeQuotaActual: null,
            lastNodeQuotaLimit: null,
            disabledAt: null,
            disabledReason: null,
            disabledPreviousInterval: null,
          },
          data: { encryptedNodes: crypto.encryptJson(snapshot.nodes) },
          sourceUpdates: { snapshot, trigger: "manual_source", applied: true },
        }),
      ),
    ).rejects.toThrow();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).encryptedNodes).toBe(
      row.encryptedNodes,
    );
    expect(await prisma.subscriptionSourceUpdateState.count({ where: { subscriptionId: row.id } })).toBe(0);
    expect(await prisma.subscriptionSourceUpdateLog.count({ where: { subscriptionId: row.id } })).toBe(0);
  });

  it("prunes to 200 records, pages without duplicates, and retains the last success independently", async () => {
    const row = await fixture();
    const at = new Date(Date.now() - 100000);
    await prisma.subscriptionSourceUpdateLog.createMany({
      data: Array.from({ length: 210 }, (_, index) => ({
        subscriptionId: row.id,
        sourceId: "a",
        sourceType: "url",
        sourceLabel: "a.example",
        trigger: "automatic" as const,
        result: "unchanged" as const,
        startedAt: at,
        completedAt: new Date(at.getTime() + index),
        durationMs: 1,
        nodeCountBefore: 1,
        nodeCountAfter: 1,
        nodesChanged: false,
      })),
    });
    await prisma.subscriptionSourceUpdateState.create({
      data: {
        subscriptionId: row.id,
        sourceId: "a",
        lastAttemptedAt: at,
        lastSuccessfulAt: at,
        lastResult: "unchanged",
        nodeCount: 1,
      },
    });
    transport.fetch.mockResolvedValueOnce(failure);
    expect(await service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" })).toMatchObject({
      ok: false,
      response: { status: 502 },
    });
    expect(
      await prisma.subscriptionSourceUpdateLog.count({ where: { subscriptionId: row.id, sourceId: "a" } }),
    ).toBe(200);
    const first = await sourceService.getSubscriptionSourceHistory(
      ownerId,
      row.id,
      "a",
      new URLSearchParams(),
    );
    const second = await sourceService.getSubscriptionSourceHistory(
      ownerId,
      row.id,
      "a",
      new URLSearchParams({ cursor: first!.nextCursor! }),
    );
    expect(first?.records).toHaveLength(20);
    expect(second?.records).toHaveLength(20);
    expect(new Set([...first!.records, ...second!.records].map((record) => record.id)).size).toBe(40);
    expect(
      (await sourceService.listSubscriptionSources(ownerId, row.id))?.find((source) => source.id === "a")
        ?.lastSuccessfulAt,
    ).toBe(at.toISOString());
    await expect(
      sourceService.getSubscriptionSourceHistory(ownerId, row.id, "a", new URLSearchParams({ limit: "101" })),
    ).rejects.toThrow("1 到 100");
  });

  it("source replacement resets current status, and source deletion removes its history", async () => {
    const row = await fixture();
    await service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" });
    await service.updateSubscription(ownerId, row.id, {
      config: { sources: [{ ...sources[0], content: "https://replacement.example/sub" }, sources[1]] },
    });
    expect(
      (await sourceService.listSubscriptionSources(ownerId, row.id))?.find((source) => source.id === "a")
        ?.lastResult,
    ).toBeNull();
    expect(
      await prisma.subscriptionSourceUpdateLog.count({ where: { subscriptionId: row.id, sourceId: "a" } }),
    ).toBe(1);
    await service.updateSubscription(ownerId, row.id, {
      config: { sources: [sources[1]] },
      nodes: [node("b")],
    });
    expect(
      await prisma.subscriptionSourceUpdateLog.count({ where: { subscriptionId: row.id, sourceId: "a" } }),
    ).toBe(0);
    expect(await sourceService.listSubscriptionSources(ownerId, row.id)).toHaveLength(1);
  });
  it("reparses a static source without network requests and rejects client-managed sources", async () => {
    const row = await fixture();
    const staticSource = {
      id: "static",
      type: "nodes",
      content: "trojan://fixture-static@static.example:443#Static",
    };
    const provider = {
      id: "provider",
      type: "url",
      content: "https://provider.example/sub",
      useProxyProviders: true,
    };
    await service.updateSubscription(ownerId, row.id, {
      config: { sources: [...sources, staticSource, provider] },
    });
    expect((await service.refreshSubscription(ownerId, row.id, { targetSourceId: "static" }))?.ok).toBe(true);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(await service.refreshSubscription(ownerId, row.id, { targetSourceId: "provider" })).toMatchObject({
      ok: false,
      response: { status: 400 },
    });
    expect(await service.refreshSubscription("another-owner", row.id, { targetSourceId: "a" })).toBeNull();
    const current = await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } });
    expect(
      service.readSubscriptionSecrets(current).nodes.some((item) => item.server === "static.example"),
    ).toBe(true);
    expect(await prisma.subscriptionSourceUpdateLog.count({ where: { subscriptionId: row.id } })).toBe(1);
  });

  it("quota rejection retains the old snapshot and never records fetched nodes as successfully applied", async () => {
    const row = await fixture();
    transport.fetch.mockResolvedValueOnce({
      ...success("a"),
      parsedNodes: Array.from({ length: 10001 }, (_, index) => ({
        ...node("a"),
        name: `Node-${index}`,
        server: `quota-${index}.example`,
      })),
    });
    expect(await service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" })).toMatchObject({
      ok: false,
      response: { status: 403 },
    });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).encryptedNodes).toBe(
      row.encryptedNodes,
    );
    expect(
      await prisma.subscriptionSourceUpdateState.findUnique({
        where: { subscriptionId_sourceId: { subscriptionId: row.id, sourceId: "a" } },
      }),
    ).toMatchObject({ lastResult: "not_applied", lastSuccessfulAt: null, nodeCount: 1 });
    expect(
      await prisma.subscriptionSourceUpdateLog.findFirst({ where: { subscriptionId: row.id } }),
    ).toMatchObject({ result: "not_applied", nodeCountBefore: 1, nodeCountAfter: 1, nodesChanged: false });
  });
  it("partial parsing is applied with an explicit warning rather than claiming a complete clean import", async () => {
    const row = await fixture();
    transport.fetch.mockResolvedValueOnce({ ...success("a"), parseErrors: ["fixture parse warning"] });
    const response = await service.refreshSubscription(ownerId, row.id, { targetSourceId: "a" });
    expect(response).toMatchObject({
      ok: true,
      body: { sourceUpdate: { result: "applied", warningCount: 1 } },
    });
    expect(
      (await sourceService.listSubscriptionSources(ownerId, row.id))?.find((source) => source.id === "a"),
    ).toMatchObject({ lastResult: "applied", warningCount: 1 });
  });

  it("an expired refresh lease cannot commit a snapshot or success history", async () => {
    const row = await fixture();
    const snapshot = await refreshNodeSnapshot({
      config: { sources },
      urls: [],
      storedNodes: [node("a"), node("b")],
      targetSourceId: "a",
      fetchUrlNodes: async () => ({ ok: true, nodes: [node("a", "new")] }),
    });
    await expect(
      locks.withSubscriptionRefreshLease(row.id, async (lease) => {
        await prisma.jobLeaseLock.update({
          where: { name: lease.lease.name },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        return store.persistSubscriptionRefresh({
          subscriptionId: row.id,
          expectedUpdatedAt: row.updatedAt,
          lease,
          state: {
            externalFailureCount: 0,
            failureSourceState: null,
            lastFailedAt: null,
            lastAttemptedAt: new Date(),
            nodeQuotaFailureCount: 0,
            lastNodeQuotaExceededAt: null,
            lastNodeQuotaActual: null,
            lastNodeQuotaLimit: null,
            disabledAt: null,
            disabledReason: null,
            disabledPreviousInterval: null,
          },
          data: { encryptedNodes: crypto.encryptJson(snapshot.nodes) },
          sourceUpdates: { snapshot, trigger: "manual_source", applied: true },
        });
      }),
    ).rejects.toThrow("Local job lease lost");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).encryptedNodes).toBe(
      row.encryptedNodes,
    );
    expect(await prisma.subscriptionSourceUpdateLog.count({ where: { subscriptionId: row.id } })).toBe(0);
  });
});
