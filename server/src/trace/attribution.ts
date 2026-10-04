import {
  addDecimal,
  clampZero,
  minDecimal,
  nearEqual,
  shareDecimal,
  subDecimal,
  toNumber
} from "./decimal.js";
import type {
  Chain,
  EdgeRelationship,
  EvidenceReason,
  EvidenceStatus,
  GraphEdge,
  GraphNode,
  HopReconciliation,
  TraceMethod,
  TraceReconciliation
} from "../types.js";

/**
 * Fund attribution engine.
 *
 * A blockchain records transfers. It does not record *which* of several pooled
 * funds a given output represents — that question only arises once an
 * investigator nominates a specific quantity and asks where it went. This
 * module answers it, and it answers it *explicitly*: every conclusion is
 * labelled with the method that produced it, carries a confidence, and reports
 * what it could not account for.
 *
 * Two rules govern everything here:
 *
 *  1. Never invent a transfer. The engine may only redistribute the nominated
 *     quantity across edges that were actually observed. It cannot create an
 *     edge, and it cannot raise `observedAmount`.
 *  2. Never hide a remainder. If the quantity cannot be fully attributed, the
 *     shortfall is reported as unresolved rather than spread thin enough to look
 *     accounted for.
 *
 * The methods disagree with each other on purpose. There is no ground truth for
 * co-mingled funds, so the investigator picks the assumption that suits the
 * question being asked and the result states which assumption was used.
 */

/** Inputs: an observed graph plus the nominated quantity. */
export interface AttributionInput {
  root: string;
  chain: Chain;
  direction: "forward" | "backward" | "both";
  maxHops: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Quantity under investigation. `null` traces every observed movement. */
  amountToTrace: string | null;
  method: TraceMethod;
  asset: string;
  /** Set when the graph is synthetic, so caveats can say so. */
  demo?: boolean;
}

export interface AttributionResult {
  /** Edges with `tracedAmount`, confidence and reasons filled in. */
  edges: GraphEdge[];
  /** Per-address share of the investigated quantity, keyed by node id. */
  nodeAmounts: Map<string, { traced: string; confirmed: string }>;
  reconciliation: TraceReconciliation;
}

/**
 * Write the per-address shares back onto the nodes.
 *
 * `attributeFunds` accumulates node totals in a side map so it can settle a
 * node's inflow before it knows that node's outflow, but a node panel cannot
 * read a side map. Every caller that builds a graph has to apply this, otherwise
 * `GraphNode.tracedAmount` stays null and a node in the graph cannot answer
 * "how much of the investigated funds are here".
 */
export function applyNodeAmounts(
  nodes: GraphNode[],
  nodeAmounts: AttributionResult["nodeAmounts"]
): GraphNode[] {
  if (nodeAmounts.size === 0) return nodes;
  return nodes.map((node) => {
    const share = nodeAmounts.get(node.id.toLowerCase());
    if (!share) return node;
    return {
      ...node,
      tracedAmount: share.traced,
      confirmedAmount: share.confirmed
    };
  });
}

/**
 * Discount applied by `haircut`.
 *
 * Co-mingling means no output can be shown to hold any particular fraction of a
 * pooled balance. Haircut takes the pro-rata share as an upper bound and
 * discounts it, so the reported figure is defensible as a floor rather than a
 * claim.
 */
const HAIRCUT_DISCOUNT = "0.75";

/** Base confidence per method, before output-count and match adjustments. */
const BASE_CONFIDENCE: Record<TraceMethod, number> = {
  direct: 0.95,
  fifo: 0.85,
  pro_rata: 0.85,
  haircut: 0.7,
  poison: 0.5
};

