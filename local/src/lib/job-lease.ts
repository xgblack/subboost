import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";

export type LocalJobLease = {
  name: string;
  ownerToken: string;
  expiresAt: Date;
};

export class JobLeaseLostError extends Error {
  constructor(readonly leaseName: string) {
    super(`Local job lease lost: ${leaseName}`);
    this.name = "JobLeaseLostError";
  }
}

export async function acquireLocalJobLease(params: {
  name: string;
  leaseMs: number;
  now?: Date;
}): Promise<LocalJobLease | null> {
  const now = params.now ?? new Date();
  const ownerToken = randomUUID();
  const expiresAt = new Date(now.getTime() + params.leaseMs);
  const rows = await prisma.$queryRaw<LocalJobLease[]>`
    INSERT INTO "JobLeaseLock" ("name", "ownerToken", "expiresAt", "updatedAt")
    VALUES (${params.name}, ${ownerToken}, ${expiresAt}, ${now})
    ON CONFLICT ("name") DO UPDATE
    SET "ownerToken" = EXCLUDED."ownerToken",
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = EXCLUDED."updatedAt"
    WHERE "JobLeaseLock"."expiresAt" <= ${now}
    RETURNING "name", "ownerToken", "expiresAt"
  `;
  return rows[0] ?? null;
}

export async function renewLocalJobLease(
  lease: LocalJobLease,
  leaseMs: number,
  now = new Date()
): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + leaseMs);
  const count = await prisma.$executeRaw`
    UPDATE "JobLeaseLock"
    SET "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
    WHERE "name" = ${lease.name}
      AND "ownerToken" = ${lease.ownerToken}
      AND "expiresAt" > ${now}
  `;
  if (count === 1) lease.expiresAt = expiresAt;
  return count === 1;
}

export async function releaseLocalJobLease(lease: LocalJobLease): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "JobLeaseLock"
    WHERE "name" = ${lease.name} AND "ownerToken" = ${lease.ownerToken}
  `;
}

export function startLocalJobLeaseHeartbeat(params: {
  lease: LocalJobLease;
  leaseMs: number;
  intervalMs: number;
}): { signal: AbortSignal; assertOwned: () => Promise<void>; stop: () => Promise<void> } {
  let stopped = false;
  const controller = new AbortController();
  let pending: Promise<void> = Promise.resolve();

  const renew = async () => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    try {
      if (!(await renewLocalJobLease(params.lease, params.leaseMs))) throw new JobLeaseLostError(params.lease.name);
    } catch {
      // A failed renewal cannot prove ownership either. Cancel active I/O, not just the next commit.
      controller.abort(new JobLeaseLostError(params.lease.name));
      throw controller.signal.reason;
    }
  };
  const enqueue = () => {
    const next = pending.then(renew);
    pending = next.catch(() => undefined);
    return next;
  };
  const timer = setInterval(() => {
    void enqueue().catch(() => undefined);
  }, params.intervalMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    assertOwned: async () => {
      if (stopped) throw new JobLeaseLostError(params.lease.name);
      controller.signal.throwIfAborted();
      await enqueue();
      if (stopped) throw new JobLeaseLostError(params.lease.name);
      controller.signal.throwIfAborted();
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
