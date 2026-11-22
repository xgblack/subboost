import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../generated/prisma";
import { assertSubscriptionRefreshLease, withSubscriptionRefreshLease } from "./subscription-refresh-lock";

const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute } }));

describe("subscription refresh lease cancellation and commit fencing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mocks.query.mockImplementation(async (_sql, name, ownerToken) => [{ name, ownerToken, expiresAt: new Date(Date.now() + 300000) }]);
    mocks.execute.mockResolvedValue(1);
  });
  afterEach(() => vi.useRealTimers());

  it("interrupts active work on renewal loss before releasing its lease", async () => {
    let signal: AbortSignal | undefined;
    const pending = withSubscriptionRefreshLease("a", async (lease) => {
      signal = lease.signal;
      await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const rejected = expect(pending).rejects.toThrow("Local job lease lost: subscription-refresh:a");
    mocks.execute.mockResolvedValueOnce(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(mocks.execute.mock.calls.some(([sql]) => String(sql).includes("DELETE"))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not acquire a lease after parent cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("global cancelled fixture");
    controller.abort(reason);
    await expect(withSubscriptionRefreshLease("a", vi.fn(), { signal: controller.signal })).rejects.toBe(reason);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("checks the global owner with a shared lock and the aggregate owner before committing", async () => {
    const query = vi.fn().mockResolvedValue([{ name: "fixture" }]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await assertSubscriptionRefreshLease(tx, {
      lease: { name: "subscription-refresh:a", ownerToken: "a", expiresAt: new Date() },
      cronLease: { name: "local-subscription-auto-update", ownerToken: "cron", expiresAt: new Date() },
      assertOwned: vi.fn(),
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain("FOR SHARE");
    expect(String(query.mock.calls[1][0])).toContain("FOR UPDATE");
  });

  it("rejects a replaced global owner even while the aggregate lease remains valid", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await expect(assertSubscriptionRefreshLease(tx, {
      lease: { name: "subscription-refresh:a", ownerToken: "a", expiresAt: new Date() },
      cronLease: { name: "local-subscription-auto-update", ownerToken: "old", expiresAt: new Date() },
      assertOwned: vi.fn(),
    })).rejects.toMatchObject({ leaseName: "local-subscription-auto-update" });
    expect(query).toHaveBeenCalledOnce();
  });
});
