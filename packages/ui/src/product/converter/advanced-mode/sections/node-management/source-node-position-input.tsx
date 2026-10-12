"use client";

import type * as React from "react";
import { RotateCcw } from "lucide-react";
import type { ParsedNode } from "@subboost/core/types/node";
import { getNodeManualPosition } from "@subboost/core/subscription/node-order";
import { IconButton } from "@subboost/ui/components/ui/icon-button";
import { Input } from "@subboost/ui/components/ui/input";
import { cn } from "@subboost/ui/lib/utils";

export function SourceNodePositionInput({
  node, position, nodeCount, orderDrafts, setOrderDrafts, setNodeOrder,
}: {
  node: ParsedNode;
  position: number;
  nodeCount: number;
  orderDrafts: Record<string, string>;
  setOrderDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setNodeOrder: (name: string, position: number | null) => void;
}) {
  const hasDraft = Object.prototype.hasOwnProperty.call(orderDrafts, node.name);
  const manualPosition = getNodeManualPosition(node);
  const value = hasDraft ? orderDrafts[node.name] : String(manualPosition ?? "");
  const raw = value.trim();
  const invalid = hasDraft && raw !== "" && (!/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > nodeCount);
  const error = invalid ? `请输入 1–${nodeCount} 的整数，留空则跟随订阅` : "";
  const resetDraft = () => setOrderDrafts((previous) => {
    const { [node.name]: _removed, ...rest } = previous;
    return rest;
  });
  const commit = () => {
    if (!hasDraft || invalid) return;
    setNodeOrder(node.name, raw ? Number(raw) : null);
    resetDraft();
  };

  return (
    <>
      <span className="text-[10px] text-fg-40 whitespace-nowrap" title="当前实际位置">第 {position} 位</span>
      <Input
        aria-label={`${node.name}的指定位置`}
        value={value}
        onChange={(event) => setOrderDrafts((previous) => ({ ...previous, [node.name]: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { event.preventDefault(); resetDraft(); }
        }}
        onBlur={commit}
        inputMode="numeric"
        placeholder="跟随订阅"
        aria-invalid={invalid}
        aria-describedby={error ? `node-order-error-${position}` : undefined}
        title={error || (manualPosition !== undefined && manualPosition !== position
          ? `指定第 ${manualPosition} 位，当前按可用位置排列` : "指定全局位置，留空则跟随订阅")}
        className={cn("h-6 w-16 text-[10px] bg-ink/10 border-ink/10 text-center px-1", invalid && "border-red-500/50")}
      />
      {manualPosition !== undefined && (
        <IconButton label="恢复继承" variant="ghost" className="h-6 w-6"
          onClick={() => { setNodeOrder(node.name, null); resetDraft(); }}>
          <RotateCcw className="h-3 w-3" />
        </IconButton>
      )}
      {error && <span id={`node-order-error-${position}`} role="alert" className="text-[10px] text-red-300">{error}</span>}
    </>
  );
}
