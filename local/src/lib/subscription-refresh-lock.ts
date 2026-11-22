import type { Prisma } from "../generated/prisma";
import {
  acquireLocalJobLease,
  releaseLocalJobLease,
  startLocalJobLeaseHeartbeat,
  JobLeaseLostError,
  type LocalJobLease,
} from "./job-lease";

const LEASE_MS = 300_000;

export type SubscriptionRefreshLease = {
  lease: LocalJobLease;
  assertOwned: () => Promise<void>;
  signal?: AbortSignal;
  cronLease?: LocalJobLease;
};

export async function withSubscriptionRefreshLease<T>(
  subscriptionId: string,
  run: (context: SubscriptionRefreshLease) => Promise<T>,
  options: { signal?: AbortSignal; cronLease?: LocalJobLease } = {},
): Promise<{ busy: true } | { busy: false; value: T }> {
  options.signal?.throwIfAborted();
  const lease = await acquireLocalJobLease({
    name: `subscription-refresh:${subscriptionId}`,
    leaseMs: LEASE_MS,
  });
  if (!lease) return { busy: true };
  const heartbeat = startLocalJobLeaseHeartbeat({ lease, leaseMs: LEASE_MS, intervalMs: 60_000 });
  const signal = options.signal ? AbortSignal.any([options.signal, heartbeat.signal]) : heartbeat.signal;
  try {
    signal.throwIfAborted();
    const value = await run({ lease, signal, cronLease: options.cronLease, assertOwned: async () => {
      signal.throwIfAborted();
      await heartbeat.assertOwned();
      signal.throwIfAborted();
    } });
    signal.throwIfAborted();
    return { busy: false, value };
  } finally {
    try { await heartbeat.stop(); }
    finally { await releaseLocalJobLease(lease); }
  }
}

/** Lock the lease row for the commit so an expired worker cannot publish after a new owner. */
export async function assertSubscriptionRefreshLease(
  tx: Prisma.TransactionClient,
  context: SubscriptionRefreshLease,
) {
  context.signal?.throwIfAborted();
  if (context.cronLease) {
    // SHARE lets different aggregates commit together, but fences a replaced global owner.
    const cronRows = await tx.$queryRaw<Array<{ name: string }>>`
      SELECT "name" FROM "JobLeaseLock"
      WHERE "name" = ${context.cronLease.name} AND "ownerToken" = ${context.cronLease.ownerToken}
        AND "expiresAt" > clock_timestamp()
      FOR SHARE
    `;
    if (cronRows.length !== 1) throw new JobLeaseLostError(context.cronLease.name);
  }
  const rows = await tx.$queryRaw<Array<{ name: string }>>`
    SELECT "name" FROM "JobLeaseLock"
    WHERE "name" = ${context.lease.name} AND "ownerToken" = ${context.lease.ownerToken}
      AND "expiresAt" > clock_timestamp()
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new JobLeaseLostError(context.lease.name);
  context.signal?.throwIfAborted();
}
