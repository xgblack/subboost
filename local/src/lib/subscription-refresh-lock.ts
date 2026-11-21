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
};

export async function withSubscriptionRefreshLease<T>(
  subscriptionId: string,
  run: (context: SubscriptionRefreshLease) => Promise<T>,
): Promise<{ busy: true } | { busy: false; value: T }> {
  const lease = await acquireLocalJobLease({
    name: `subscription-refresh:${subscriptionId}`,
    leaseMs: LEASE_MS,
  });
  if (!lease) return { busy: true };
  const heartbeat = startLocalJobLeaseHeartbeat({ lease, leaseMs: LEASE_MS, intervalMs: 60_000 });
  try {
    return { busy: false, value: await run({ lease, assertOwned: heartbeat.assertOwned }) };
  } finally {
    await heartbeat.stop();
    await releaseLocalJobLease(lease);
  }
}

/** Lock the lease row for the commit so an expired worker cannot publish after a new owner. */
export async function assertSubscriptionRefreshLease(
  tx: Prisma.TransactionClient,
  context: SubscriptionRefreshLease,
) {
  const rows = await tx.$queryRaw<Array<{ name: string }>>`
    SELECT "name" FROM "JobLeaseLock"
    WHERE "name" = ${context.lease.name} AND "ownerToken" = ${context.lease.ownerToken}
      AND "expiresAt" > clock_timestamp()
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new JobLeaseLostError(context.lease.name);
}
