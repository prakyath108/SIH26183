import { adapterFor, detect, isValidAddress } from "../chains/index.js";
import { type NormalizedTransaction, type NormalizedTransfer } from "../chains/base.js";
import { badRequest } from "../middleware/error.js";
import { one, many, type Db, getDb } from "../db/index.js";
import { labelsForAddresses, assess, buildTraversalContext, type StoredLabel } from "../risk/service.js";
import { fetchAdvisory } from "../risk/mlClient.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import type { Chain, EdgeRelationship, EvidenceStatus, GraphEdge, GraphNode, TraceGraph, TraceMethod } from "../types.js";
import { buildFundFlowLedger } from "./ledger.js";
import { detectBridgeInteraction } from "./bridges.js";
import { applyNodeAmounts, attributeFunds } from "./attribution.js";
import { toNumber } from "./decimal.js";
import {
  recordProviderResponse,
  recordNormalizedEvent,
  recordGraphEdge
} from "./lineage.js";

/**
 * Multi-hop fund-flow tracer.
 *
 * Bounds are hard limits, not hints. Real chains are unbounded graphs and a
 * recursive walk will happily exhaust memory, so every expansion is gated on
 * hop depth, edge count, wall-clock time and per-node request budget. When a
 * bound trips we record *why* in `totals.truncatedReasons` rather than silently
 * returning a partial graph that looks complete.
 */

export interface TraceOptions {
  chain: Chain;
  rootAddress: string;
  maxHops?: number;
  maxEdges?: number;
  maxNodes?: number;
  direction?: "forward" | "backward" | "both";
  timeoutMs?: number;
  /** Skip live lookups; resolve edges from our own store only. */
  offline?: boolean;
  persistCaseId?: string | null;
  userId?: string | null;
  /** Maximum counterparties per transaction per hop. Higher = more complete graphs. */
  maxCounterpartiesPerTx?: number;
  /** Maximum stored transactions to load per address per hop. */
  maxStoredTxsPerAddress?: number;
  /**
   * Quantity of {@link asset} to follow, as a decimal string.
   *
   * `null` traces every observed movement instead. When set, this becomes the
   * investigated fund quantity and the graph is attributed against it, so the
   * answer is "where did this much go" rather than "what is connected".
   */
  amountToTrace?: string | null;
  /** Asset the investigation is denominated in. Defaults to the chain's native asset. */
  asset?: string;
  /** Attribution method for splits. Defaults to `pro_rata`, which conserves the total. */
  method?: TraceMethod;
  /** Marks the whole graph synthetic. Propagated to the reconciliation caveats. */
  demo?: boolean;
  demoCaseId?: string | null;
  /**
   * Progress callback invoked after each hop with current tracing state.
   * Useful for real-time UI streaming. Receives { hop, frontier, nodes, edges }.
   * May be synchronous or async; if async the traversal will await it.
   */
  onProgress?: (state: { hop: number; frontier: number; nodes: number; edges: number }) => void | Promise<void>;
}

const DEFAULTS = {
  maxHops: 3,
  maxEdges: 150,
  maxNodes: 120,
  direction: "forward" as const,
  timeoutMs: 45_000,
  maxCounterpartiesPerTx: 20,
  maxStoredTxsPerAddress: 200,
  method: "pro_rata" as TraceMethod
};

/** Native asset symbol per chain, used when the caller does not name one. */
const NATIVE_ASSET: Partial<Record<Chain, string>> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  polygon: "MATIC",
  tron: "TRX"
};

export function nativeAssetFor(chain: Chain): string {
  return NATIVE_ASSET[chain] ?? "NATIVE";
}

export class TraceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceLimitError";
  }
}