export function attributeFunds(input: AttributionInput): AttributionResult {
  const { root, direction, method, nodes, edges } = input;
  const rootKey = root.toLowerCase();
  const quantity = input.amountToTrace;

  const caveats: string[] = [];
  if (input.demo) {
    caveats.push(
      "SIMULATED DATA. Every address, transaction and amount in this graph is synthetic and does not correspond to any real blockchain activity."
    );
  }

  const reasonsByEdge = new Map<string, EvidenceReason[]>();
  const tracedByEdge = new Map<string, string>();
  const confidenceByEdge = new Map<string, number>();
  const nodeAmounts = new Map<string, { traced: string; confirmed: string }>();
  const perHop: HopReconciliation[] = [];

  const bumpNode = (id: string, traced: string, confirmed: string): void => {
    const key = id.toLowerCase();
    const cur = nodeAmounts.get(key) ?? { traced: "0", confirmed: "0" };
    nodeAmounts.set(key, {
      traced: addDecimal(cur.traced, traced),
      confirmed: addDecimal(cur.confirmed, confirmed)
    });
  };

  // ---------------------------------------------------------------------
  // Trace-everything mode: no quantity nominated.
  //
  // Every observed movement is in scope, so there is nothing to attribute and
  // nothing to reconcile. Edges keep the evidence status the observation layer
  // gave them; this function only normalises the confidence and states the mode
  // so a reader is not left wondering why no amount appears.
  // ---------------------------------------------------------------------
  if (quantity === null) {
    caveats.push(
      "No amount was nominated, so this trace follows every observed movement rather than a specific quantity. Attribution and reconciliation do not apply."
    );

    for (const edge of edges) {
      confidenceByEdge.set(edge.id, baseConfidenceForObservation(edge));
      reasonsByEdge.set(edge.id, observationReasons(edge));
      tracedByEdge.set(edge.id, edge.observedAmount);
    }

    return {
      edges: edges.map((e) => ({
        ...e,
        confidence: confidenceByEdge.get(e.id) ?? 1,
        reasons: reasonsByEdge.get(e.id) ?? []
      })),
      nodeAmounts,
      reconciliation: {
        asset: input.asset,
        initialAmount: null,
        directlyObserved: "0",
        attributed: "0",
        explainedOutflow: "0",
        unresolved: "0",
        coverage: null,
        status: "not_applicable",
        perHop: [],
        caveats
      }
    };
  }

  if (toNumber(quantity) <= 0) {
    throw new Error("The amount to trace must be greater than zero.");
  }

  // "both" collects inbound and outbound edges but only a forward reading is
  // attributable, so say that instead of silently attributing half the graph.
  if (direction === "both") {
    caveats.push(
      "Direction is set to Both. Attribution follows the money outward from the root; inbound edges are shown but carry no attributed quantity. Re-run as Backward to attribute funds arriving at the root."
    );
  }

  // Hop layering: a node's hop distance places it in a layer, which is what
  // makes per-hop reconciliation possible.
  const hops = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const list = hops.get(n.hopDistance) ?? [];
    list.push(n);
    hops.set(n.hopDistance, list);
  }

  /**
   * Money flows along the edge for a forward trace and against it for a
   * backward one. The tracer discovers nodes outward in the requested
   * direction, so ascending hop order is always upstream-to-downstream in these
   * terms and a single ascending pass is enough.
   */
  const flowFrom = (e: GraphEdge): string =>
    direction === "backward" ? e.target.toLowerCase() : e.source.toLowerCase();
  const flowTo = (e: GraphEdge): string =>
    direction === "backward" ? e.source.toLowerCase() : e.target.toLowerCase();

  const edgesByFlowFrom = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const key = flowFrom(e);
    const list = edgesByFlowFrom.get(key) ?? [];
    list.push(e);
    edgesByFlowFrom.set(key, list);
  }

  bumpNode(rootKey, quantity, direction === "backward" ? quantity : "0");

  // Conservation is counted once per unit of the nominated quantity, at the
  // point where its fate is decided. Summing every hop's placements would count
  // the same funds once per hop they survive: 10 that reach a splitter and
  // continue to two destinations would total 25 and report 250% coverage.
  //
  // Per hop the quantity satisfies `in = placedOnward + stoppedHere`, and
  // `stoppedHere` splits into two very different fates:
  //
  //   located  - the funds are still at that address (no onward movement, or
  //              only change/fees/contract calls, which are not movements).
  //              We can point at them.
  //   lost     - the address did move funds but the method could not place the
  //              quantity among them. Nothing supports a destination.
  //
  // Telescoping over the hops gives `quantity = tailPlaced + Σ located + Σ lost`,
  // so coverage is exactly `(located + tailPlaced) / quantity` and the shortfall
  // is exactly `Σ lost`. Both are verifiable, and `unresolved` is never allowed
  // to absorb a located remainder.
  let locatedConfirmed = "0";
  let locatedInferred = "0";
  let lostConfirmed = "0";
  let lostInferred = "0";
  let lostAtHop = 0;
  // Observed outflow that provably left the path as fee or change, so it is
  // accounted rather than reported missing.
  let explainedTotal = "0";
  // Placed-onward totals per hop: only the final expanded hop's can be terminal,
  // because earlier hops' placements reappear as later hops' inflows.
  const placedByHop = new Map<number, { confirmed: string; inferred: string }>();
  // A node reachable at more than one hop distance must only be settled once.
  const settled = new Set<string>();
  // Edges carrying the node's entire held quantity as one exact transfer. The
  // only case where attribution adds no judgement of its own.
  const cleanPassThrough = new Set<string>();

  /** Split an amount held at a node into its confirmed and inferred portions. */
  const splitByEvidence = (key: string, amount: string): { confirmed: string; inferred: string } => {
    const held = nodeAmounts.get(key);
    const heldTotal = toNumber(held?.traced ?? "0");
    const confirmed = toNumber(held?.confirmed ?? "0");
    if (heldTotal <= 0 || confirmed <= 0) return { confirmed: "0", inferred: amount };
    if (confirmed >= heldTotal) return { confirmed: amount, inferred: "0" };
    // Under pro-rata (the default) this split is exact, because every share is
    // proportional to the node's held quantity. FIFO and Poison re-order the
    // shares, so the split is then a reasonable apportionment rather than a
    // proven one; the totals stay exact either way.
    const part = shareDecimal(amount, String(confirmed), String(heldTotal));
    return { confirmed: minDecimal(part, amount), inferred: clampZero(subDecimal(amount, part)) };
  };

  /** Funds are still sitting at this address, so their location is known. */
  const markLocated = (key: string, amount: string): void => {
    if (toNumber(amount) <= 0) return;
    const parts = splitByEvidence(key, amount);
    locatedConfirmed = addDecimal(locatedConfirmed, parts.confirmed);
    locatedInferred = addDecimal(locatedInferred, parts.inferred);
  };

  /** Funds moved out but no destination is supported for them. */
  const markLost = (key: string, amount: string): void => {
    if (toNumber(amount) <= 0) return;
    const parts = splitByEvidence(key, amount);
    lostConfirmed = addDecimal(lostConfirmed, parts.confirmed);
    lostInferred = addDecimal(lostInferred, parts.inferred);
  };

  for (let hop = 0; hop <= input.maxHops; hop++) {
    const layer = hops.get(hop) ?? [];
    let hopIn = "0";
    let hopOut = "0";
    let hopLocated = "0";
  let hopLost = "0";
    let hopExplained = "0";
    let hopOutputCount = 0;
    let hopPlacedConfirmed = "0";
    let hopPlacedInferred = "0";

    for (const node of layer) {
      const key = node.id.toLowerCase();
      const held = nodeAmounts.get(key)?.traced ?? "0";
      hopIn = addDecimal(hopIn, held);

      const outputs = edgesByFlowFrom.get(key) ?? [];

      if (toNumber(held) <= 0) {
        // No investigated funds here, so anything leaving is out of scope. Still
        // drawn and still labelled, so a reader can see what was ruled out.
        for (const e of outputs) {
          tracedByEdge.set(e.id, "0");
          reasonsByEdge.set(e.id, [
            {
              code: "out_of_scope",
              detail: "No part of the investigated quantity had reached this address, so this output is excluded from the trace.",
              weight: "weakens"
            }
          ]);
          confidenceByEdge.set(e.id, 0);
        }
        continue;
      }

      if (settled.has(key)) continue;
      settled.add(key);

      if (!outputs.length) {
        // The funds arrived and nothing left. That is a location, not a loss.
        hopLocated = addDecimal(hopLocated, held);
        markLocated(key, held);
        caveats.push(
          `${toNumber(held) > 0 ? `${held} ${input.asset}` : "Funds"} reached ${shorten(node.address)} at hop ${hop} with no outbound movement recorded. Tracing stopped here.`
        );
        continue;
      }

      hopOutputCount += outputs.length;

      // Relationships that cannot carry the investigated quantity. A contract
      // call is not a transfer, and change is the sender's own remainder.
      const eligible: GraphEdge[] = [];
      let explainedCapacity = "0";
      // A transaction with several outputs pays its fee once, so the fee is
      // credited to the hop a single time per transaction. Without this key, a
      // four-output transaction would explain the same gas four times and a
      // trace would appear to balance by inventing money.
      const feeCredited = new Set<string>();
      for (const e of outputs) {
        if (isNonCarryingRelationship(e.relationship)) {
          tracedByEdge.set(e.id, "0");
          reasonsByEdge.set(e.id, nonCarryingReasons(e));
          confidenceByEdge.set(e.id, e.confidence > 0 ? e.confidence : 1);
          if (isExplainedOutflowRelationship(e.relationship)) {
            explainedCapacity = addDecimal(explainedCapacity, e.observedAmount);
          }
        } else {
          eligible.push(e);
          // Only a carrying leg carries its transaction's fee. A fee edge already
          // reported the same gas as its own observed amount, and crediting both
          // would count it twice.
          const fee = e.feeNative;
          if (fee != null && toNumber(fee) > 0) {
            const key = `${e.source.toLowerCase()}:${e.txHash.toLowerCase()}`;
            if (!feeCredited.has(key)) {
              feeCredited.add(key);
              explainedCapacity = addDecimal(explainedCapacity, fee);
            }
          }
        }
      }

      if (!eligible.length) {
        // Change, fees, contract calls and unevidenced associations are not
        // movements, so the funds never left this address. That is a location,
        // not a loss.
        hopLocated = addDecimal(hopLocated, held);
        markLocated(key, held);
        caveats.push(
          `None of the ${outputs.length} outbound movement(s) from ${shorten(node.address)} at hop ${hop} can carry the investigated quantity (fees, change, contract calls or unevidenced associations), so the ${held} ${input.asset} did not leave this address.`
        );
        continue;
      }

      const shares = distribute(held, eligible, method);

      for (const e of eligible) {
        const share = clampZero(shares.get(e.id) ?? "0");
        tracedByEdge.set(e.id, share);
        confidenceByEdge.set(e.id, confidenceFor(e, share, method, eligible.length));
        reasonsByEdge.set(e.id, reasonsFor(e, share, held, method, eligible.length, node));
        bumpNode(flowTo(e), share, "0");

        if (toNumber(share) > 0) {
          hopOut = addDecimal(hopOut, share);
          // A clean pass-through is observation, not inference: the nominated
          // quantity is literally this transfer, with nothing held back and
          // nothing split off.
          if (share === held && nearEqual(share, e.observedAmount)) {
            cleanPassThrough.add(e.id);
            hopPlacedConfirmed = addDecimal(hopPlacedConfirmed, share);
            bumpNode(flowTo(e), "0", share);
          } else {
            hopPlacedInferred = addDecimal(hopPlacedInferred, share);
          }
        }
      }

      // Whatever the method could not place becomes unresolved, per hop, so the
      // shortfall is attributable to a specific point in the path. This is the
      // only genuinely lost quantity in the whole trace.
      const unattributed = clampZero(subDecimal(held, hopOutAt(eligible, tracedByEdge)));
      if (toNumber(unattributed) > 0) {
        // Fees and change are observed outflows, so they account for part of the
        // shortfall. Only the residue is lost. Every hop on Ethereum or Tron
        // pays gas, so without this a correct trace reports the gas as missing
        // funds at every step.
        const explained = minDecimal(unattributed, explainedCapacity);
        hopExplained = addDecimal(hopExplained, explained);
        explainedTotal = addDecimal(explainedTotal, explained);

        const lost = clampZero(subDecimal(unattributed, explained));
        if (toNumber(lost) > 0) {
          hopLost = addDecimal(hopLost, lost);
          markLost(key, lost);
          lostAtHop++;
        }
      }
    }

    placedByHop.set(hop, { confirmed: hopPlacedConfirmed, inferred: hopPlacedInferred });

    if (hopIn !== "0" || hopOut !== "0" || hopLocated !== "0" || hopLost !== "0" || hopExplained !== "0") {
      perHop.push({
        hop,
        inAmount: hopIn,
        attributedOut: hopOut,
        located: hopLocated,
        explained: hopExplained,
        unresolved: hopLost,
        outputCount: hopOutputCount
      });
    }
  }

  // Funds placed onward out of the final expanded hop have nowhere left to
  // settle: their destination is on the graph but was not followed. They are
  // accounted here so the totals still add up to the nominated quantity.
  const lastExpandedHop = Math.max(0, ...placedByHop.keys());
  const tail = placedByHop.get(lastExpandedHop);
  if (tail) {
    locatedConfirmed = addDecimal(locatedConfirmed, tail.confirmed);
    locatedInferred = addDecimal(locatedInferred, tail.inferred);
  }

  // Public-facing buckets: where we can point, split by how well the evidence
  // supports it, what provably burned as fee or change, and the shortfall we
  // cannot place at all.
  const directlyObserved = locatedConfirmed;
  const attributed = locatedInferred;
  const unresolved = addDecimal(lostConfirmed, lostInferred);
  // Fees and change are accounted, not located: the money is gone but it is
  // accounted for. Counting them toward coverage is what lets a trace that paid
  // gas at every hop still report as reconciled.
  const totalAccounted = addDecimal(addDecimal(directlyObserved, attributed), explainedTotal);
  const coverage = toNumber(quantity) > 0 ? toNumber(totalAccounted) / toNumber(quantity) : null;

  if (toNumber(explainedTotal) > 0) {
    caveats.push(
      `${explainedTotal} ${input.asset} left the traced path as transaction fees or change rather than to another tracked address. That is an accounted outflow, so it is not counted as unresolved, but it also never reached a destination wallet.`
    );
  }
  if (lostAtHop > 0) {
    caveats.push(
      `Attribution lost part of the traced quantity at ${lostAtHop} hop level(s). The unresolved figure is reported rather than distributed across wallets, because no observed transfer supports doing so.`
    );
  }
  if (method === "poison") {
    caveats.push(
      "Poison is deliberately over-inclusive: it treats each output of a co-mingled wallet as potentially holding the entire traced quantity, so attributed totals can exceed the nominated amount."
    );
  }
  if (method === "haircut") {
    caveats.push(
      `Haircut discounts the pro-rata share by ${Math.round((1 - Number(HAIRCUT_DISCOUNT)) * 100)}% at every split to reflect co-mingling uncertainty. Treat the result as a floor.`
    );
  }
  if (method === "direct" && coverage !== null && coverage < 1) {
    caveats.push(
      "Direct tracing found no clean pass-through carrying the full quantity, so the trace is inconclusive. This is a finding about the evidence, not a gap in the data."
    );
  }

  const status: TraceReconciliation["status"] =
    toNumber(unresolved) <= 0 && (coverage ?? 0) >= 0.999 ? "reconciled" : toNumber(totalAccounted) > 0 ? "partial" : "unreconciled";

  // Final edge enrichment.
  const enriched = edges.map((e) => {
    const traced = tracedByEdge.get(e.id) ?? null;
    const base = baseEvidenceStatus(e, traced, cleanPassThrough.has(e.id));
    return {
      ...e,
      tracedAmount: traced,
      traceMethod: base === "confirmed" ? null : method,
      evidenceStatus: base,
      confidence: confidenceByEdge.get(e.id) ?? 0,
      reasons: reasonsByEdge.get(e.id) ?? []
    };
  });

  // Attribute the observed portion to the receiving node as well, so a node's
  // panel can separate what was directly seen from what was inferred.
  for (const e of enriched) {
    if (e.evidenceStatus === "confirmed" && toNumber(e.tracedAmount) > 0) {
      bumpNode(e.target, "0", e.tracedAmount ?? "0");
    }
  }

  return {
    edges: enriched,
    nodeAmounts,
    reconciliation: {
      asset: input.asset,
      initialAmount: quantity,
      directlyObserved,
      attributed,
      explainedOutflow: explainedTotal,
      unresolved,
      coverage,
      status,
      perHop,
      caveats
    }
  };
}

