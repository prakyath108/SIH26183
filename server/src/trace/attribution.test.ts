import { describe, it, expect } from "vitest";
import { attributeFunds } from "./attribution.js";
import type { GraphEdge, GraphNode, TraceMethod } from "../types.js";

const ROOT = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
/** Stands in for a validator: the destination of an observed fee leg. */
const FEE_SINK = "0x5555555555555555555555555555555555555555";

function node(id: string, hopDistance: number): GraphNode {
  return {
    id,
    address: id,
    chain: "ethereum",
    kind: "address",
    riskScore: 0,
    riskLevel: "Unrated",
    txCount: 0,
    hopDistance
  };
}

let edgeSeq = 0;

function edge(o: Partial<GraphEdge> & { source: string; target: string; hop: number }): GraphEdge {
  edgeSeq += 1;
  return {
    id: `e${edgeSeq}`,
    txHash: `0xtx${edgeSeq}`,
    timestamp: `2024-01-0${Math.min(o.hop + 1, 9)}T00:00:00Z`,
    valueNative: "0",
    valueUsd: null,
    status: "confirmed",
    asset: "ETH",
    observedAmount: "0",
    tracedAmount: null,
    relationship: "direct_transfer",
    evidenceStatus: "confirmed",
    traceMethod: null,
    confidence: 1,
    evidenceSource: "on_chain",
    blockNumber: null,
    reasons: [],
    ...o
  };
}

function run(
  edges: GraphEdge[],
  nodes: GraphNode[],
  amountToTrace: string | null,
  method: TraceMethod = "pro_rata"
) {
  return attributeFunds({
    root: ROOT,
    chain: "ethereum",
    nodes,
    edges,
    amountToTrace,
    asset: "ETH",
    method,
    direction: "forward",
    maxHops: 3,
    demo: false
  });
}

