export type SourceUpdateResult = "applied" | "unchanged" | "failed" | "not_applied";
export type SourceUpdateTrigger = "automatic" | "manual_all" | "manual_source";

export type SubscriptionSourceSummary = {
  id: string;
  type: "url" | "yaml" | "nodes";
  label: string;
  address: string;
  clientManaged: boolean;
  canRefresh: boolean;
  nodeCount: number;
  lastAttemptedAt: string | null;
  lastSuccessfulAt: string | null;
  lastResult: SourceUpdateResult | null;
  lastError: string | null;
  warningCount: number;
};

export type SourceUpdateHistoryEntry = {
  id: string;
  sourceLabel: string;
  trigger: SourceUpdateTrigger;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  result: SourceUpdateResult;
  nodeCountBefore: number;
  nodeCountAfter: number;
  nodesChanged: boolean;
  warningCount: number;
  errorMessage: string | null;
};

export type SourceUpdateHistoryPage = { records: SourceUpdateHistoryEntry[]; nextCursor: string | null };