/* ------------------------------------------------------------------ *
 * Distribution methods
 * ------------------------------------------------------------------ */

/** One output considered by a distribution pass. */
interface Output {
  edge: GraphEdge;
  observed: string;
}

/**
 * Split `amount` across `outputs` according to `method`.
 *
 * Every method returns a map from edge id to the share placed on it. Shares are
 * clamped to the observed amount, because attributing more to a leg than the
 * chain recorded for that leg would be a fabricated transfer.
 */
function distribute(amount: string, outputs: GraphEdge[], method: TraceMethod): Map<string, string> {
  const result = new Map<string, string>();
  const usable: Output[] = outputs
    .map((edge) => ({ edge, observed: edge.observedAmount }))
    .filter((o) => toNumber(o.observed) > 0);

  // Nothing priced to divide: cannot attribute, and must not guess a ratio.
  if (!usable.length) {
    for (const e of outputs) result.set(e.id, "0");
    return result;
  }

  switch (method) {
    case "direct":
      return distributeDirect(amount, outputs, usable, result);
    case "fifo":
      return distributeFifo(amount, usable, result);
    case "pro_rata":
      return distributeProRata(amount, usable, result, "1");
    case "haircut":
      return distributeProRata(amount, usable, result, HAIRCUT_DISCOUNT);
    case "poison":
      return distributePoison(amount, usable, result);
  }
}

