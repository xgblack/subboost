import { normalizeNodeOrderMetadata, setManualNodePosition, sortNodesBySource, withNodeManualPosition } from "@subboost/core/subscription/node-order";
import { resolveNodeNameFilter } from "@subboost/core/subscription/node-name-filter";
import type { ConfigActions } from "../definitions";
import type { SetAndGenerateConfig, StoreState } from "../store-types";

export function nodePositionPatch(
  state: StoreState,
  nodeName: string,
  position: number | null | "up" | "down",
): Partial<StoreState> | StoreState {
  const effective = sortNodesBySource(resolveNodeNameFilter(state.nodes, state.nodeNameFilter).effectiveNodes, state.sources);
  if (typeof position === "string") {
    const from = effective.findIndex((node) => node.name === nodeName);
    if (from < 0) return state;
    const to = from + (position === "up" ? -1 : 1);
    if (to < 0 || to >= effective.length) return state;
    position = to + 1;
  }
  return { nodes: setManualNodePosition(state.nodes, effective, nodeName, position) };
}

export function createNodeOrderActions(
  setAndGenerateConfig: SetAndGenerateConfig,
): Pick<ConfigActions, "enableSourceNodeSorting" | "clearManualNodePositions"> {
  return {
    enableSourceNodeSorting: () => {
      setAndGenerateConfig((state) => ({ nodeSortMode: "source", nodes: normalizeNodeOrderMetadata(state.nodes) }));
    },
    clearManualNodePositions: () => {
      setAndGenerateConfig((state) => ({ nodes: state.nodes.map((node) => withNodeManualPosition(node)) }));
    },
  };
}
