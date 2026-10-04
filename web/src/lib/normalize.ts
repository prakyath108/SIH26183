import type { GraphEdge, GraphNode, NormalizedTransaction, StoredTransactionRow, TraceGraph } from "../types";

/**
 * Bridges the two transaction shapes the API can return.
 *
 * `/chain/lookup` and the live branch of `/chain/transaction/:hash` hand back a
 * normalized object (camelCase). The cache branch of `/chain/transaction/:hash`
 * and `/chain/address/:chain/:address/transactions` with `source: "store"` hand
 * back raw database rows (snake_case, numerics as strings). The UI should not
 * have to care, so everything is funnelled through here.
 */
export function normalizeTxRow(row: StoredTransactionRow | NormalizedTransaction): NormalizedTransaction {
  if ("txHash" in row) return row;
  return {
    chain: row.chain,
    txHash: row.tx_hash,
    blockHeight: row.block_height === null ? null : Number(row.block_height),
    timestamp: row.timestamp,
    from: row.from_address,
    to: row.to_address,
    valueNative: row.value_native ?? "0",
    valueUsd: row.value_usd === null ? null : Number(row.value_usd),
    status: (row.status ?? "unknown") as NormalizedTransaction["status"],
    feeNative: row.fee_native
  };
}

export function isStoredRow(row: StoredTransactionRow | NormalizedTransaction): row is StoredTransactionRow {
  return "tx_hash" in row;
}

/** Hop distance from the root, used both by the layout and the legend. */
export function maxHop(graph: TraceGraph): number {
  return graph.nodes.reduce((m, n) => Math.max(m, n.hopDistance), 0);
}

export function neighbours(graph: TraceGraph, nodeId: string): GraphNode[] {
  const ids = new Set<string>();
  for (const e of graph.edges) {
    if (e.source === nodeId) ids.add(e.target);
    if (e.target === nodeId) ids.add(e.source);
  }
  return graph.nodes.filter((n) => ids.has(n.id));
}

export function edgesFor(graph: TraceGraph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.source === nodeId || e.target === nodeId);
}

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
}

export interface Layout {
  nodes: LayoutNode[];
  width: number;
  height: number;
  /** Left inset, kept equal on every row so columns line up. */
  colWidth: number;
  rowHeight: number;
}

const NODE_W = 190;
// Tall enough for four lines: address, label, chain/risk, and the share of the
// investigated quantity that reached this address.
const NODE_H = 78;
const GAP_X = 96;
const GAP_Y = 18;
const PAD = 28;

/**
 * Barycentre layering: group by hop distance, then order each column by the
 * mean position of the already-placed nodes it connects to. Cheap, stable, and
 * good enough for the bounded graphs the tracer produces. A full Sugiyama pass
 * would be overkill and would not survive a re-layout any better on screen.
 */
export function layoutGraph(graph: TraceGraph): Layout {
  const byHop = new Map<number, GraphNode[]>();
  for (const n of graph.nodes) {
    const list = byHop.get(n.hopDistance) ?? [];
    list.push(n);
    byHop.set(n.hopDistance, list);
  }
  const hops = [...byHop.keys()].sort((a, b) => a - b);

  const indexInCol = new Map<string, number>();
  const placed: LayoutNode[] = [];

  for (const hop of hops) {
    const column = (byHop.get(hop) ?? []).slice().sort((a, b) => {
      const ka = graph.edges
        .filter((e) => e.target === a.id || e.source === a.id)
        .map((e) => indexInCol.get(e.source === a.id ? e.target : e.source))
        .filter((v): v is number => v !== undefined);
      const kb = graph.edges
        .filter((e) => e.target === b.id || e.source === b.id)
        .map((e) => indexInCol.get(e.source === b.id ? e.target : e.source))
        .filter((v): v is number => v !== undefined);
      const sa = ka.length ? ka.reduce((s, v) => s + v, 0) / ka.length : Number.MAX_SAFE_INTEGER;
      const sb = kb.length ? kb.reduce((s, v) => s + v, 0) / kb.length : Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      // Deterministic tiebreak, so a re-render never reshuffles the view.
      return b.riskScore - a.riskScore || a.address.localeCompare(b.address);
    });

    column.forEach((n, i) => {
      indexInCol.set(n.id, i);
      placed.push({ ...n, x: 0, y: 0 });
    });
  }

  const tallest = Math.max(1, ...hops.map((h) => (byHop.get(h) ?? []).length));
  const colWidth = NODE_W + GAP_X;
  const rowHeight = NODE_H + GAP_Y;
  const width = PAD * 2 + hops.length * colWidth - GAP_X;
  const height = PAD * 2 + tallest * rowHeight - GAP_Y;

  // Centre each column against the tallest one so the graph reads as a block.
  for (const hop of hops) {
    const column = (byHop.get(hop) ?? []).map((n) => placed.find((p) => p.id === n.id)!);
    const offset = (tallest - column.length) / 2;
    column.forEach((n, i) => {
      n.x = PAD + hops.indexOf(hop) * colWidth;
      n.y = PAD + (i + offset) * rowHeight;
    });
  }

  return { nodes: placed, width, height, colWidth, rowHeight };
}

export const NODE_WIDTH = NODE_W;
export const NODE_HEIGHT = NODE_H;