/**
 * Direct: only a clean pass-through counts.
 *
 * A single output holding at least the whole quantity is followed; everything
 * else is left behind. When funds were split, there is no evidence of where the
 * nominated quantity went, and reporting a partial guess as `direct` would be
 * the exact misrepresentation this engine exists to avoid.
 */
function distributeDirect(
  amount: string,
  outputs: GraphEdge[],
  usable: Output[],
  result: Map<string, string>
): Map<string, string> {
  for (const e of outputs) result.set(e.id, "0");

  const target = toNumber(amount);
  const candidates = usable.filter((o) => toNumber(o.observed) >= target);
  if (!candidates.length) return result;

  // Largest qualifying output wins: with a single clean pass-through there is
  // nothing to choose between them.
  const best = candidates.reduce((a, b) => (toNumber(a.observed) >= toNumber(b.observed) ? a : b));
  result.set(best.edge.id, minDecimal(amount, best.observed));
  return result;
}

/** FIFO: consume outputs oldest-first until the quantity is exhausted. */
function distributeFifo(amount: string, usable: Output[], result: Map<string, string>): Map<string, string> {
  const ordered = [...usable].sort((a, b) => {
    const ta = a.edge.timestamp ? Date.parse(a.edge.timestamp) : Number.MAX_SAFE_INTEGER;
    const tb = b.edge.timestamp ? Date.parse(b.edge.timestamp) : Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    // Deterministic tiebreak so the same input always yields the same split.
    if (a.edge.txHash !== b.edge.txHash) return a.edge.txHash.localeCompare(b.edge.txHash);
    return a.edge.id.localeCompare(b.edge.id);
  });

  let remaining = amount;
  for (const o of ordered) {
    if (toNumber(remaining) <= 0) break;
    const share = minDecimal(remaining, o.observed);
    result.set(o.edge.id, share);
    remaining = subDecimal(remaining, share);
  }
  return result;
}