export async function trace(db: Db, opts: TraceOptions): Promise<TraceGraph> {
  const maxHops = clamp(opts.maxHops ?? DEFAULTS.maxHops, 1, 6);
  const maxEdges = clamp(opts.maxEdges ?? DEFAULTS.maxEdges, 5, 500);
  const maxNodes = clamp(opts.maxNodes ?? DEFAULTS.maxNodes, 5, 300);
  const direction = opts.direction ?? DEFAULTS.direction;
  const deadline = Date.now() + clamp(opts.timeoutMs ?? DEFAULTS.timeoutMs, 2000, 120_000);
  const maxCounterpartiesPerTx = clamp(opts.maxCounterpartiesPerTx ?? DEFAULTS.maxCounterpartiesPerTx, 2, 100);
  const maxStoredTxsPerAddress = clamp(opts.maxStoredTxsPerAddress ?? DEFAULTS.maxStoredTxsPerAddress, 10, 1000);
  const asset = (opts.asset ?? nativeAssetFor(opts.chain)).toUpperCase();
  const method = opts.method ?? DEFAULTS.method;
  const amountToTrace = opts.amountToTrace ?? null;

  if (!isValidAddress(opts.chain, opts.rootAddress)) {
    // The caller's address is wrong, not the chain, so this is a 400 rather
    // than an upstream failure.
    throw badRequest(`'${opts.rootAddress}' is not a valid ${opts.chain} address`);
  }
  if (amountToTrace !== null && toNumber(amountToTrace) <= 0) {
    throw badRequest("Amount to trace must be a positive number, or omitted to follow every transfer");
  }

  const root = opts.rootAddress.toLowerCase();
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const visited = new Set<string>([root]);
  const truncatedReasons = new Set<string>();
  const hopIntervals: number[] = [];
  /**
   * Graph identity is lower-cased so nodes and stored rows join on one key, but
   * base58 and bech32 are case-sensitive and public explorers reject a
   * lower-cased form. This keeps the address as the upstream reported it so the
   * next hop's live lookup uses the canonical spelling.
   */
  const canonical = new Map<string, string>([[root, opts.rootAddress]]);
  let bridgeCrossings = 0;
  let edgeId = 0;

  nodes.set(root, {
    id: root,
    address: root,
    chain: opts.chain,
    kind: "unknown",
    riskScore: 0,
    riskLevel: "Unrated",
    txCount: 0,
    hopDistance: 0
  });

  let frontier: string[] = [root];
  const notes = new Set<string>();

  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    if (Date.now() > deadline) {
      truncatedReasons.add(`Wall-clock limit of ${clamp(opts.timeoutMs ?? DEFAULTS.timeoutMs, 2000, 120_000)}ms reached at hop ${hop}`);
      break;
    }

    if (opts.onProgress) {
      await opts.onProgress({ hop, frontier: frontier.length, nodes: nodes.size, edges: edges.length });
    }

    const nextFrontier: string[] = [];

    for (const address of frontier) {
      if (edges.length >= maxEdges) {
        truncatedReasons.add(`Edge limit of ${maxEdges} reached`);
        break;
      }
      if (Date.now() > deadline) {
        truncatedReasons.add("Wall-clock limit reached mid-hop");
        break;
      }

      const counterparties = await resolveCounterparties(
        db,
        opts,
        address,
        direction,
        deadline,
        canonical.get(address) ?? address,
        maxCounterpartiesPerTx,
        maxStoredTxsPerAddress
      );
      if (counterparties.truncated) truncatedReasons.add(counterparties.reason ?? "Counterparty limit reached");
      if (counterparties.note) notes.add(counterparties.note);

      for (const cp of counterparties.edges) {
        if (edges.length >= maxEdges) {
          truncatedReasons.add(`Edge limit of ${maxEdges} reached`);
          break;
        }

        const from = cp.from.toLowerCase();
        const to = cp.to.toLowerCase();
        const other = from === address.toLowerCase() ? to : from;
        if (!other) continue;

        const pushedEdge: GraphEdge = {
          id: `e${edgeId++}`,
          source: from,
          target: to,
          txHash: cp.txHash,
          timestamp: cp.timestamp,
          valueNative: cp.valueNative,
          valueUsd: cp.valueUsd,
          status: cp.status,
          hop,
          providerResponseId: cp.providerResponseId,
          asset,
          // Observation-layer facts. `observedAmount` is what the chain recorded
          // and is never adjusted downstream; attribution adds `tracedAmount`
          // alongside it rather than overwriting it.
          observedAmount: cp.valueNative,
          tracedAmount: null,
          relationship: cp.relationship,
          evidenceStatus: cp.evidenceStatus,
          traceMethod: null,
          confidence: cp.evidenceStatus === "confirmed" ? 1 : 0.9,
          evidenceSource: cp.source,
          blockNumber: null,
          ...(cp.feeNative ? { feeNative: cp.feeNative } : {}),
          reasons: []
        };
        edges.push(pushedEdge);

        // Detect bridge interactions
        if (opts.persistCaseId && cp.txHash) {
          const mockTx: NormalizedTransaction = {
            chain: opts.chain,
            txHash: cp.txHash,
            blockHeight: null,
            timestamp: cp.timestamp,
            from: cp.from,
            to: cp.to,
            valueNative: cp.valueNative,
            valueUsd: cp.valueUsd,
            status: (cp.status ?? "unknown") as "confirmed" | "failed" | "pending" | "unknown",
            feeNative: "0",
            transfers: [],
            raw: {}
          };
          
          const bridgeInteraction = detectBridgeInteraction(mockTx, address);
          if (bridgeInteraction) {
            cp.kind = "bridge";
            // A bridge call is an observed transfer *into the bridge*, not a
            // transfer to wherever the funds surface next. Recording that
            // difference is what stops the graph implying a cross-ledger hop
            // the chain never made.
            pushedEdge.relationship = "bridge_crossing";
            pushedEdge.evidenceStatus = "confirmed";
            
            // Record bridge event if we have a case.
            // Only the source-side leg is observed here. The destination chain,
            // address and tx hash stay NULL until that chain is queried and the
            // two legs are matched, so a report cannot present a static bridge
            // route table as though the funds were observed arriving.
            try {
              // Uses the caller's connection rather than re-acquiring one:
              // shadowing `db` here silently ignored the transaction passed in.
              await db.query(
                `INSERT INTO bridge_events (case_id, trace_id, source_chain, source_address, source_tx_hash, destination_chain, destination_address, destination_tx_hash, candidate_destination_chains, bridge_name, bridge_contract, asset, asset_identifier, amount_native, amount_usd, status, confidence, metadata, created_at)
                 VALUES ($1,$2,$3,$4,$5,NULL,NULL,NULL,$6,$7,$8,$9,$10,$11,$12,'detected','low',$13,now())`,
                [
                  opts.persistCaseId,
                  null, // trace_id backfilled in persistTrace via backfillBridgeTraceIds
                  opts.chain,
                  address,
                  cp.txHash,
                  bridgeInteraction.bridge.destinationChains,
                  bridgeInteraction.bridge.name,
                  bridgeInteraction.bridge.address,
                  "native", // asset - could be enhanced to detect token
                  null, // asset_identifier
                  cp.valueNative,
                  cp.valueUsd,
                  JSON.stringify({
                    direction: bridgeInteraction.direction,
                    hop,
                    // Explicitly records that the destination leg is unverified.
                    destinationLegVerified: false,
                    note: "Source-side bridge contract interaction only. No destination-chain transaction was retrieved or matched."
                  })
                ]
              );
            } catch (err) {
              logger.warn("Failed to record bridge event", { error: err instanceof Error ? err.message : String(err) });
            }
          }
        }

        if (cp.kind === "bridge") bridgeCrossings++;

        // Pass-through timing: downstream hop arriving shortly after this tx.
        if (cp.timestamp) {
          const ts = Date.parse(cp.timestamp);
          for (const existing of edges) {
            if (existing.source === other && existing.timestamp) {
              const delta = (ts - Date.parse(existing.timestamp)) / 1000;
              if (delta > 0) hopIntervals.push(delta);
            }
          }
        }

        if (!visited.has(other)) {
          if (nodes.size >= maxNodes) {
            truncatedReasons.add(`Node limit of ${maxNodes} reached`);
            continue;
          }
          visited.add(other);
          // Keep the chain's own spelling for the live lookup on the next hop.
          // `other` is lower-cased graph identity; base58 and bech32 addresses
          // are case-sensitive and public explorers reject a lower-cased form.
          const canonicalOther = other === to ? cp.to : cp.from;
          canonical.set(other, canonicalOther);
          nodes.set(other, {
            id: other,
            // Graph identity stays lower-cased: `entities` has a unique key on
            // (chain, address) and every other writer stores lower-cased, so
            // writing the canonical casing here would fork the row.
            address: other,
            // The chain's own spelling, for display, copy-to-clipboard and the
            // live lookups that public explorers require.
            canonicalAddress: canonicalOther,
            chain: opts.chain,
            kind: cp.kind === "unknown" ? "unknown" : cp.kind,
            riskScore: 0,
            riskLevel: "Unrated",
            txCount: 0,
            hopDistance: hop,
            firstSeen: cp.timestamp,
            lastSeen: cp.timestamp
          });
          nextFrontier.push(other);
        }

        const node = nodes.get(address.toLowerCase());
        if (node) {
          node.txCount += 1;
          if (cp.direction === "out") node.outVolumeUsd = (node.outVolumeUsd ?? 0) + (cp.valueUsd ?? 0);
          else node.inVolumeUsd = (node.inVolumeUsd ?? 0) + (cp.valueUsd ?? 0);
        }
      }
    }

    frontier = nextFrontier;
  }

  const nodeList = [...nodes.values()];
  const knownLabels = await labelsForAddresses(db, opts.chain, nodeList.map((n) => n.address));
  const labelsByAddress = new Map<string, StoredLabel[]>();
  for (const l of knownLabels) {
    const key = l.address.toLowerCase();
    const arr = labelsByAddress.get(key) ?? [];
    arr.push(l);
    labelsByAddress.set(key, arr);
  }

  // In/out are measured relative to the root address. Counting every edge
  // twice would report the same total as both, which reads as "the root both
  // received and sent everything" and inflates the risk context.
  const rootLower = root.toLowerCase();
  const valueOutUsd = edges.reduce((s, e) => (e.source === rootLower ? s + (e.valueUsd ?? 0) : s), 0);
  const valueInUsd = edges.reduce((s, e) => (e.target === rootLower ? s + (e.valueUsd ?? 0) : s), 0);
  const counterpartyCount = new Set(edges.flatMap((e) => [e.source, e.target])).size;
  const consolidationRatio = edges.length ? counterpartyCount / Math.max(1, edges.length / 2) : null;

  const assessment = assess({
    chain: opts.chain,
    address: root,
    hopIntervals,
    consolidationRatio,
    counterpartyCount,
    totalValueUsd: valueOutUsd,
    bridgeCrossings,
    labels: knownLabels.filter((l) => l.address.toLowerCase() === root)
  });

  for (const node of nodeList) {
    const nodeLabels = labelsByAddress.get(node.address) ?? [];
    if (nodeLabels.length) {
      const nodeAssessment = assess({
        chain: opts.chain,
        address: node.address,
        hopIntervals,
        consolidationRatio,
        counterpartyCount: edges.filter((e) => e.source === node.address || e.target === node.address).length,
        totalValueUsd: valueOutUsd,
        bridgeCrossings,
        labels: nodeLabels
      });
      node.riskScore = nodeAssessment.score;
      node.riskLevel = nodeAssessment.level;
      node.factors = nodeAssessment.factors;
      node.label = nodeLabels[0]?.name;
      node.kind = nodeLabels[0]?.kind ?? node.kind;
    }

    // Determine node status based on data completeness
    const nodeEdges = edges.filter((e) => e.source === node.address || e.target === node.address);
    const hasLiveData = nodeEdges.some((e) => e.valueUsd != null && e.valueUsd > 0);
    const hasLabel = nodeLabels.length > 0;
    const isRoot = node.address.toLowerCase() === root.toLowerCase();
    const isTruncated = truncatedReasons.size > 0 && node.hopDistance >= maxHops;

    if (isRoot) {
      node.status = "verified";
    } else if (isTruncated) {
      node.status = "truncated";
      node.statusReason = "Trace stopped at max hops; downstream data unavailable";
    } else if (!nodeEdges.length) {
      node.status = "unresolved";
      node.statusReason = "No transaction edges found for this address in the trace";
    } else if (!hasLiveData && !hasLabel) {
      node.status = "unknown";
      node.statusReason = "Address discovered but no live transaction data or labels available";
    } else if (hasLiveData && !hasLabel) {
      node.status = "partial";
      node.statusReason = "Transaction data available but no attribution labels";
    } else if (hasLabel && !hasLiveData) {
      node.status = "partial";
      node.statusReason = "Attribution label available but no live transaction data";
    } else {
      node.status = "known";
    }
  }

  // Fetched here rather than next to the per-node assessments above: the
  // advisory is a network call, and paying for it before the traversal runs
  // would add its latency in front of every case even when the service is
  // disabled (in which case it returns immediately without any I/O).
  const mlAdvisory = env.riskServiceAvailable
    ? await fetchAdvisory(
        buildTraversalContext({
          chain: opts.chain,
          address: root,
          hopIntervals,
          consolidationRatio,
          counterpartyCount,
          totalValueUsd: valueOutUsd,
          bridgeCrossings,
          labels: knownLabels.filter((l) => l.address.toLowerCase() === root)
        })
      )
    : null;

  const attribution = attributeFunds({
    root,
    chain: opts.chain,
    nodes: nodeList,
    edges,
    amountToTrace,
    asset,
    method,
    direction,
    maxHops,
    demo: opts.demo === true
  });

  // Attribution is not optional decoration: it produces the `tracedAmount`,
  // `evidenceStatus`, `traceMethod`, `confidence` and `reasons` on every edge,
  // and `reconciliation` is derived from that same pass. Returning the raw edges
  // would ship a graph whose arrows disagree with its own reconciliation and
  // persist null traced amounts into the evidence lineage.
  const attributedEdges = attribution.edges;
  const attributedNodes = applyNodeAmounts(nodeList, attribution.nodeAmounts);

  const graph: TraceGraph = {
    root,
    chain: opts.chain,
    maxHops,
    direction,
    nodes: attributedNodes,
    edges: attributedEdges,
    asset,
    method,
    // Recorded so the UI can tell the investigator which question was asked.
    // `null` means the question was "where did everything go", not a missing value.
    amountToTrace,
    demo: opts.demo === true,
    ...(opts.demoCaseId ? { demoCaseId: opts.demoCaseId } : {}),
    reconciliation: attribution.reconciliation,
    totals: {
      valueInUsd: round2(valueInUsd),
      valueOutUsd: round2(valueOutUsd),
      nodeCount: attributedNodes.length,
      edgeCount: attributedEdges.length,
      truncated: truncatedReasons.size > 0,
      truncatedReasons: [...truncatedReasons]
    },
    riskScore: assessment.score,
    riskLevel: assessment.level,
    mlAdvisory,
    generatedAt: new Date().toISOString(),
    ...(notes.size ? { notes: [...notes] } : {}),
    ledger: buildFundFlowLedger({ root, chain: opts.chain, maxHops, direction, nodes: attributedNodes, edges: attributedEdges, totals: { valueInUsd: round2(valueInUsd), valueOutUsd: round2(valueOutUsd), nodeCount: attributedNodes.length, edgeCount: attributedEdges.length, truncated: truncatedReasons.size > 0, truncatedReasons: [...truncatedReasons] }, riskScore: assessment.score, riskLevel: assessment.level, generatedAt: new Date().toISOString() })
  };

  if (opts.persistCaseId) {
    // The id is attached to the graph so a caller that triggered the trace can
    // link back to the stored row — the AI apply path records it on the
    // proposal so a reviewer can see which trace their approval produced.
    const traceId = await persistTrace(db, graph, opts.persistCaseId, opts.userId ?? null);
    if (traceId) {
      graph.traceId = traceId;
      // Bridge events are written during traversal, before the trace row exists.
      // Claim the ones this traversal produced so they are reachable from the
      // trace rather than orphaned. Unscoped by tx hash: only rows still NULL
      // are touched, and a NULL trace_id is by definition unclaimed.
      await db.query(
        `UPDATE bridge_events SET trace_id = $1
         WHERE case_id = $2 AND trace_id IS NULL AND source_chain = $3`,
        [traceId, opts.persistCaseId, opts.chain]
      );
      // Record graph edges in the evidence lineage.
      for (const edge of graph.edges) {
        await recordGraphEdge(db, {
          traceId,
          caseId: opts.persistCaseId,
          source: edge.source,
          target: edge.target,
          txHash: edge.txHash,
          timestamp: edge.timestamp,
          valueNative: edge.valueNative,
          valueUsd: edge.valueUsd,
          // The edge's own asset, not a hardcoded "native": a token transfer
          // persisted as "native" is indistinguishable from a chain-native one.
          asset: edge.asset,
          assetIdentifier: null,
          decimals: 18,
          normalizedEventId: null,
          providerResponseId: edge.providerResponseId ?? null,
          // Attribution runs before persistence, so these are the final evidence
          // values rather than the observation-layer defaults.
          observedAmount: edge.observedAmount,
          tracedAmount: edge.tracedAmount,
          relationship: edge.relationship,
          evidenceStatus: edge.evidenceStatus,
          traceMethod: edge.traceMethod,
          confidence: edge.confidence,
          evidenceSource: edge.evidenceSource,
          evidenceReasons: edge.reasons
        });
      }
    }
  }
  await persistEntities(db, opts.chain, graph, opts.persistCaseId ?? null);

  return graph;
}