describe("attributeFunds", () => {
  it("follows a clean pass-through and reconciles exactly", () => {
    const edges = [edge({ source: ROOT, target: B, hop: 0, observedAmount: "10" })];
    const { reconciliation: r, edges: out } = run(edges, [node(ROOT, 0), node(B, 1)], "10");

    expect(out[0]?.tracedAmount).toBe("10");
    expect(out[0]?.evidenceStatus).toBe("confirmed");
    expect(r?.directlyObserved).toBe("10");
    expect(r?.unresolved).toBe("0");
    expect(r?.coverage).toBeCloseTo(1, 6);
    expect(r?.status).toBe("reconciled");
  });

  // This is the case the previous accounting got wrong: the same 10 ETH was
  // counted on every hop it survived, reporting 250% coverage.
  it("counts a surviving lineage once, not once per hop", () => {
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "10" }),
      edge({ source: B, target: C, hop: 1, observedAmount: "5" }),
      edge({ source: B, target: D, hop: 1, observedAmount: "5" })
    ];
    const nodes = [node(ROOT, 0), node(B, 1), node(C, 2), node(D, 2)];
    const { reconciliation: r } = run(edges, nodes, "10");

    // Conservation: nothing is double counted and nothing is invented.
    const total =
      Number(r?.directlyObserved) + Number(r?.attributed) + Number(r?.unresolved);
    expect(total).toBeCloseTo(10, 6);
    expect(r?.coverage).toBeCloseTo(1, 6);
    expect(r?.unresolved).toBe("0");
  });

  it("never reports coverage above 100%", () => {
    // A quantity that fans out across many hops is the shape most likely to
    // inflate the totals if the engine double counts.
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "10" }),
      edge({ source: B, target: C, hop: 1, observedAmount: "4" }),
      edge({ source: B, target: D, hop: 1, observedAmount: "6" }),
      edge({ source: C, target: D, hop: 2, observedAmount: "4" })
    ];
    const nodes = [node(ROOT, 0), node(B, 1), node(C, 2), node(D, 2)];
    const { reconciliation: r } = run(edges, nodes, "10");

    expect(r!.coverage!).toBeLessThanOrEqual(1);
    const total =
      Number(r?.directlyObserved) + Number(r?.attributed) + Number(r?.unresolved);
    expect(total).toBeCloseTo(10, 6);
  });

  it("splits pro-rata and conserves the total", () => {
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "3" }),
      edge({ source: ROOT, target: C, hop: 0, observedAmount: "7" })
    ];
    const { reconciliation: r, edges: out } = run(
      edges,
      [node(ROOT, 0), node(B, 1), node(C, 1)],
      "10"
    );

    expect(Number(out[0]?.tracedAmount)).toBeCloseTo(3, 6);
    expect(Number(out[1]?.tracedAmount)).toBeCloseTo(7, 6);
    expect(r?.coverage).toBeCloseTo(1, 6);
    expect(r?.status).toBe("reconciled");
  });

  it("reports unresolved rather than inventing a destination", () => {
    // Only 6 of the nominated 10 is ever seen moving.
    const edges = [edge({ source: ROOT, target: B, hop: 0, observedAmount: "6" })];
    const { reconciliation: r } = run(edges, [node(ROOT, 0), node(B, 1)], "10");

    expect(r?.unresolved).toBe("4");
    expect(r?.coverage).toBeCloseTo(0.6, 6);
    expect(r?.status).toBe("partial");
    expect(r?.caveats.join(" ")).toMatch(/unresolved/i);
  });

  it("excludes change, fees and contract calls from carrying funds", () => {
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "7" }),
      edge({ source: ROOT, target: C, hop: 0, observedAmount: "0.9", relationship: "change_output" }),
      edge({ source: ROOT, target: D, hop: 0, observedAmount: "0.1", relationship: "fee" })
    ];
    const { edges: out, reconciliation: r } = run(
      edges,
      [node(ROOT, 0), node(B, 1), node(C, 1), node(D, 1)],
      "10"
    );

    expect(out[1]?.tracedAmount).toBe("0");
    expect(out[2]?.tracedAmount).toBe("0");
    expect(out[1]?.evidenceStatus).not.toBe("confirmed");
    // The full 10 still has to be accounted for: 7 moved, 1 provably went to
    // fees and change, and only the 2 ETH residue is genuinely unaccounted.
    expect(Number(r?.directlyObserved) + Number(r?.attributed) + Number(r?.explainedOutflow) + Number(r?.unresolved)).toBeCloseTo(10, 6);
    expect(Number(r?.explainedOutflow)).toBeCloseTo(1, 6);
    expect(Number(r?.unresolved)).toBeCloseTo(2, 6);
    expect(r?.caveats.join(" ")).toMatch(/fees or change/i);
  });

  it("accounts for fees rather than reporting them as missing funds", () => {
    // Every hop on a fee-paying chain pays gas. A trace that reconciles must not
    // show that gas as unresolved, or a correct trace looks like a loss.
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "4.9" }),
      edge({ source: ROOT, target: FEE_SINK, hop: 0, observedAmount: "0.1", relationship: "fee" })
    ];
    const { reconciliation: r } = run(
      edges,
      [node(ROOT, 0), node(B, 1), node(FEE_SINK, 1)],
      "5"
    );

    expect(Number(r?.directlyObserved) + Number(r?.attributed)).toBeCloseTo(4.9, 6);
    expect(Number(r?.explainedOutflow)).toBeCloseTo(0.1, 6);
    expect(Number(r?.unresolved)).toBe(0);
    expect(Number(r?.coverage)).toBeCloseTo(1, 6);
    expect(r?.status).toBe("reconciled");
  });

  it("reports the residue beyond observed fees as unresolved", () => {
    // A 0.1 fee cannot explain a 3 ETH shortfall, so claiming it reconciled
    // would be as wrong as the bug this replaced.
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "7" }),
      edge({ source: ROOT, target: FEE_SINK, hop: 0, observedAmount: "0.1", relationship: "fee" })
    ];
    const { reconciliation: r } = run(
      edges,
      [node(ROOT, 0), node(B, 1), node(FEE_SINK, 1)],
      "10"
    );

    expect(Number(r?.explainedOutflow)).toBeCloseTo(0.1, 6);
    expect(Number(r?.unresolved)).toBeCloseTo(2.9, 6);
    expect(r?.status).toBe("partial");
  });

  it("never places traced funds on an unevidenced association", () => {
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "5" }),
      edge({
        source: B,
        target: C,
        hop: 1,
        observedAmount: "1.2",
        relationship: "possible_association",
        evidenceStatus: "inferred",
        confidence: 0.72
      })
    ];
    const { edges: out, reconciliation: r } = run(
      edges,
      [node(ROOT, 0), node(B, 1), node(C, 2)],
      "5"
    );

    // The association is shown, but it moves nothing: we cannot evidence that
    // these addresses are controlled by the same party.
    const association = out.find((e) => e.relationship === "possible_association");
    expect(association?.tracedAmount).toBe("0");
    expect(association?.evidenceStatus).toBe("inferred");
    expect(association?.confidence).toBeCloseTo(0.72, 6);
    // And it must not be mistaken for a loss either.
    expect(Number(r?.unresolved)).toBe(0);
    expect(r?.status).toBe("reconciled");
  });

  it("direct tracing refuses to guess when funds were split", () => {
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "5" }),
      edge({ source: ROOT, target: C, hop: 0, observedAmount: "5" })
    ];
    const { edges: out, reconciliation: r } = run(
      edges,
      [node(ROOT, 0), node(B, 1), node(C, 1)],
      "10",
      "direct"
    );

    expect(out[0]?.tracedAmount).toBe("0");
    expect(out[1]?.tracedAmount).toBe("0");
    expect(r?.unresolved).toBe("10");
    expect(r?.caveats.join(" ")).toMatch(/inconclusive/i);
  });

  it("fifo consumes oldest outputs first", () => {
    const older = edge({ source: ROOT, target: B, hop: 0, observedAmount: "4", timestamp: "2024-01-01T00:00:00Z" });
    const newer = edge({ source: ROOT, target: C, hop: 0, observedAmount: "9", timestamp: "2024-06-01T00:00:00Z" });
    const { edges: out, reconciliation: r } = run(
      [older, newer],
      [node(ROOT, 0), node(B, 1), node(C, 1)],
      "10",
      "fifo"
    );

    expect(out[0]?.tracedAmount).toBe("4");
    expect(out[1]?.tracedAmount).toBe("6");
    expect(r?.coverage).toBeCloseTo(1, 6);
  });

  it("marks derived input/output pairings as derived, not confirmed", () => {
    const edges = [edge({ source: ROOT, target: B, hop: 0, observedAmount: "10", evidenceStatus: "derived" })];
    const { edges: out } = run(edges, [node(ROOT, 0), node(B, 1)], "10");

    expect(out[0]?.evidenceStatus).toBe("derived");
    expect(out[0]?.reasons.some((x) => x.weight === "qualifies")).toBe(true);
  });

  it("gives every edge a stated reason", () => {
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "10" }),
      edge({ source: B, target: C, hop: 1, observedAmount: "10" })
    ];
    const { edges: out } = run(edges, [node(ROOT, 0), node(B, 1), node(C, 2)], "10");

    for (const e of out) {
      expect(e.reasons.length).toBeGreaterThan(0);
      expect(e.reasons.every((x) => typeof x.detail === "string" && x.detail.length > 0)).toBe(true);
    }
  });

  it("conserves the total exactly despite fixed-point truncation", () => {
    // 3 / (3 + 1.2) is not representable in 18 decimal places, so the shares
    // fall 1 wei short. The remainder has to land on an output rather than be
    // reported as unresolved, which would mislabel a clean trace as lossy.
    const edges = [
      edge({ source: ROOT, target: B, hop: 0, observedAmount: "3" }),
      edge({ source: ROOT, target: C, hop: 0, observedAmount: "1.2" })
    ];
    const { edges: out, reconciliation: r } = run(
      edges,
      [node(ROOT, 0), node(B, 1), node(C, 1)],
      "3"
    );

    const placed = out.reduce((s, e) => s + Number(e.tracedAmount ?? 0), 0);
    expect(placed).toBeCloseTo(3, 12);
    expect(Number(r?.unresolved)).toBe(0);
    expect(r?.status).toBe("reconciled");
  });

  it("treats a null quantity as trace-everything and does not claim coverage", () => {
    const edges = [edge({ source: ROOT, target: B, hop: 0, observedAmount: "10" })];
    const { reconciliation: r, edges: out } = run(edges, [node(ROOT, 0), node(B, 1)], null);

    expect(r?.status).toBe("not_applicable");
    expect(r?.coverage).toBeNull();
    expect(r?.initialAmount).toBeNull();
    // The observed movement is still shown.
    expect(out[0]?.observedAmount).toBe("10");
  });
});