/**
 * Pro-rata (optionally discounted, which is how Haircut is built).
 *
 * Each output receives `amount * observed / totalObserved`, and the shares are
 * made to sum to `amount` exactly. The residual matters: fixed-point division
 * truncates, so 3 split across 3 and 1.2 yields shares that fall 1 wei short of
 * 3. Left alone, that 1 wei is reported as unresolved and a fully reconciled
 * trace is downgraded to `partial` while claiming money went missing. The
 * shortfall is therefore handed to the largest output, which is where rounding
 * error belongs, with the edge id as a deterministic tiebreak.
 */
function distributeProRata(
  amount: string,
  usable: Output[],
  result: Map<string, string>,
  scale: string
): Map<string, string> {
  const total = usable.reduce((s, o) => addDecimal(s, o.observed), "0");
  if (toNumber(total) <= 0) return result;

  let placed = "0";
  for (const o of usable) {
    let share = shareDecimal(amount, o.observed, total);
    if (scale !== "1") share = shareDecimal(share, scale, "1");
    share = minDecimal(share, o.observed);
    result.set(o.edge.id, share);
    placed = addDecimal(placed, share);
  }

  const residual = clampZero(subDecimal(amount, placed));
  if (toNumber(residual) > 0) {
    const target = usable.reduce((a, b) => {
      if (toNumber(b.observed) !== toNumber(a.observed)) {
        return toNumber(b.observed) > toNumber(a.observed) ? b : a;
      }
      return b.edge.id.localeCompare(a.edge.id) < 0 ? b : a;
    });
    result.set(
      target.edge.id,
      minDecimal(addDecimal(result.get(target.edge.id) ?? "0", residual), target.observed)
    );
  }

  return result;
}

