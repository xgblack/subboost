import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import { getNodeSourceIds, withoutNodeSourceIds } from "./node-source-state";
import { getNodeManualPosition, normalizeNodeOrderMetadata, setManualNodePosition, sortNodesBySource, withNodeManualPosition } from "./node-order";
import { mergeParsedSourceNodes, prepareSourceParsedNodes } from "./source-node-refresh";
import { buildGenerateOptionsFromConfig } from "./config-utils";
import { generateClashYaml } from "../generator";
import * as yaml from "js-yaml";

const sources = ["A", "B", "C"].map((id) => ({ id }));
const node = (name: string, extra: Record<string, unknown> = {}): ParsedNode => ({
  name, type: "ss", server: `${name}.example.test`, port: 443, cipher: "aes-128-gcm", password: "test", ...extra,
});
const base = () => sources.flatMap(({ id }) => [0, 1].map((index) => node(`${id}${index + 1}`, {
  _sourceIds: [id], _sourceOrder: { [id]: index }, _originName: `${id}${index + 1}`,
})));
const names = (nodes: ParsedNode[]) => nodes.map((node) => node.name);

describe("source node ordering", () => {
  it("reserves absolute node positions, refills source order, and restores inheritance", () => {
    let nodes = base();
    nodes = setManualNodePosition(nodes, sortNodesBySource(nodes, sources), "C2", 1);
    nodes = setManualNodePosition(nodes, sortNodesBySource(nodes, sources), "B2", 3);
    expect(names(sortNodesBySource(nodes, sources))).toEqual(["C2", "A1", "B2", "A2", "B1", "C1"]);
    const reorderedSources = [sources[1], sources[0], sources[2]];
    expect(names(sortNodesBySource(nodes, reorderedSources))).toEqual(["C2", "B1", "B2", "A1", "A2", "C1"]);
    nodes = setManualNodePosition(nodes, sortNodesBySource(nodes, reorderedSources), "C2", null);
    expect(names(sortNodesBySource(nodes, reorderedSources))).toEqual(["B1", "A1", "B2", "A2", "C1", "C2"]);
    expect(names(sortNodesBySource(nodes.map((node) => withNodeManualPosition(node)), reorderedSources)))
      .toEqual(["B1", "B2", "A1", "A2", "C1", "C2"]);
  });

  it("keeps requested positions through temporary shrinkage, ties, and huge targets", () => {
    const nodes = base().map((node, index) => withNodeManualPosition(node, index > 2 ? Number.MAX_SAFE_INTEGER : undefined));
    expect(names(sortNodesBySource(nodes, sources))).toEqual(names(base()));
    expect(names(sortNodesBySource([nodes[0], nodes[4], nodes[5]], sources))).toEqual(["A1", "C1", "C2"]);
    expect(getNodeManualPosition(nodes[4])).toBe(Number.MAX_SAFE_INTEGER);
    const tied = base().map((node, index) => withNodeManualPosition(node, index === 2 || index === 4 ? 1 : undefined));
    expect(names(sortNodesBySource(tied, sources))).toEqual(["B1", "C1", "A1", "A2", "B2", "C2"]);
  });

  it("commits moves when existing manual targets have been constrained", () => {
    const nodes = [0, 1, 2, 3, 4].map((i) => node(`N${i}`, { _manualPosition: [5, 11, undefined, undefined, 13][i] }));
    const effective = sortNodesBySource(nodes, []);
    expect(names(effective)).toEqual(["N2", "N3", "N0", "N1", "N4"]);
    const moved = setManualNodePosition(nodes, effective, "N1", 5);
    expect(names(sortNodesBySource(moved, []))).toEqual(["N2", "N3", "N0", "N4", "N1"]);
    expect(moved[2]._manualPosition).toBeUndefined();
  });

  it("establishes a pin at the current position, rejects invalid edits, and retains hidden settings", () => {
    const nodes = base();
    const samePosition = setManualNodePosition(nodes, nodes, "A1", 1);
    expect(getNodeManualPosition(samePosition[0])).toBe(1);
    for (const target of [0, -1, 1.5, NaN, Infinity, 7]) {
      expect(setManualNodePosition(nodes, nodes, "A1", target)).toBe(nodes);
    }
    const hidden = withNodeManualPosition(nodes[1], 5);
    const snapshot = [nodes[0], hidden, ...nodes.slice(2)];
    const visible = sortNodesBySource(snapshot.filter((node) => node !== hidden), sources);
    expect(setManualNodePosition(snapshot, visible, "C2", 1)[1]).toBe(hidden);
  });

  it("uses the earliest current source for shared nodes and prunes removed source ordinals", () => {
    const shared = node("Shared", { _sourceIds: ["A", "B"], _sourceOrder: { A: 1, B: 0 }, _manualPosition: 2 });
    const detached = withoutNodeSourceIds(shared, new Set(["A"]))!;
    expect(getNodeSourceIds(detached)).toEqual(["B"]);
    expect(detached._sourceOrder).toEqual({ B: 0 });
    expect(getNodeManualPosition(detached)).toBe(2);
    const inherited = withNodeManualPosition(shared);
    expect(names(sortNodesBySource([inherited, base()[0], base()[2]], [sources[1], sources[0]])))
      .toEqual(["Shared", "B1", "A1"]);
  });

  it("fills missing historical ordinals and discards malformed sorting metadata", () => {
    const snapshot = normalizeNodeOrderMetadata([
      node("Two", { _sourceIds: ["A"], _sourceOrder: { A: -1, removed: 5 }, _manualPosition: "2" }),
      node("One", { _sourceIds: ["A"], _manualPosition: 1.1 }),
    ]);
    expect(snapshot.map((node) => node._sourceOrder)).toEqual([{ A: 0 }, { A: 1 }]);
    expect(snapshot.every((node) => getNodeManualPosition(node) === undefined)).toBe(true);
    expect(names(sortNodesBySource(snapshot, sources, "legacy"))).toEqual(["Two", "One"]);
  });

  it("preserves local pins while replacing upstream ordinals and rejects injected pins", () => {
    const nodes = base().map((node) => node.name === "A2" ? withNodeManualPosition(node, 4) : node);
    const fresh = prepareSourceParsedNodes([node("A2", { _manualPosition: 1, _sourceOrder: { B: 99 }, _sourceIds: ["B"] }), node("A1")], { sourceId: "A" });
    expect(fresh[0]._manualPosition).toBeUndefined();
    expect(fresh[0]._sourceOrder).toEqual({ A: 0 });
    const refreshed = mergeParsedSourceNodes(nodes, fresh, [], { sourceId: "A" }).nodes;
    expect(refreshed.find((node) => node.name === "A2")).toMatchObject({ _manualPosition: 4, _sourceOrder: { A: 0 } });
    expect(names(sortNodesBySource(refreshed.map((node) => withNodeManualPosition(node)), sources)))
      .toEqual(["A2", "A1", "B1", "B2", "C1", "C2"]);
    const replaced = mergeParsedSourceNodes(nodes, fresh, [], { sourceId: "A", treatAsNewSource: true }).nodes;
    expect(replaced.find((node) => node.name === "A2")?._manualPosition).toBeUndefined();
  });

  it("matches same-name nodes by contents rather than stealing pins after an upstream reversal", () => {
    const stored = [1, 2].map((port) => node(`Same (${port})`, { port, _originName: "Same", _sourceIds: ["A"], _manualPosition: port }));
    const fresh = prepareSourceParsedNodes([node("Same", { port: 2, server: "same.example.test" }), node("Same", { port: 1, server: "same.example.test" })], {});
    const sameServers = stored.map((node) => ({ ...node, server: "same.example.test" }));
    const merged = mergeParsedSourceNodes(sameServers, fresh, [], { sourceId: "A" }).nodes;
    expect(merged.find((node) => node.port === 1)).toMatchObject({ _manualPosition: 1, _sourceOrder: { A: 1 } });
    expect(merged.find((node) => node.port === 2)).toMatchObject({ _manualPosition: 2, _sourceOrder: { A: 0 } });
    const ambiguous = mergeParsedSourceNodes(sameServers, fresh.map((node) => ({ ...node, password: "new" })), [], { sourceId: "A" }).nodes;
    expect(ambiguous.every((node) => node._manualPosition === undefined)).toBe(true);
  });

  it("reproduces visible splice operations for generated pin conflicts", () => {
    let seed = 12345;
    const random = (max: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
    for (let scenario = 0; scenario < 1000; scenario += 1) {
      const nodes = base().map((node) => withNodeManualPosition(node, random(3) ? random(20) + 1 : undefined));
      const before = sortNodesBySource(nodes, sources);
      const from = random(nodes.length);
      const to = random(nodes.length);
      const expected = before.slice();
      const [moved] = expected.splice(from, 1);
      expected.splice(to, 0, moved);
      expect(names(sortNodesBySource(setManualNodePosition(nodes, before, moved.name, to + 1), sources))).toEqual(names(expected));
    }
  });

  it("applies filtering before global positions and preserves group overrides without leaking metadata", () => {
    const nodes = base().map((node) => node.name === "C2" ? withNodeManualPosition(node, 2) : node);
    const config = {
      nodeSortMode: "source", sources, enabledGroups: ["select"],
      nodeNameFilter: { enabled: true, excludeRegexes: ["^A1$"] },
      customProxyGroups: [{ id: "b", name: "B group", type: "select", sourceIds: ["B"] }],
      proxyGroupAdvanced: { select: { memberOrder: [{ kind: "node", name: "B2" }, { kind: "node", name: "A2" }] } },
    };
    const options = buildGenerateOptionsFromConfig(config, { nodes });
    expect(names(options.nodes)).toEqual(["A2", "C2", "B1", "B2", "C1"]);
    const text = generateClashYaml(options);
    expect(text).not.toMatch(/_manualPosition|_sourceOrder|_sourceIds/);
    const output = yaml.load(text) as { proxies: ParsedNode[]; "proxy-groups": { name: string; proxies: string[] }[] };
    expect(names(output.proxies)).toEqual(names(options.nodes));
    const group = output["proxy-groups"].find((group) => group.name === "🚀 节点选择")!;
    expect(group.proxies.indexOf("B2")).toBeLessThan(group.proxies.indexOf("A2"));
    expect(names(buildGenerateOptionsFromConfig({ ...config, nodeSortMode: undefined, nodeNameFilter: { enabled: false, excludeRegexes: [] } }, { nodes }).nodes)).toEqual(names(nodes));
  });
});
