"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Database,
  FileCode,
  Globe,
  History,
  Info,
  RefreshCw,
} from "lucide-react";
import { Button } from "@subboost/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@subboost/ui/components/ui/dialog";
import { formatDashboardDate } from "@subboost/ui/dashboard/dashboard-format";
import { readJsonResponse } from "@subboost/ui/product/client-response";
import type { Subscription } from "@subboost/ui/dashboard/dashboard-types";
import type {
  SourceUpdateHistoryPage,
  SourceUpdateResult,
  SubscriptionSourceSummary,
} from "@local/lib/subscription-source-types";

const resultLabels: Record<SourceUpdateResult, string> = {
  applied: "已应用",
  unchanged: "内容无变化",
  failed: "更新失败",
  not_applied: "未应用",
};
const triggerLabels = { automatic: "自动", manual_all: "手动全量", manual_source: "手动单源" };

function sourcePath(subscriptionId: string, sourceId: string) {
  return `/api/subscriptions/${encodeURIComponent(subscriptionId)}/sources/${encodeURIComponent(sourceId)}`;
}

function UpdateHistory({
  subscriptionId,
  sourceId,
  revision,
}: {
  subscriptionId: string;
  sourceId: string;
  revision: number;
}) {
  const [page, setPage] = React.useState<SourceUpdateHistoryPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const pending = React.useRef(false);
  const version = React.useRef(0);
  const load = React.useCallback(
    async (cursor?: string) => {
      if (pending.current && cursor) return;
      pending.current = true;
      const requestVersion = ++version.current;
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) });
        const response = await fetch(`${sourcePath(subscriptionId, sourceId)}/history?${query}`, {
          cache: "no-store",
        });
        const next = await readJsonResponse<SourceUpdateHistoryPage>(response, "读取更新历史失败，请重试。");
        if (!Array.isArray(next.records)) throw new Error("更新历史响应无效，请重试。");
        if (requestVersion !== version.current) return;
        setPage((previous) => ({
          records: cursor
            ? [
                ...(previous?.records ?? []),
                ...next.records.filter((record) => !previous?.records.some((item) => item.id === record.id)),
              ]
            : next.records,
          nextCursor: next.nextCursor,
        }));
      } catch (cause) {
        if (requestVersion === version.current)
          setError(cause instanceof Error ? cause.message : "读取更新历史失败，请重试。");
      } finally {
        if (requestVersion === version.current) {
          pending.current = false;
          setLoading(false);
        }
      }
    },
    [subscriptionId, sourceId],
  );
  React.useEffect(() => {
    void load();
    return () => {
      version.current += 1;
      pending.current = false;
    };
  }, [load, revision]);

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-ink/10 text-xs sm:ml-11">
      <div className="flex items-center gap-2 border-b border-ink/10 bg-ink/3 px-3 py-2.5 text-fg-60">
        <History className="h-3.5 w-3.5" />
        更新历史
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-3 py-3 text-warning-emphasis-fg"
        >
          <span>{error}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void load(page?.nextCursor ?? undefined)}
          >
            重试
          </Button>
        </div>
      )}
      {loading && !page && (
        <div role="status" className="space-y-3 p-3" aria-label="正在读取更新历史">
          <div className="h-3 animate-pulse rounded bg-ink/10" />
          <div className="h-3 animate-pulse rounded bg-ink/10" />
        </div>
      )}
      {page?.records.length === 0 && !loading && (
        <p className="px-3 py-5 text-center text-fg-50">暂无更新记录</p>
      )}
      {page && page.records.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[580px] text-left">
            <thead className="border-b border-ink/10 text-fg-40">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">
                  时间
                </th>
                <th scope="col" className="px-2 py-2 font-normal">
                  触发
                </th>
                <th scope="col" className="px-2 py-2 font-normal">
                  结果
                </th>
                <th scope="col" className="px-2 py-2 font-normal">
                  详情
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  耗时
                </th>
              </tr>
            </thead>
            <tbody>
              {page.records.map((record) => (
                <tr key={record.id} className="border-b border-ink/5 last:border-0">
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums text-fg-60">
                    {formatDashboardDate(record.startedAt)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-fg-50">{triggerLabels[record.trigger]}</td>
                  <td
                    className={`whitespace-nowrap px-2 py-3 ${record.result === "failed" || record.result === "not_applied" ? "text-warning-emphasis-fg" : record.result === "applied" ? "text-success-label-fg" : "text-fg-60"}`}
                  >
                    {resultLabels[record.result]}
                  </td>
                  <td className="min-w-40 px-2 py-3 text-fg-60">
                    {record.errorMessage ??
                      `${record.nodeCountBefore} → ${record.nodeCountAfter} 个节点 · ${record.nodesChanged ? "配置有变化" : "配置无变化"}`}
                    {record.warningCount > 0 && (
                      <span className="block pt-1 text-warning-emphasis-fg">
                        {record.warningCount} 条解析或元数据警告
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-fg-40">
                    {(record.durationMs / 1000).toFixed(1)}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page?.nextCursor && !error && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full rounded-none border-t border-ink/10 text-xs text-fg-50"
          disabled={loading}
          onClick={() => void load(page.nextCursor!)}
        >
          {loading ? "读取中…" : "查看更早记录"}
        </Button>
      )}
    </div>
  );
}

function SourceRow({
  source,
  busy,
  onRefresh,
  subscriptionId,
  revision,
}: {
  source: SubscriptionSourceSummary;
  busy: string | null;
  onRefresh: (source: SubscriptionSourceSummary) => Promise<void>;
  subscriptionId: string;
  revision: number;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const updating = busy === source.id;
  const failed = source.lastResult === "failed" || source.lastResult === "not_applied";
  const status = source.clientManaged
    ? "由客户端更新"
    : source.lastResult
      ? resultLabels[source.lastResult]
      : "暂无更新记录";
  const historyId = React.useId();
  return (
    <div className="border-b border-ink/10 last:border-0">
      <div className="grid items-center gap-3 py-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,.8fr)_11rem]">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ink/10 bg-ink/3 text-fg-50">
            {source.type === "url" ? <Globe className="h-4 w-4" /> : <FileCode className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p className="break-words text-sm font-medium text-fg" title={source.label}>
              {source.label}
            </p>
            <p className="mt-1 break-all text-xs text-fg-50">
              {source.address} · {source.nodeCount} 个节点
            </p>
          </div>
        </div>
        <div className="min-w-0">
          <p
            className={`flex items-center gap-1.5 text-sm ${failed ? "text-warning-emphasis-fg" : source.lastResult === "applied" || source.lastResult === "unchanged" ? "text-success-label-fg" : "text-fg-60"}`}
          >
            {failed ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            ) : source.lastResult ? (
              <CheckCircle className="h-3.5 w-3.5 shrink-0" />
            ) : null}
            {updating ? "更新中…" : status}
          </p>
          {failed ? (
            <>
              <p className="mt-1 break-words text-xs text-fg-50">{source.lastError}</p>
              <p className="mt-1 text-xs text-fg-50">沿用原有 {source.nodeCount} 个节点</p>
            </>
          ) : source.lastResult && !source.clientManaged ? (
            <p className="mt-1 text-xs text-fg-50">
              {source.warningCount ? `已应用，有 ${source.warningCount} 条警告` : "已应用到聚合订阅"}
            </p>
          ) : null}
          {source.lastAttemptedAt && (
            <p className="mt-1 text-xs text-fg-40">最近尝试 {formatDashboardDate(source.lastAttemptedAt)}</p>
          )}
        </div>
        <div className="text-xs tabular-nums text-fg-60">
          <span className="mr-2 text-fg-40 md:hidden">上次成功</span>
          {source.lastSuccessfulAt ? formatDashboardDate(source.lastSuccessfulAt) : "暂无成功记录"}
        </div>
        <div className="flex items-center justify-end gap-2">
          {!source.clientManaged && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={Boolean(busy) || !source.canRefresh}
              title={!source.canRefresh ? "旧节点缺少来源归属，请先在编辑页重新导入该源并保存" : undefined}
              onClick={() => void onRefresh(source)}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${updating ? "animate-spin motion-reduce:animate-none" : ""}`}
              />
              {updating ? "更新中…" : source.type === "url" ? "立即更新" : "重新解析"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-xs text-fg-50"
            aria-expanded={expanded}
            aria-controls={historyId}
            aria-label={`${expanded ? "收起" : "查看"}${source.label}的更新历史`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : "历史"}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>
      </div>
      {!source.canRefresh && !source.clientManaged && (
        <p className="mb-3 text-xs text-warning-emphasis-fg">
          旧节点缺少来源归属，请先在编辑页重新导入该源并保存。
        </p>
      )}
      {expanded && (
        <div id={historyId}>
          <UpdateHistory subscriptionId={subscriptionId} sourceId={source.id} revision={revision} />
        </div>
      )}
    </div>
  );
}

export function SubscriptionSourcesAction({
  subscription,
  onUpdated,
}: {
  subscription: Subscription & { nodeCount?: number };
  onUpdated: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [sources, setSources] = React.useState<SubscriptionSourceSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [revision, setRevision] = React.useState(0);
  const pending = React.useRef(false);
  const version = React.useRef(0);
  const load = React.useCallback(async () => {
    const requestVersion = ++version.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/subscriptions/${encodeURIComponent(subscription.id)}/sources`, {
        cache: "no-store",
      });
      const data = await readJsonResponse<{ sources: SubscriptionSourceSummary[] }>(
        response,
        "读取订阅源失败，请重试。",
      );
      if (!Array.isArray(data.sources)) throw new Error("订阅源响应无效，请重试。");
      if (requestVersion === version.current) setSources(data.sources);
    } catch (cause) {
      if (requestVersion === version.current)
        setError(cause instanceof Error ? cause.message : "读取订阅源失败，请重试。");
    } finally {
      if (requestVersion === version.current) setLoading(false);
    }
  }, [subscription.id]);
  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const refresh = async (source: SubscriptionSourceSummary) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(source.id);
    setFeedback(null);
    try {
      const response = await fetch(`${sourcePath(subscription.id, source.id)}/refresh`, { method: "POST" });
      const result = await readJsonResponse<{
        sourceUpdate?: { result: SourceUpdateResult; warningCount: number };
      }>(response, "更新失败，已保留原配置。");
      const note =
        result.sourceUpdate?.result === "unchanged" ? "检查完成，内容无变化" : "更新完成，已应用到聚合订阅";
      const warnings = result.sourceUpdate?.warningCount
        ? `，有 ${result.sourceUpdate.warningCount} 条警告，可查看历史`
        : "";
      setFeedback({ text: `${source.label}${note}${warnings}。`, failed: false });
    } catch (cause) {
      setFeedback({
        text: cause instanceof Error ? cause.message : "更新失败，请查看历史后重试。",
        failed: true,
      });
    } finally {
      await load();
      setRevision((value) => value + 1);
      pending.current = false;
      setBusy(null);
      await onUpdated();
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-0 sm:gap-2"
          title="查看订阅源更新状态、历史和单独更新"
        >
          <Database className="h-4 w-4" />
          <span className="hidden sm:inline">订阅源</span>
          <span className="sr-only sm:hidden">订阅源</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-w-5xl flex-col overflow-hidden">
        <DialogHeader className="pr-7 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary-label-fg" />
            订阅源
          </DialogTitle>
          <DialogDescription className="break-words">
            {subscription.name} · {sources.length} 个源
            {subscription.nodeCount !== undefined ? ` · ${subscription.nodeCount} 个节点` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {feedback && (
            <p
              role="status"
              className={`mb-3 rounded-lg bg-ink/3 px-3 py-2 text-sm ${feedback.failed ? "text-warning-emphasis-fg" : "text-success-label-fg"}`}
            >
              {feedback.text}
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-ink/10 px-3 py-2 text-sm text-warning-emphasis-fg"
            >
              <span>{error}</span>
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
                重试
              </Button>
            </div>
          )}
          {loading && !sources.length && (
            <div role="status" aria-label="正在读取订阅源" className="space-y-4 py-4">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-16 animate-pulse rounded-lg bg-ink/5" />
              ))}
            </div>
          )}
          {!loading && !error && !sources.length && (
            <p className="py-10 text-center text-sm text-fg-50">暂无订阅源，可在编辑页添加。</p>
          )}
          {sources.length > 0 && (
            <>
              <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,.8fr)_11rem] gap-3 border-b border-ink/10 py-3 text-xs text-fg-40 md:grid">
                <span>订阅源</span>
                <span>最近结果</span>
                <span>上次成功</span>
                <span className="w-44 text-right">操作</span>
              </div>
              {sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  busy={busy}
                  onRefresh={refresh}
                  subscriptionId={subscription.id}
                  revision={revision}
                />
              ))}
            </>
          )}
        </DialogBody>
        <DialogFooter className="items-center border-t border-ink/10 pt-3 sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-fg-50">
            <Info className="h-3.5 w-3.5 shrink-0" />
            更新成功后直接应用到聚合订阅，订阅链接不变。
          </p>
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              关闭
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
