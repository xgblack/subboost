import type { ParsedNode } from "@subboost/core/types/node";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import { detachSourceNodesFromState, mergeParsedSourceNodes } from "@subboost/core/subscription/source-node-refresh";
import { composeNodeNameRenameMaps, reconcileNodeNameReferences } from "@subboost/core/subscription/node-name-references";
import type { StoreState } from "./store-types";

/** Source sorting keeps local edits and the last successful snapshot of failed imports. */
export function mergeSourceNodeOrderBatch(
  state: StoreState,
  parsedNodes: ParsedNode[],
  sourceMeta: ReadonlyMap<string, { parsed: boolean; lastParsedContent?: string }>,
): Partial<StoreState> {
  if (state.nodeSortMode !== "source") return {};
  // Preserve the batch import's existing handling of blank deletion markers.
  const deletedNodes = state.deletedNodes.filter((item) => {
    if (!item?.node) return false;
    const origin = typeof item.originName === "string" && item.originName.trim()
      ? item.originName : typeof item.node._originName === "string" ? item.node._originName : item.node.name;
    return Boolean(origin.trim());
  });
  let nodes = state.nodes;
  let renameMap = new Map<string, string>();
  for (const source of state.sources) {
    const meta = sourceMeta.get(source.id);
    if (!meta?.parsed) continue;
    const fresh = parsedNodes.filter((node) => getNodeSourceIds(node).includes(source.id));
    const result = source.type === "url" && source.useProxyProviders
      ? detachSourceNodesFromState(nodes, source.id)
      : mergeParsedSourceNodes(nodes, fresh, state.deletedNodeNames, {
          sourceId: source.id,
          currentTag: source.tag,
          currentNameTemplate: source.nameTemplate,
          lastTag: source.lastParsedTag,
          lastNameTemplate: source.lastParsedNameTemplate,
          treatAsNewSource: source.type === "url" && Boolean(source.lastParsedContent) &&
            source.lastParsedContent?.trim() !== meta.lastParsedContent,
          deletedNodes,
        });
    nodes = result.nodes;
    renameMap = composeNodeNameRenameMaps(renameMap, result.renameMap);
  }
  return {
    nodes,
    ...reconcileNodeNameReferences({
      listenerPorts: state.listenerPorts,
      dialerProxyGroups: state.dialerProxyGroups,
      proxyGroupAdvanced: state.proxyGroupAdvanced,
      customProxyGroups: state.customProxyGroups,
      enabledGroups: state.enabledProxyGroups,
      proxyGroupNameOverrides: state.proxyGroupNameOverrides,
    }, { nodes, renameMap }),
  };
}