interface CounterpartyEdge {
  from: string;
  to: string;
  txHash: string;
  timestamp: string | null;
  valueNative: string;
  valueUsd: number | null;
  status: string;
  kind: string;
  direction: "in" | "out";
  /** Provider response ID from live lookup, for evidence lineage. */
  providerResponseId?: string;
  /** What kind of movement this leg represents. */
  relationship: EdgeRelationship;
  /** Observation-layer evidence strength, before any attribution. */
  evidenceStatus: EvidenceStatus;
  /** Where the observation came from. */
  source: GraphEdge["evidenceSource"];
  /**
   * Network fee the sender paid on this transaction, when this leg is the
   * sender's. Carried for reconciliation rather than drawn as a leg: see
   * `GraphEdge.feeNative`.
   */
  feeNative?: string;
}

async function resolveCounterparties(
  db: Db,
  opts: TraceOptions,
  address: string,
  direction: "forward" | "backward" | "both",
  deadline: number,
  /** Address as the chain spells it; `address` is the lower-cased graph key. */
  lookupAddress: string,
  maxCounterpartiesPerTx: number,
  maxStoredTxsPerAddress: number
): Promise<{ edges: CounterpartyEdge[]; truncated: boolean; reason?: string; note?: string }> {
  // Local store first: already-ingested data costs no upstream calls.
  const stored = await many<{ from_address: string; to_address: string; tx_hash: string; timestamp: string | null; value_usd: string | null; value_native: string | null; status: string | null }>(
    db,
    `SELECT from_address, to_address, tx_hash, timestamp, value_usd, value_native, status
     FROM transactions
     WHERE chain = $1 AND (from_address = $2 OR to_address = $2)
     ORDER BY timestamp DESC NULLS LAST
     LIMIT $3`,
    [opts.chain, address.toLowerCase(), maxStoredTxsPerAddress]
  );

  const edges: CounterpartyEdge[] = stored
    .filter((t) => t.from_address && t.to_address)
    .map((t) => {
      const isOut = t.from_address?.toLowerCase() === address.toLowerCase();
      return {
        from: t.from_address!,
        to: t.to_address!,
        txHash: t.tx_hash,
        timestamp: t.timestamp,
        valueNative: t.value_native ?? "0",
        valueUsd: t.value_usd != null ? Number(t.value_usd) : null,
        status: t.status ?? "unknown",
        kind: "unknown",
        direction: (isOut ? "out" : "in") as "in" | "out",
        // A row in `transactions` is a normalised record of something the chain
        // reported. It is our own copy though, so it is marked `derived`
        // rather than `confirmed`: the distinction is provenance, not doubt
        // about the chain.
        relationship: "direct_transfer" as const,
        evidenceStatus: "derived" as const,
        source: "stored" as const
      };
    })
    .filter((e) => (direction === "both" ? true : e.direction === (direction === "forward" ? "out" : "in")));

  // If offline mode or deadline approaching, return what we have.
  if (opts.offline || Date.now() > deadline - 2000) {
    return { edges, truncated: edges.length >= maxStoredTxsPerAddress, reason: "Stored transaction limit reached" };
  }

  // Enrich with live data if available, even if we have local edges.
  // This fills gaps where the local store doesn't have full history.
  try {
    const adapter = adapterFor(opts.chain);
    const page = await adapter.getTransactionsForAddress(lookupAddress, { limit: 50 });
    if (!page.transactions.length) {
      return {
        edges,
        truncated: false,
        note: `No live counterparties were returned for ${lookupAddress}. ${
          opts.chain === "ethereum"
            ? "Ethereum address history needs an indexer: set ETHERSCAN_API_KEY. Balance and nonce are still accurate."
            : "Either the address has no public history, or the upstream explorer did not answer."
        }`
      };
    }
    // Record provider responses and normalized events for live transactions,
    // so each edge can be linked back to its evidence.
    const providerResponseByTx = new Map<string, string>();
    if (opts.persistCaseId) {
      const db = await getDb();
      for (const tx of page.transactions) {
        const chainId = await recordProviderResponse(db, {
          chain: opts.chain,
          requestType: "transactions_for_address",
          requestParams: { address: lookupAddress, limit: 50 },
          responseData: tx.raw,
          provider: adapterFor(opts.chain).constructor.name,
          latencyMs: 0, // not tracked per-tx here
          success: true,
          error: null,
          caseId: opts.persistCaseId
        });
        // chainId is the lineage chain ID (equals provider response ID)
        await recordNormalizedEvent(db, {
          providerResponseId: chainId,
          eventType: "transaction",
          chain: opts.chain,
          normalizedData: {
            txHash: tx.txHash,
            blockHeight: tx.blockHeight,
            timestamp: tx.timestamp,
            from: tx.from,
            to: tx.to,
            valueNative: tx.valueNative,
            valueUsd: tx.valueUsd,
            status: tx.status,
            feeNative: tx.feeNative,
            transfers: tx.transfers
          },
          caseId: opts.persistCaseId
        });
        providerResponseByTx.set(tx.txHash, chainId);
      }
    }

    const liveEdges: CounterpartyEdge[] = [];
    for (const tx of page.transactions) {
      // One busy address can hold thousands of transactions and each one costs a
      // separate upstream round trip. The per-tx loop is the only place the
      // deadline can still be enforced while that work is in flight, so check it
      // here as well: without this, a single address overran the caller's whole
      // budget and the request was still running long after it had been abandoned.
      if (Date.now() > deadline) {
        return {
          edges: [...mergedWithLive(edges, liveEdges)],
          truncated: true,
          reason: `Wall-clock limit reached while expanding ${lookupAddress}`,
          note: `Live expansion of ${lookupAddress} stopped early at the time limit. Stored and already-resolved records are included.`
        };
      }
      const providerResponseId = providerResponseByTx.get(tx.txHash);
      liveEdges.push(...liveEdgesFor(tx, address, direction, maxCounterpartiesPerTx, providerResponseId));
    }

    // Merge: prefer live edges for value accuracy, but keep local edges that live didn't return.
    // Key by txHash + from + to to deduplicate.
    return { edges: mergedWithLive(edges, liveEdges), truncated: liveEdges.length >= 50 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Live counterparty fetch failed; graph limited to stored records", {
      chain: opts.chain,
      address,
      lookupAddress,
      error: message
    });
    return { edges, truncated: false, note: `Live lookup failed: ${message}` };
  }
}

