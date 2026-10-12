import type { ParsedNode } from "../types/node";
import { getNodeSourceIds } from "./node-source-state";

export type NodeSortMode = "legacy" | "source";
export const SOURCE_ORDER_KEY = "_sourceOrder";
export const MANUAL_POSITION_KEY = "_manualPosition";

export function normalizeNodeSortMode(value: unknown): NodeSortMode {
  return value === "source" ? "source" : "legacy";
}

export function getNodeManualPosition(node: ParsedNode): number | undefined {
  const value = node[MANUAL_POSITION_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function getNodeSourceOrder(node: ParsedNode): Record<string, number> {
  const value = node[SOURCE_ORDER_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const validIds = new Set(getNodeSourceIds(node));
  return Object.fromEntries(Object.entries(value).filter(([id, order]) =>
    validIds.has(id) && typeof order === "number" && Number.isSafeInteger(order) && order >= 0
  )) as Record<string, number>;
}

export function withNodeManualPosition(node: ParsedNode, position?: number): ParsedNode {
  const next = { ...node };
  delete next[MANUAL_POSITION_KEY];
  if (position !== undefined && Number.isSafeInteger(position) && position > 0) {
    next[MANUAL_POSITION_KEY] = position;
  }
  return next;
}

/** Saved snapshots may lack source ordinals. Capture their relative order once. */
export function normalizeNodeOrderMetadata(nodes: ParsedNode[]): ParsedNode[] {
  const counters = new Map<string, number>();
  return nodes.map((node) => {
    const order = getNodeSourceOrder(node);
    for (const id of getNodeSourceIds(node)) {
      const ordinal = counters.get(id) ?? 0;
      if (!Object.hasOwn(order, id)) Object.defineProperty(order, id, { value: ordinal, enumerable: true, writable: true });
      counters.set(id, ordinal + 1);
    }
    const next = withNodeManualPosition(node, getNodeManualPosition(node));
    delete next[SOURCE_ORDER_KEY];
    if (Object.keys(order).length > 0) next[SOURCE_ORDER_KEY] = order;
    return next;
  });
}

/** Sources establish the default list; explicit absolute positions reserve its slots. */
export function sortNodesBySource(
  nodes: ParsedNode[],
  sources: ReadonlyArray<{ id: string }> = [],
  mode: NodeSortMode = "source",
): ParsedNode[] {
  if (mode !== "source" || nodes.length === 0) return nodes;
  const sourceRanks = new Map(sources.map((source, index) => [source.id, index]));
  const normalized = normalizeNodeOrderMetadata(nodes);
  const defaults = nodes.map((node, index) => {
    let rank = sources.length;
    let ordinal = index;
    for (const id of getNodeSourceIds(node)) {
      const candidate = sourceRanks.get(id);
      if (candidate !== undefined && candidate < rank) {
        rank = candidate;
        ordinal = getNodeSourceOrder(normalized[index])[id] ?? index;
      }
    }
    return { node, index, rank, ordinal };
  }).sort((a, b) => a.rank - b.rank || a.ordinal - b.ordinal || a.index - b.index);

  const pins = nodes.flatMap((node, index) => {
    const target = getNodeManualPosition(node);
    return target === undefined ? [] : [{ node, index, target, slot: 0 }];
  }).sort((a, b) => a.target - b.target || a.index - b.index);

  let previous = 0;
  for (const pin of pins) {
    pin.slot = Math.max(Math.min(pin.target, nodes.length), previous + 1);
    previous = pin.slot;
  }
  let nextSlot = nodes.length + 1;
  for (let i = pins.length - 1; i >= 0; i -= 1) {
    pins[i].slot = Math.min(pins[i].slot, nextSlot - 1);
    nextSlot = pins[i].slot;
  }

  const result = new Array<ParsedNode>(nodes.length);
  for (const pin of pins) result[pin.slot - 1] = pin.node;
  let cursor = 0;
  for (const { node } of defaults) {
    if (getNodeManualPosition(node) !== undefined) continue;
    while (result[cursor]) cursor += 1;
    result[cursor] = node;
  }
  return result;
}

/** Editing commits the visible move, including existing pins shifted by that move. */
export function setManualNodePosition(
  nodes: ParsedNode[],
  effectiveNodes: ParsedNode[],
  nodeName: string,
  position: number | null,
): ParsedNode[] {
  const from = effectiveNodes.findIndex((node) => node.name === nodeName);
  if (from < 0) return nodes;
  if (position === null) return nodes.map((node) => node.name === nodeName ? withNodeManualPosition(node) : node);
  if (!Number.isSafeInteger(position) || position < 1 || position > effectiveNodes.length) return nodes;
  const moved = effectiveNodes.slice();
  const [node] = moved.splice(from, 1);
  moved.splice(position - 1, 0, node);
  const targets = new Map(moved.flatMap((item, index) =>
    item.name === nodeName || getNodeManualPosition(item) !== undefined ? [[item.name, index + 1] as const] : []
  ));
  return nodes.map((item) => targets.has(item.name) ? withNodeManualPosition(item, targets.get(item.name)) : item);
}
