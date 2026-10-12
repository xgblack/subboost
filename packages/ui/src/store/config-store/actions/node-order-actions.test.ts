import { describe, expect, it } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { sortNodesBySource } from "@subboost/core/subscription/node-order";
import { initialState } from "../definitions";
import { createNodeActions } from "./node-actions";
import type { StoreState } from "../store-types";

const sources = ["A", "B"].map((id) => ({ id, type: "yaml" as const, content: "proxies: []" }));
const nodes: ParsedNode[] = sources.flatMap(({ id }) => [1, 2].map((n) => ({
  name: `${id}${n}`, type: "ss" as const, server: `${id}${n}.example.test`, port: 443, cipher: "aes-128-gcm", password: "test",
  _sourceIds: [id], _sourceOrder: { [id]: n - 1 },
})));

function harness(overrides: Partial<StoreState> = {}) {
  let state = { ...structuredClone(initialState), sources, nodes: structuredClone(nodes), ...overrides } as StoreState;
  const set = (patch: Partial<StoreState> | ((state: StoreState) => Partial<StoreState>)) => {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  };
  const actions = createNodeActions(set, () => state, set);
  const names = () => sortNodesBySource(state.nodes, state.sources, state.nodeSortMode).map((node) => node.name);
  return { actions, state: () => state, names };
}

describe("node order actions", () => {
  it("moves within the filtered list, handles its boundaries, and restores inheritance", () => {
    const test = harness({
      nodes: nodes.map((node) => node.name === "A1" ? { ...node, _manualPosition: 6 } : node),
      nodeNameFilter: { enabled: true, excludeRegexes: ["^A1$"] },
    });
    test.actions.moveNode("B1", "up");
    expect(test.state().nodes.find((node) => node.name === "B1")?._manualPosition).toBe(1);
    expect(test.state().nodes.find((node) => node.name === "A1")?._manualPosition).toBe(6);
    test.actions.moveNode("B1", "up");
    expect(test.state().nodes.find((node) => node.name === "B1")?._manualPosition).toBe(1);
    test.actions.setNodeOrder("B1", null);
    expect(test.state().nodes.find((node) => node.name === "B1")?._manualPosition).toBeUndefined();
    test.actions.clearManualNodePositions();
    expect(test.state().nodes.every((node) => node._manualPosition === undefined)).toBe(true);
    expect(test.names()).toEqual(["A1", "A2", "B1", "B2"]);
  });

  it("preserves a legacy list until source ordering is explicitly enabled", () => {
    const test = harness({ nodeSortMode: "legacy", nodes: [...nodes.slice(2), ...nodes.slice(0, 2)] });
    expect(test.names()).toEqual(["B1", "B2", "A1", "A2"]);
    test.actions.enableSourceNodeSorting();
    expect(test.state().nodeSortMode).toBe("source");
    expect(test.names()).toEqual(["A1", "A2", "B1", "B2"]);
  });
});
