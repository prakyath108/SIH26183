import { describe, it, expect } from "vitest";
import { buildDemoGraph, listDemoCases } from "./demoCases.js";

describe("demo cases", () => {
  it("lists every case with the fields the picker needs", () => {
    const cases = listDemoCases();
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.teaches).toBeTruthy();
      expect(Number(c.amount)).toBeGreaterThan(0);
      expect(c.suggestedMethod).toBeTruthy();
    }
  });

  it("builds a graph for every listed case", () => {
    for (const c of listDemoCases()) {
      const graph = buildDemoGraph(c.id);
      expect(graph, `case ${c.id} should build`).not.toBeNull();
      expect(graph?.nodes.length).toBeGreaterThan(1);
      expect(graph?.edges.length).toBeGreaterThan(0);
    }
  });

  it("marks every demo address as unmistakably synthetic", () => {
    for (const c of listDemoCases()) {
      const graph = buildDemoGraph(c.id)!;
      for (const n of graph.nodes) {
        expect(n.address.startsWith("0xdead")).toBe(true);
      }
      for (const e of graph.edges) {
        expect(e.evidenceSource).toBe("demo");
      }
    }
  });

  it("flags the graph as demo data in a visible note", () => {
    const graph = buildDemoGraph("clean-pass-through")!;
    expect(graph.demo).toBe(true);
    expect(graph.demoCaseId).toBe("clean-pass-through");
    expect(graph.notes?.join(" ")).toMatch(/SIMULATED/i);
  });

  // The catalogue tells the investigator what to expect before opening the case.
  // If the engine disagrees, the product is advertising a result it cannot
  // produce, so the advertised outcome is asserted here rather than trusted.
  it("produces the outcome each case advertises", () => {
    const expectations: Record<string, string> = {
      "clean-pass-through": "reconciled",
      "split-with-loss": "partial",
      "non-transfer-noise": "reconciled",
      "derived-pairing": "reconciled"
    };

    for (const [id, status] of Object.entries(expectations)) {
      const graph = buildDemoGraph(id)!;
      expect(graph.reconciliation?.status, `case ${id}`).toBe(status);
    }
  });

  it("conserves the nominated quantity in every conserving case", () => {
    for (const c of listDemoCases()) {
      // Poison is excluded by design: it deliberately over-attributes, which is
      // the behaviour it exists to demonstrate. Its bound is asserted separately.
      if (c.suggestedMethod === "poison") continue;
      const graph = buildDemoGraph(c.id)!;
      const r = graph.reconciliation!;
      // Gas is part of the conservation identity. A trace that pays a fee at
      // every hop has still accounted for the whole quantity; leaving fees out
      // would make every fee-paying chain look like it lost money.
      const total =
        Number(r.directlyObserved) +
        Number(r.attributed) +
        Number(r.explainedOutflow) +
        Number(r.unresolved);
      expect(total, `case ${c.id} must account for the full quantity`).toBeCloseTo(Number(c.amount), 6);
      expect(Number(r.coverage ?? 0), `case ${c.id} must not over-attribute`).toBeLessThanOrEqual(1);
    }
  });

  it("over-attributes under poison, and says so", () => {
    const graph = buildDemoGraph("poison-pill")!;
    const r = graph.reconciliation!;
    expect(Number(r.coverage ?? 0)).toBeGreaterThan(1);
    expect(r.caveats.join(" ")).toMatch(/over-inclusive/i);
  });

  it("reports the unattributable remainder rather than hiding it", () => {
    const graph = buildDemoGraph("split-with-loss")!;
    const r = graph.reconciliation!;
    expect(Number(r.unresolved)).toBeGreaterThan(0);
    expect(Number(r.coverage ?? 0)).toBeLessThan(1);
  });

  it("excludes change, fees and contract calls from carrying the quantity", () => {
    const graph = buildDemoGraph("non-transfer-noise")!;
    const nonCarrying = graph.edges.filter((e) =>
      ["change_output", "fee", "contract_interaction"].includes(e.relationship)
    );
    expect(nonCarrying.length).toBe(3);
    for (const e of nonCarrying) {
      expect(Number(e.tracedAmount ?? 0)).toBe(0);
      expect(e.evidenceStatus).toBe("excluded");
      expect(e.reasons.length).toBeGreaterThan(0);
    }
  });

  it("keeps derived pairings from being promoted to confirmed", () => {
    const graph = buildDemoGraph("derived-pairing")!;
    for (const e of graph.edges) {
      expect(e.evidenceStatus).not.toBe("confirmed");
      expect(e.reasons.some((x) => x.weight === "qualifies")).toBe(true);
    }
  });

  it("returns null for an unknown case instead of throwing", () => {
    expect(buildDemoGraph("does-not-exist")).toBeNull();
  });

  it("follows only one output when a method override demands it", () => {
    const asDirect = buildDemoGraph("poison-pill", "direct")!;
    expect(asDirect.method).toBe("direct");

    // Direct follows a single qualifying output at each hop rather than fanning
    // out across the split.
    const placedAtSplit = asDirect.edges.filter(
      (e) => e.hop === 1 && Number(e.tracedAmount ?? 0) > 0
    );
    expect(placedAtSplit.length).toBe(1);
    expect(Number(placedAtSplit[0]?.tracedAmount)).toBeCloseTo(10, 6);
    // Only 10 of that output's 60 is claimed, so the edge stays attributed
    // rather than being presented as a confirmed 60-unit transfer.
    expect(placedAtSplit[0]?.evidenceStatus).toBe("attributed");
  });

  describe("CT-SIM-001 fund diversion", () => {
    const graph = buildDemoGraph("fund-splitting")!;
    const byWallet = (label: string) => graph.nodes.find((n) => n.label === label);
    const leg = (from: string, to: string) =>
      graph.edges.find((e) => byWallet(from)?.id === e.source && byWallet(to)?.id === e.target);

    it("is advertised as the headline case with a judge-facing reference", () => {
      const summary = listDemoCases().find((c) => c.id === "fund-splitting")!;
      expect(summary.caseRef).toBe("CT-SIM-001");
      expect(summary.headline).toBe(true);
      expect(summary.maxHops).toBe(8);
      expect(summary.amount).toBe("5");
      expect(summary.asset).toBe("ETH");
    });

    it("reconciles the full 5 ETH with nothing unresolved", () => {
      const r = graph.reconciliation!;
      expect(r.status).toBe("reconciled");
      expect(Number(r.unresolved)).toBe(0);
      expect(Number(r.coverage)).toBe(1);
      // 0.10 + 0.01 + 0.10 of gas across three hops.
      expect(Number(r.explainedOutflow)).toBeCloseTo(0.21, 9);
    });

    it("derives the split from the ledger rather than from hand-set hops", () => {
      // Root -> scam -> two branches, and the branch that reaches the exchange
      // is one hop further on. Hop distances are computed, so the exchange has
      // to land past the wallet that funded it.
      expect(byWallet("Victim Wallet")?.hopDistance).toBe(0);
      expect(byWallet("Scam Wallet (Wallet A)")?.hopDistance).toBe(1);
      expect(byWallet("Intermediate Wallet A (Wallet B)")?.hopDistance).toBe(2);
      expect(byWallet("Intermediate Wallet B (Wallet D)")?.hopDistance).toBe(2);
      expect(byWallet("Intermediate Wallet C (Wallet C)")?.hopDistance).toBe(3);
      expect(byWallet("Simulated Exchange Deposit Address")?.hopDistance).toBe(4);
    });

    it("records the fee legs as observed outflows rather than lost funds", () => {
      const fees = graph.edges.filter((e) => e.relationship === "fee");
      expect(fees.length).toBe(3);
      for (const e of fees) {
        expect(Number(e.tracedAmount ?? 0)).toBe(0);
        expect(e.evidenceStatus).toBe("excluded");
      }
      // Each branch's outputs plus its gas equal what arrived, which is the
      // property that makes this case worth demonstrating.
      expect(Number(leg("Intermediate Wallet A (Wallet B)", "Intermediate Wallet C (Wallet C)")?.observedAmount)).toBe(2.74);
      expect(Number(leg("Intermediate Wallet A (Wallet B)", "Simulated Exchange Deposit Address")?.observedAmount)).toBe(0.35);
      expect(fees.map((e) => Number(e.observedAmount)).sort((a, b) => a - b)).toEqual([0.01, 0.1, 0.1]);
    });

    it("shows the suspected link as inferred, unquantified and unreasoned away", () => {
      const association = graph.edges.find((e) => e.relationship === "possible_association")!;
      expect(association).toBeTruthy();
      expect(association.evidenceStatus).toBe("inferred");
      expect(association.confidence).toBeCloseTo(0.72, 9);
      // The critical assertion: an observed 1.20 that carries no traced funds
      // must not be presented as a movement of the investigated quantity.
      expect(Number(association.tracedAmount ?? 0)).toBe(0);
      expect(association.observedAmount).toBe("1.2");
      expect(association.reasons.length).toBeGreaterThanOrEqual(4);
      expect(association.reasons.some((r) => r.weight === "qualifies")).toBe(true);
      // The destination of an unevidenced link holds none of the quantity.
      expect(Number(byWallet("Unconfirmed Counterparty")?.tracedAmount ?? 0)).toBe(0);
    });

    it("tells an investigator which wallet carries the most risk", () => {
      // The root is the victim, so grading the graph by the root would headline
      // a low-risk wallet.
      expect(graph.riskLevel).toBe("High");
      expect(byWallet("Victim Wallet")?.riskLevel).toBe("Low");
      expect(Number(graph.riskScore)).toBe(87);
    });

    it("re-traces an investigator-supplied quantity instead of the authored one", () => {
      const custom = buildDemoGraph("fund-splitting", "pro_rata", "2.5")!;
      expect(custom.amountToTrace).toBe("2.5");
      const r = custom.reconciliation!;
      expect(r.initialAmount).toBe("2.5");
      const total =
        Number(r.directlyObserved) + Number(r.attributed) + Number(r.explainedOutflow) + Number(r.unresolved);
      expect(total).toBeCloseTo(2.5, 6);
    });

    it("rejects a malformed quantity rather than silently tracing the default", () => {
      expect(() => buildDemoGraph("fund-splitting", "pro_rata", "5 ETH")).toThrow(/amount/i);
    });
  });

  it("stops a cross-ledger leg without converting the quantity", () => {
    const graph = buildDemoGraph("cross-chain")!;
    const bridge = graph.edges.find((e) => e.relationship === "cross_chain_link")!;
    expect(bridge.evidenceStatus).toBe("inferred");
    expect(Number(bridge.tracedAmount ?? 0)).toBe(0);
    // The ETH quantity is never placed on the BTC leg, so the trace still
    // balances against the ETH that actually left the source chain.
    const r = graph.reconciliation!;
    expect(Number(r.unresolved)).toBe(0);
    expect(Number(r.coverage)).toBe(1);
    expect(r.caveats.join(" ")).toMatch(/chain/i);
  });
});