/**
 * Merge stored edges with live ones, keyed by tx + from + to so a record seen
 * twice collapses. Live wins: its values come from the chain rather than from a
 * possibly stale local copy.
 */
function mergedWithLive(stored: CounterpartyEdge[], live: CounterpartyEdge[]): CounterpartyEdge[] {
  const merged = new Map<string, CounterpartyEdge>();
  for (const e of stored) merged.set(`${e.txHash}:${e.from.toLowerCase()}:${e.to.toLowerCase()}`, e);
  for (const e of live) merged.set(`${e.txHash}:${e.from.toLowerCase()}:${e.to.toLowerCase()}`, e);
  return [...merged.values()];
}

/** Counterparties expanded per transaction, so one busy address cannot swamp the graph. */function liveEdgesFor(
  tx: NormalizedTransaction,
  address: string,
  direction: TraceOptions["direction"],
  maxCounterpartiesPerTx: number,
  providerResponseId?: string
): CounterpartyEdge[] {
  const target = address.toLowerCase();
  const legs = tx.transfers ?? [];
  const paired = legs.filter((l) => l.from && l.to);
  const inputs = legs.filter((l) => l.from && !l.to);
  const outputs = legs.filter((l) => l.to && !l.from);

  const wanted = (dir: "in" | "out"): boolean =>
    direction === "both" || (direction === "forward" ? dir === "out" : dir === "in");

  const edges: CounterpartyEdge[] = [];
  const seen = new Set<string>();
  const push = (
    from: string,
    to: string,
    dir: "in" | "out",
    valueNative: string,
    relationship: EdgeRelationship,
    evidenceStatus: EvidenceStatus
  ): void => {
    if (!wanted(dir)) return;
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    if (f === t) return;
    const key = `${f}->${t}:${tx.txHash}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      // Upstream spelling is preserved so the next hop can look the address up;
      // the caller lower-cases for graph identity.
      from,
      to,
      txHash: tx.txHash,
      timestamp: tx.timestamp,
      valueNative,
      valueUsd: tx.valueUsd,
      status: tx.status,
      kind: "unknown",
      direction: dir,
      providerResponseId,
      relationship,
      evidenceStatus,
      source: "on_chain",
      // Only the sender pays the fee, and only a sender's leg can be asked to
      // account for it. An inbound leg carrying the sender's fee would credit
      // gas the traced funds did not spend.
      ...(dir === "out" && toNumber(tx.feeNative ?? "0") > 0 && tx.feeNative != null
        ? { feeNative: tx.feeNative }
        : {})
    });
  };

  // For UTXO (Bitcoin): pair inputs -> outputs. If we're the sender, we control the inputs;
  // pair our inputs to all outputs. If we're a receiver, pair all inputs to our output.
  // For account-based (EVM/Tron): use transfers directly.
  const isUtxo = tx.chain === "bitcoin";

  if (isUtxo) {
    // UTXO: find all inputs and outputs. The traced address appears in inputs (spending)
    // or outputs (receiving).
    const ourInputs = inputs.filter((l) => l.from!.toLowerCase() === target);
    const ourOutputs = outputs.filter((l) => l.to!.toLowerCase() === target);

    // Spending: our inputs -> all outputs.
    //
    // An input→output pairing is not a transfer the chain recorded between the
    // two addresses. Bitcoin commits to the whole transaction, so which input
    // funded which output is a construction decision, not an observation. These
    // edges are therefore `derived`, which is exactly the distinction an
    // investigator needs before treating one as a payment.
    if (ourInputs.length > 0) {
      const outLegs = outputs.length ? outputs : paired;
      for (const leg of outLegs.slice(0, maxCounterpartiesPerTx)) {
        push(target, leg.to!, "out", leg.amount, "direct_transfer", "derived");
      }
    }

    // Receiving: all inputs -> our outputs
    if (ourOutputs.length > 0) {
      const inLegs = inputs.length ? inputs : paired;
      for (const leg of inLegs.slice(0, maxCounterpartiesPerTx)) {
        push(leg.from!, target, "in", leg.amount, "direct_transfer", "derived");
      }
    }
  } else {
    // Account-based: use transfers directly (EVM/Tron token transfers)
    const ourSends = paired.filter((l) => l.from!.toLowerCase() === target);
    const ourReceives = paired.filter((l) => l.to!.toLowerCase() === target);

    // A leg carrying the chain's native value is a direct transfer. Anything the
    // normalised leg marks as a token is a token transfer, and a call to a
    // contract that moved no value is a contract interaction — the case this
    // whole distinction exists for.
    const classify = (leg: NormalizedTransfer): { relationship: EdgeRelationship; status: EvidenceStatus } => {
      if (leg.kind === "token") return { relationship: "token_transfer", status: "confirmed" };
      if (toNumber(leg.amount) <= 0) return { relationship: "contract_interaction", status: "confirmed" };
      return { relationship: "direct_transfer", status: "confirmed" };
    };

    for (const leg of ourSends.slice(0, maxCounterpartiesPerTx)) {
      const c = classify(leg);
      push(leg.from!, leg.to!, "out", leg.amount, c.relationship, c.status);
    }
    for (const leg of ourReceives.slice(0, maxCounterpartiesPerTx)) {
      const c = classify(leg);
      push(leg.from!, leg.to!, "in", leg.amount, c.relationship, c.status);
    }
  }

  if (!edges.length && tx.from && tx.to) {
    push(
      tx.from,
      tx.to,
      tx.from.toLowerCase() === target ? "out" : "in",
      tx.valueNative,
      "direct_transfer",
      // A top-level from→to with no transfer detail is the adapter's fallback
      // reading of a whole transaction, so it is the chain's record but not a
      // leg we can attribute to.
      "derived"
    );
  }

  return edges;
}

async function persistEntities(db: Db, chain: Chain, graph: TraceGraph, caseId: string | null): Promise<void> {
  for (const node of graph.nodes) {
    await db.query(
      `INSERT INTO entities (chain, address, kind, label, risk_score, risk_level, risk_factors, first_seen, last_seen, tx_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (chain, address) DO UPDATE SET
         risk_score = EXCLUDED.risk_score,
         risk_level = EXCLUDED.risk_level,
         risk_factors = EXCLUDED.risk_factors,
         kind = CASE WHEN entities.kind = 'unknown' THEN EXCLUDED.kind ELSE entities.kind END,
         label = COALESCE(EXCLUDED.label, entities.label),
         first_seen = LEAST(COALESCE(entities.first_seen, EXCLUDED.first_seen), COALESCE(EXCLUDED.first_seen, entities.first_seen)),
         last_seen = GREATEST(COALESCE(entities.last_seen, EXCLUDED.last_seen), COALESCE(EXCLUDED.last_seen, entities.last_seen)),
         tx_count = GREATEST(entities.tx_count, EXCLUDED.tx_count)`,
      [
        chain,
        node.address,
        node.kind,
        node.label ?? null,
        node.riskScore,
        node.riskLevel,
        JSON.stringify(node.factors ?? []),
        node.firstSeen ?? null,
        node.lastSeen ?? null,
        node.txCount
      ]
    );
  }

  // Persist trace-scoped graph nodes (for SQL-queryable trace graphs)
  if (graph.traceId && caseId) {
    for (const node of graph.nodes) {
      await db.query(
        `INSERT INTO graph_nodes (trace_id, case_id, address, chain, kind, label, risk_score, risk_level,
          first_seen, last_seen, tx_count, in_volume_usd, out_volume_usd, hop_distance, asset, status, status_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          graph.traceId,
          caseId,
          node.address,
          chain,
          node.kind,
          node.label ?? null,
          node.riskScore,
          node.riskLevel,
          node.firstSeen ?? null,
          node.lastSeen ?? null,
          node.txCount,
          node.inVolumeUsd ?? null,
          node.outVolumeUsd ?? null,
          node.hopDistance,
          "native",
          node.status ?? "known",
          node.statusReason ?? null
        ]
      );
    }
  }

  if (!caseId) return;

  await db.transaction(async (tx) => {
    for (const node of graph.nodes) {
      const stored = await one<{ id: string }>(tx, `SELECT id FROM entities WHERE chain = $1 AND address = $2`, [chain, node.address]);
      if (!stored) continue;
      await tx.query(
        `INSERT INTO case_entities (case_id, entity_id, hop_count, amount_usd) VALUES ($1,$2,$3,$4)
         ON CONFLICT (case_id, entity_id) DO UPDATE SET hop_count = LEAST(case_entities.hop_count, EXCLUDED.hop_count)`,
        [caseId, stored.id, node.hopDistance, node.outVolumeUsd ?? 0]
      );
    }
  });
}

/** Returns the stored row's id, or null when the insert returned nothing. */
async function persistTrace(
  db: Db,
  graph: TraceGraph,
  caseId: string,
  userId: string | null
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO traces (case_id, chain, root_address, max_hops, direction, node_count, edge_count, total_usd, risk_score, risk_level, graph, truncated_reasons, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      caseId,
      graph.chain,
      graph.root,
      graph.maxHops,
      graph.direction,
      graph.totals.nodeCount,
      graph.totals.edgeCount,
      graph.totals.valueOutUsd,
      graph.riskScore,
      graph.riskLevel,
      JSON.stringify(graph),
      // Persisted as its own column so the API and PDF report can disclose
      // that this graph hit a bound. Computed in-memory only, it previously
      // never reached the database and both readers saw NULL forever.
      graph.totals.truncatedReasons.length > 0 ? graph.totals.truncatedReasons : null,
      userId
    ]
  );
  return rows[0]?.id ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { detect, persistTrace };
