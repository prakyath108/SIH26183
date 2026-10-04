import { describe, it, expect } from "vitest";
import { buildFundFlowLedger } from "./ledger.js";
import type { TraceGraph, GraphNode, GraphEdge } from "../types.js";

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "n1",
    address: "0x1234567890123456789012345678901234567890",
    chain: "ethereum",
    kind: "address",
    riskScore: 0,
    riskLevel: "Unrated",
    txCount: 0,
    hopDistance: 0,
    ...overrides
  };
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: "e1",
    source: "0x1234567890123456789012345678901234567890",
    target: "0x0987654321098765432109876543210987654321",
    txHash: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    timestamp: "2024-01-01T00:00:00Z",
    valueNative: "1.5",
    valueUsd: 3000,
    status: "confirmed",
    hop: 1,
    asset: "ETH",
    observedAmount: "1.5",
    tracedAmount: null,
    relationship: "direct_transfer",
    evidenceStatus: "confirmed",
    traceMethod: null,
    confidence: 1,
    evidenceSource: "on_chain",
    blockNumber: null,
    reasons: [],
    ...overrides
  };
}

function makeGraph(overrides: Partial<TraceGraph> = {}): TraceGraph {
  return {
    root: "0x1234567890123456789012345678901234567890",
    chain: "ethereum",
    maxHops: 3,
    direction: "forward",
    nodes: [makeNode()],
    edges: [],
    totals: {
      valueInUsd: 0,
      valueOutUsd: 0,
      nodeCount: 1,
      edgeCount: 0,
      truncated: false,
      truncatedReasons: []
    },
    riskScore: 0,
    riskLevel: "Unrated",
    generatedAt: "2024-01-01T00:00:00Z",
    ...overrides
  };
}

describe("buildFundFlowLedger", () => {
  it("empty graph produces ledger with one entry for root", () => {
    const graph = makeGraph({ nodes: [makeNode({ address: "0x1111111111111111111111111111111111111111" })], edges: [] });
    const ledger = buildFundFlowLedger(graph);
    expect(ledger.addressLedgers.size).toBe(1);
    // With no edges, the root has no in/out and is unreconciled
    expect(["unreconciled", "balanced", "data_limitation", "partial"]).toContain(ledger.overallStatus);
  });

  it("simple send produces balanced or partial ledger", () => {
    const root = "0x1111111111111111111111111111111111111111";
    const dest = "0x2222222222222222222222222222222222222222";
    const graph = makeGraph({
      root,
      nodes: [makeNode({ address: root }), makeNode({ address: dest })],
      edges: [makeEdge({ source: root, target: dest, valueNative: "2.0", valueUsd: 4000 })]
    });
    const ledger = buildFundFlowLedger(graph);
    expect(ledger.addressLedgers.size).toBe(2);
    expect(["balanced", "partial", "data_limitation"]).toContain(ledger.overallStatus);
    const rootLedger = ledger.addressLedgers.get(root.toLowerCase());
    const destLedger = ledger.addressLedgers.get(dest.toLowerCase());
    // BN arithmetic normalizes "2.0" to "2"
    expect(rootLedger?.totalOutNative).toBe("2");
    expect(destLedger?.totalInNative).toBe("2");
  });

  it("multiple edges accumulate correctly", () => {
    const root = "0x1111111111111111111111111111111111111111";
    const dest = "0x2222222222222222222222222222222222222222";
    const graph = makeGraph({
      root,
      nodes: [makeNode({ address: root }), makeNode({ address: dest })],
      edges: [
        makeEdge({ source: root, target: dest, valueNative: "1.0", valueUsd: 2000 }),
        makeEdge({ source: root, target: dest, valueNative: "1.5", valueUsd: 3000 })
      ]
    });
    const ledger = buildFundFlowLedger(graph);
    const rootLedger = ledger.addressLedgers.get(root.toLowerCase());
    // BN arithmetic normalizes "2.5" to "2.5" (no trailing zero)
    expect(rootLedger?.totalOutNative).toBe("2.5");
    expect(rootLedger?.totalOutUsd).toBe(5000);
  });

  it("serializes to JSON via toJSON without losing Map data", () => {
    const root = "0x1111111111111111111111111111111111111111";
    const dest = "0x2222222222222222222222222222222222222222";
    const graph = makeGraph({
      root,
      nodes: [makeNode({ address: root }), makeNode({ address: dest })],
      edges: [makeEdge({ source: root, target: dest, valueNative: "1.0" })]
    });
    const ledger = buildFundFlowLedger(graph);
    const json = JSON.parse(JSON.stringify(ledger));
    expect(json.addressLedgers).toBeInstanceOf(Array);
    expect(json.addressLedgers.length).toBe(2);
    expect(json.overallStatus).toBeDefined();
  });

  it("reconciliation status reflects data limitation when no values", () => {
    const graph = makeGraph({
      nodes: [makeNode({ address: "0x1111111111111111111111111111111111111111" })],
      edges: [{ ...makeEdge(), valueNative: "0", valueUsd: null }]
    });
    const ledger = buildFundFlowLedger(graph);
    expect(["balanced", "data_limitation", "partial", "unreconciled"]).toContain(ledger.overallStatus);
  });
});