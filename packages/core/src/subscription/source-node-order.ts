import type { ParsedNode } from "../types/node";
import { buildScopedNodeIdentityKey } from "../node-identity";
import { getNodeOriginName, getNodeSourceIds, SOURCE_IDS_KEY } from "./node-source-state";
import {
  getNodeManualPosition,
  getNodeSourceOrder,
  MANUAL_POSITION_KEY,
  normalizeNodeOrderMetadata,
  SOURCE_ORDER_KEY,
  withNodeManualPosition,
} from "./node-order";
import type { SourceRefreshDescriptor } from "./source-node-refresh";

/** Imported content cannot supply local positions or source memberships. */
export function prepareImportedNodeOrder(node: ParsedNode, sourceId?: string, index = 0): ParsedNode {
  const next = { ...node };
  delete next[MANUAL_POSITION_KEY];
  delete next[SOURCE_ORDER_KEY];
  delete next[SOURCE_IDS_KEY];
  if (sourceId) {
    next[SOURCE_IDS_KEY] = [sourceId];
    next[SOURCE_ORDER_KEY] = { [sourceId]: index };
  }
  return next;
}

function originOf(node: ParsedNode): string {
  return (getNodeOriginName(node) ?? node.name ?? "").trim();
}

function groupByOrigin(nodes: ParsedNode[]): Map<string, ParsedNode[]> {
  const groups = new Map<string, ParsedNode[]>();
  for (const node of nodes) {
    const origin = originOf(node);
    const group = groups.get(origin);
    if (group) group.push(node);
    else groups.set(origin, [node]);
  }
  return groups;
}

/** Decorate the existing refresh result without changing upstream name matching. */
export function refreshSourceNodeOrder(
  storedNodes: ParsedNode[],
  parsedNodes: ParsedNode[],
  mergedNodes: ParsedNode[],
  descriptor: SourceRefreshDescriptor,
  renameMap: ReadonlyMap<string, string>,
): ParsedNode[] {
  const sourceId = descriptor.sourceId;
  const eligible = storedNodes.filter((node) => {
    const ids = getNodeSourceIds(node);
    return ids.length === 0 || ids.includes(sourceId);
  });
  const storedByOrigin = groupByOrigin(eligible);
  const storedByIdentity = new Map<string, ParsedNode | null>();
  for (const node of eligible) {
    const key = buildScopedNodeIdentityKey(originOf(node), node);
    storedByIdentity.set(key, storedByIdentity.has(key) ? null : node);
  }
  const freshByOrigin = groupByOrigin(parsedNodes);
  const storedByName = new Map(storedNodes.map((node) => [renameMap.get(node.name) ?? node.name, node]));
  const ordinals = new Map<string, number>();
  parsedNodes.forEach((node, index) => {
    const key = buildScopedNodeIdentityKey(originOf(node), node);
    if (!ordinals.has(key)) ordinals.set(key, index);
  });

  return normalizeNodeOrderMetadata(mergedNodes.map((node) => {
    if (!getNodeSourceIds(node).includes(sourceId)) return node;
    const origin = originOf(node);
    const candidates = storedByOrigin.get(origin) ?? [];
    const key = buildScopedNodeIdentityKey(origin, node);
    const exact = storedByIdentity.get(key);
    const named = storedByName.get(node.name);
    // Duplicate origins need a unique content match, otherwise a pin could
    // silently jump to another node when the subscription reverses its list.
    const previous = exact ?? (
      (freshByOrigin.get(origin)?.length ?? 0) === 1 && candidates.length <= 1
        ? candidates[0] ?? named : undefined);
    const preservePin = previous && (!descriptor.treatAsNewSource ||
      getNodeSourceIds(previous).some((id) => id !== sourceId));
    const next = withNodeManualPosition(node, preservePin ? getNodeManualPosition(previous) : undefined);
    const order = { ...getNodeSourceOrder(previous ?? node) };
    delete order[sourceId];
    const ordinal = ordinals.get(key);
    if (ordinal !== undefined) order[sourceId] = ordinal;
    next[SOURCE_ORDER_KEY] = order;
    return next;
  }));
}
