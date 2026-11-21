CREATE TYPE "SubscriptionSourceUpdateResult" AS ENUM ('applied', 'unchanged', 'failed', 'not_applied');
CREATE TYPE "SubscriptionSourceUpdateTrigger" AS ENUM ('automatic', 'manual_all', 'manual_source');

CREATE TABLE "SubscriptionSourceUpdateState" (
  "subscriptionId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "lastAttemptedAt" TIMESTAMP(3) NOT NULL,
  "lastResult" "SubscriptionSourceUpdateResult" NOT NULL,
  "lastSuccessfulAt" TIMESTAMP(3),
  "lastError" VARCHAR(240),
  "nodeCount" INTEGER NOT NULL,
  "warningCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SubscriptionSourceUpdateState_pkey" PRIMARY KEY ("subscriptionId", "sourceId"),
  CONSTRAINT "SubscriptionSourceUpdateState_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SubscriptionSourceUpdateLog" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceLabel" VARCHAR(240) NOT NULL,
  "trigger" "SubscriptionSourceUpdateTrigger" NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "result" "SubscriptionSourceUpdateResult" NOT NULL,
  "nodeCountBefore" INTEGER NOT NULL,
  "nodeCountAfter" INTEGER NOT NULL,
  "nodesChanged" BOOLEAN NOT NULL,
  "warningCount" INTEGER NOT NULL DEFAULT 0,
  "errorCategory" TEXT,
  "httpStatus" INTEGER,
  "errorMessage" VARCHAR(240),
  CONSTRAINT "SubscriptionSourceUpdateLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SubscriptionSourceUpdateLog_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SubscriptionSourceUpdateLog_source_history_idx"
  ON "SubscriptionSourceUpdateLog"("subscriptionId", "sourceId", "completedAt", "id");
