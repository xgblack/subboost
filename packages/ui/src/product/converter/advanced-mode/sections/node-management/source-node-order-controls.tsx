"use client";

import { getNodeManualPosition } from "@subboost/core/subscription/node-order";
import { Button } from "@subboost/ui/components/ui/button";
import { useConfigStore } from "@subboost/ui/store/config-store";

export function SourceNodeOrderControls({ hasProxyProviders }: { hasProxyProviders: boolean }) {
  const { nodes, nodeSortMode, enableSourceNodeSorting, clearManualNodePositions } = useConfigStore();
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-fg-50">
        <span>{nodeSortMode === "source" ? "未指定位置的节点按订阅顺序排列" : "当前保留旧版节点顺序"}</span>
        {nodeSortMode === "source" ? (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
            disabled={!nodes.some((node) => getNodeManualPosition(node) !== undefined)}
            onClick={clearManualNodePositions}>清除全部指定位置</Button>
        ) : (
          <Button variant="secondary" size="sm" className="h-7 px-2 text-xs"
            onClick={enableSourceNodeSorting}>启用来源排序</Button>
        )}
      </div>
      {hasProxyProviders && <p className="mb-2 text-xs text-fg-40">proxy-providers 的节点由客户端拉取，无法在此指定单个节点的位置。</p>}
    </>
  );
}