/**
 * Poison: assume the worst case at every split.
 *
 * Each output is treated as potentially holding the entire traced quantity. The
 * total deliberately over-counts, which is the point — it is the assumption to
 * use when the goal is to justify freezing rather than to quantify a loss.
 */
function distributePoison(amount: string, usable: Output[], result: Map<string, string>): Map<string, string> {
  for (const o of usable) {
    result.set(o.edge.id, minDecimal(amount, o.observed));
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Evidence labelling
 * ------------------------------------------------------------------ */

/** Relationships that cannot represent the investigated quantity moving. */
function isNonCarryingRelationship(r: EdgeRelationship): boolean {
  return (
    r === "contract_interaction" ||
    r === "change_output" ||
    r === "fee" ||
    // A suspected link is a statement about control, not a movement, so it
    // carries nothing. Treating it as eligible would let attribution place real
    // funds on a destination we cannot evidence.
    r === "possible_association" ||
    // The far side of a bridge is denominated in another asset. Until a priced
    // conversion exists, the source-chain quantity cannot be placed on it.
    r === "cross_chain_link"
  );
}

/** Prose for an edge that moved no funds, so it is shown as context only. */
const NON_CARRYING_DETAIL: Partial<Record<EdgeRelationship, string>> = {
  contract_interaction:
    "This is a contract call, not a transfer. The transaction touched this address without moving funds to it.",
  change_output:
    "This output is change returning to the sender, so it is the sender's own remainder rather than onward movement.",
  fee: "This is a transaction fee paid to a validator or miner, not a transfer between the two addresses.",
  possible_association:
    "These addresses are associated on the evidence below, but no transfer between them was observed, so this connection carries none of the traced funds.",
  cross_chain_link:
    "This is the far side of a bridge or cross-ledger movement. It is denominated in a different asset, so the traced quantity cannot be carried across without a priced conversion."
};

/**
 * Relationships whose observed value explains why less left an address than the
 * method could place. A fee or change is money that provably went somewhere; it
 * is accounted for rather than reported missing.
 */
function isExplainedOutflowRelationship(r: EdgeRelationship): boolean {
  return r === "fee" || r === "change_output";
}

function nonCarryingReasons(e: GraphEdge): EvidenceReason[] {
  // A demo or imported edge can arrive with its own forensic reasoning. That
  // reasoning is the point of the edge, so it is kept rather than replaced with
  // generic prose about non-transfers.
  if (e.reasons.length > 0) return e.reasons;
  return [
    {
      code: e.relationship,
      detail:
        NON_CARRYING_DETAIL[e.relationship] ??
        "This movement is accounted for as a non-transfer and carries none of the investigated funds.",
      weight: "weakens"
    }
  ];
}

/**
 * Final evidence status for an edge once a quantity is in play.
 *
 * Only one case stays `confirmed`: the nominated quantity is exactly this
 * observed transfer. Everything else is the output of a chosen assumption, so
 * it is labelled `attributed`.
 */
function baseEvidenceStatus(
  e: GraphEdge,
  traced: string | null,
  cleanPassThrough: boolean
): EvidenceStatus {
  if (isNonCarryingRelationship(e.relationship)) {
    // An association we cannot evidence, and a cross-ledger leg we cannot
    // denominate, stay `inferred`: excluding them would read as "we checked and
    // found nothing", which is a stronger claim than the evidence supports.
    if (e.relationship === "possible_association" || e.relationship === "cross_chain_link") return "inferred";
    return "excluded";
  }
  if (e.relationship === "cross_chain_link") return "inferred";
  if (traced === null || toNumber(traced) <= 0) return "excluded";

  // The observation layer sets a ceiling that attribution cannot lift. A pairing
  // our own normaliser computed from transaction inputs and outputs is never a
  // confirmed transfer between two addresses, however neatly the amount matches,
  // so it stays `derived`.
  if (e.evidenceStatus === "uncertain") return "uncertain";

  if (cleanPassThrough) {
    return e.evidenceStatus === "confirmed" ? "confirmed" : "derived";
  }

  // The quantity was placed by apportionment, so the destination is a judgement.
  return "attributed";
}

function confidenceFor(e: GraphEdge, share: string, method: TraceMethod, outputCount: number): number {
  if (toNumber(share) <= 0) return 0;
  if (toNumber(e.observedAmount) <= 0) return 0.2;

  let confidence = BASE_CONFIDENCE[method];

  // An exact pass-through is the strongest result any method can produce.
  if (nearEqual(share, e.observedAmount)) return Math.min(1, confidence + 0.1);

  // Ambiguity grows with the number of ways the quantity could have gone.
  if (outputCount > 4) confidence -= 0.13;
  else if (outputCount > 2) confidence -= 0.05;
  else if (outputCount === 1) confidence += 0.05;

  // A share that consumes most of a leg is more likely than one that barely
  // touches it.
  const coverage = toNumber(share) / toNumber(e.observedAmount);
  if (coverage >= 0.95) confidence += 0.08;
  else if (coverage < 0.2) confidence -= 0.08;

  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

/** Human-readable justification for one edge. */
function reasonsFor(
  e: GraphEdge,
  share: string,
  held: string,
  method: TraceMethod,
  outputCount: number,
  from: GraphNode
): EvidenceReason[] {
  const reasons: EvidenceReason[] = [];

  reasons.push({
    code: "same_asset",
    detail: "Both sides hold the same asset, so no conversion stands between receipt and onward movement.",
    weight: "supports"
  });

  // Restate the observation-layer caveat alongside the amount reasoning, so an
  // edge that is only as strong as its pairing never reads as a plain transfer.
  if (e.evidenceStatus === "derived") {
    reasons.push({
      code: "derived_pairing",
      detail:
        "This edge is a pairing computed from transaction inputs and outputs, not a transfer the chain recorded between these two addresses.",
      weight: "qualifies"
    });
  }
  if (e.evidenceStatus === "uncertain") {
    reasons.push({
      code: "uncertain_observation",
      detail: "The underlying observation is itself uncertain, so no conclusion drawn from it can be firmer than that.",
      weight: "weakens"
    });
  }

  // Real elapsed time between the address being credited and this leg leaving
  // it. Null when either timestamp is missing, in which case no timing claim is
  // made rather than a placeholder one.
  const lagMinutes = minutesBetween(from.lastSeen, e.timestamp);
  if (lagMinutes !== null) {
    reasons.push({
      code: "pass_through_timing",
      detail:
        lagMinutes <= 0
          ? "Onward movement is contemporaneous with the credit to this address."
          : `Onward movement followed ${formatLag(lagMinutes)} after this address was credited.`,
      weight: lagMinutes <= 240 ? "supports" : "qualifies"
    });
  }

  if (outputCount > 1) {
    reasons.push({
      code: "split",
      detail: `${outputCount} outbound transfers shared the investigated quantity, so this share is the result of the ${methodLabel(method)} assumption rather than an observed amount.`,
      weight: "qualifies"
    });
  } else {
    reasons.push({
      code: "single_output",
      detail: "The investigated quantity left through a single output, so no split assumption was needed.",
      weight: "supports"
    });
  }

  if (nearEqual(share, e.observedAmount)) {
    reasons.push({
      code: "amount_match",
      detail: `The attributed share matches this transfer's recorded amount exactly (${share} ${e.asset}).`,
      weight: "supports"
    });
  } else {
    reasons.push({
      code: "amount_correlation",
      detail: `${share} of the ${held} under investigation is attributed here, against ${e.observedAmount} ${e.asset} actually observed on this leg.`,
      weight: "qualifies"
    });
  }

  if (e.relationship === "cross_chain_link") {
    reasons.push({
      code: "cross_chain_correlation",
      detail: "This link crosses ledgers. It rests on a bridge or exchange correlation, not on an observed transfer between the two chains.",
      weight: "weakens"
    });
  }

  return reasons;
}

/** Confidence and reasons for an edge when no quantity was nominated. */
function baseConfidenceForObservation(e: GraphEdge): number {
  if (toNumber(e.observedAmount) <= 0) return 0.5;
  switch (e.evidenceStatus) {
    case "confirmed":
      return 1;
    case "derived":
      return 0.9;
    case "inferred":
      return 0.74;
    case "uncertain":
      return 0.4;
    default:
      return 0.85;
  }
}

function observationReasons(e: GraphEdge): EvidenceReason[] {
  const reasons: EvidenceReason[] = [
    {
      code: "observed",
      detail: `Recorded by the ${e.source.replace("_", " ")} in transaction ${e.txHash}.`,
      weight: "supports"
    }
  ];

  if (e.evidenceStatus === "derived") {
    reasons.push({
      code: "derived_pairing",
      detail:
        "This edge is a pairing computed from transaction inputs and outputs, not a transfer the chain recorded between these two addresses.",
      weight: "qualifies"
    });
  }

  if (e.relationship === "cross_chain_link") {
    reasons.push({
      code: "cross_chain_correlation",
      detail:
        "This link crosses ledgers. It rests on a bridge or exchange correlation rather than an observed transfer between the two chains.",
      weight: "weakens"
    });
  }

  return reasons;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Total attributed to the given edges, read back from the trace map. */
function hopOutAt(outputs: GraphEdge[], tracedByEdge: Map<string, string>): string {
  return outputs.reduce((s, e) => addDecimal(s, tracedByEdge.get(e.id) ?? "0"), "0");
}

/**
 * Elapsed whole minutes between two ISO timestamps, or null when either is
 * missing or unparseable. Returned value may be negative if the timestamps are
 * out of order, which the caller reports as "contemporaneous".
 */
function minutesBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60_000;
}

function formatLag(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} days`;
}

function methodLabel(method: TraceMethod): string {
  switch (method) {
    case "pro_rata":
      return "pro-rata";
    case "fifo":
      return "FIFO";
    case "haircut":
      return "haircut";
    case "poison":
      return "poison";
    case "direct":
      return "direct pass-through";
  }
}

export function methodDisplayName(method: TraceMethod): string {
  switch (method) {
    case "direct":
      return "Direct pass-through";
    case "fifo":
      return "FIFO (oldest first)";
    case "pro_rata":
      return "Pro-rata";
    case "haircut":
      return "Haircut (conservative)";
    case "poison":
      return "Poison (over-inclusive)";
  }
}

/** One-line statement of what a method assumes, for the method picker. */
export function methodAssumption(method: TraceMethod): string {
  switch (method) {
    case "direct":
      return "Follows only outputs that carry the whole quantity. Conclusive when it works, inconclusive when funds were split.";
    case "fifo":
      return "Spends the quantity against the oldest outputs first. Order-dependent, so a different ordering would give a different split.";
    case "pro_rata":
      return "Splits the quantity in proportion to each output's value. Conserves the total exactly.";
    case "haircut":
      return "Pro-rata, then discounted 25% per split for co-mingling uncertainty. Treat the result as a floor.";
    case "poison":
      return "Assumes every output of a mixed wallet may hold the whole quantity. Over-counts on purpose, to justify freezing.";
  }
}

function shorten(address: string): string {
  return address.length <= 20 ? address : `${address.slice(0, 10)}…${address.slice(-6)}`;
}