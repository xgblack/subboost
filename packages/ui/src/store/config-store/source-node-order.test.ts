import { beforeEach, describe, expect, it } from "vitest";
import { sortNodesBySource } from "@subboost/core/subscription/node-order";
import type { ParsedNode } from "@subboost/core/types/node";
import { createHarness, getSourceActionMocks, node, parseResult, resetSourceActionMocks, source } from "./source-actions.test-utils";

const mocks = getSourceActionMocks();
beforeEach(resetSourceActionMocks);

function snapshot(id: string): ParsedNode[] {
  return [1, 2].map((n) => node(`${id}${n}`, { _originName: `${id}${n}`, _sourceIds: [id], _sourceOrder: { [id]: n - 1 } }));
}

describe("source ordering through batch import", () => {
  it("retains pins and failed source snapshots while replacing successful source ordinals", async () => {
    const sources = ["A", "B", "C"].map((id) => source({ id, type: "url", content: `https://${id.toLowerCase()}.example.test/sub` }));
    const nodes = sources.flatMap(({ id }) => snapshot(id));
    nodes[1]._manualPosition = 1;
    const { actions, getState } = createHarness({ sources, nodes });
    mocks.fetchUrlContentInBrowser
      .mockResolvedValueOnce({ content: "A", headers: {}, parseResult: parseResult([node("A2"), node("A1")]) })
      .mockRejectedValueOnce(new Error("source B unavailable"))
      .mockResolvedValueOnce({ content: "C", headers: {}, parseResult: parseResult([node("C1"), node("C2", { _manualPosition: 1 })]) });

    await actions.parseMultipleSources(sources);

    const state = getState();
    expect(sortNodesBySource(state.nodes, state.sources).map((node) => node.name))
      .toEqual(["A2", "A1", "B1", "B2", "C1", "C2"]);
    expect(state.nodes.find((node: ParsedNode) => node.name === "A2")).toMatchObject({ _manualPosition: 1, _sourceOrder: { A: 0 } });
    expect(state.nodes.filter((node: ParsedNode) => node.name.startsWith("B"))).toEqual(snapshot("B"));
    expect(state.nodes.find((node: ParsedNode) => node.name === "C2")._manualPosition).toBeUndefined();
    expect(state.sources.find((source: { id: string }) => source.id === "B").parsed).toBe(false);
  });

  it("keeps both source ordinals for a shared node when sources are reordered", async () => {
    const sources = ["A", "B"].map((id) => source({ id, content: id }));
    mocks.parseSubscription
      .mockReturnValueOnce(parseResult([node("A1"), node("Shared")]))
      .mockReturnValueOnce(parseResult([node("Shared"), node("B1")]));
    const { actions, getState } = createHarness({ sources });
    await actions.parseMultipleSources(sources);
    expect(getState().nodes.find((node: ParsedNode) => node.name === "Shared"))
      .toMatchObject({ _sourceIds: ["A", "B"], _sourceOrder: { A: 1, B: 0 } });
    actions.setSources([sources[1], sources[0]]);
    expect(sortNodesBySource(getState().nodes, getState().sources).map((node) => node.name))
      .toEqual(["Shared", "B1", "A1"]);
  });
});
