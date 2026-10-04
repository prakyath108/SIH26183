import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Chain,
  EdgeRelationship,
  EvidenceReason,
  EvidenceStatus,
  GraphEdge,
  GraphNode,
  RiskFactor,
  RiskLevel,
  TraceGraph,
  TraceMethod
} from "../types.js";
import { applyNodeAmounts, attributeFunds } from "./attribution.js";

/**
 * Synthetic investigation cases, authored as data rather than code.
 *
 * Every address, transaction, amount and score under `demo/` is invented. The
 * point is to let an investigator learn what each attribution method does, and
 * what each evidence status means, without touching a real wallet and without
 * implying that a fabricated chain is a finding.
 *
 * Four rules are enforced by construction rather than by convention:
 *
 *  1. Every address starts `0xdead`, so a demo address is recognisable in a
 *     screenshot or a copied report as unmistakably not a real wallet.
 *  2. The demo ledger is data, so it can be reviewed as data. `loadDemoData`
 *     fails loudly on a dangling wallet reference or a malformed amount rather
 *     than silently rendering a graph with a hole in it.
 *  3. Hop distances are derived from the ledger, never hand-written, so a
 *     transaction cannot claim to be a hop it is not.
 *  4. Each case is built by handing ordinary edges to the same `attributeFunds`
 *     the live tracer uses. There is no separate demo code path, so a demo
 *     cannot display a figure the real tracer would disagree with.
 */

/* ------------------------------------------------------------------ *
 * Authored data files
 * ------------------------------------------------------------------ */

interface DemoEntityFile {
  id: string;
  type: string;
  name: string;
  riskLevel: RiskLevel;
  riskScore: number;
  indicators?: string[];
}

interface DemoWalletFile {
  tag: number;
  role: string;
  kind: string;
  label: string;
  chain: Chain;
  entity?: string;
  riskLevel: RiskLevel;
  riskScore: number;
  riskIndicators?: string[];
}

export interface DemoCaseSummary {
  id: string;
  /** Judge-facing reference, e.g. `CT-DEMO-001`. Absent on method-teaching cases. */
  caseRef?: string;
  name: string;
  /** One line: what an investigator is meant to learn from this case. */
  teaches: string;
  chain: Chain;
  rootAddress: string;
  /** Suggested quantity to trace, as a decimal string. */
  amount: string;
  asset: string;
  /** Method that best shows this case's behaviour. */
  suggestedMethod: TraceMethod;
  /** Expected reconciliation status, shown before the case is opened. */
  expectedOutcome: "reconciled" | "partial" | "unresolved" | "over_attributed";
  /** Hop budget the case was authored for. */
  maxHops: number;
  /** Whether this is the case to lead with. */
  headline?: boolean;
}

interface DemoCaseFile {
  id: string;
  caseRef?: string;
  name: string;
  teaches: string;
  chain: Chain;
  root: string;
  amount: string;
  asset: string;
  suggestedMethod: TraceMethod;
  expectedOutcome: DemoCaseSummary["expectedOutcome"];
  maxHops: number;
  headline?: boolean;
}

interface DemoTxFile {
  id: string;
  case: string;
  from: string;
  to: string;
  asset: string;
  amount: string;
  type: EdgeRelationship;
  evidenceStatus: EvidenceStatus;
  confidence: number;
  timestamp: string;
  block: number;
  txTag: number;
  note?: string;
  reasons?: EvidenceReason[];
}

const DEMO_NOTE =
  "SIMULATED DATA. Every address, transaction hash, amount and score in this graph is synthetic and exists only to show the tracing engine.";
const DEMO_FACTOR_DETAIL =
  "Synthetic indicator authored for this scenario. It is not an independent assessment and must not be cited as a finding.";
const DEMO_OBSERVED_AT = "2026-02-14T00:00:00.000Z";

/**
 * Locate the authored data. `HERE` is `src/trace` under tsx and `dist/trace`
 * after a build, and the build copies `demo/` alongside the module, so the first
 * candidate normally wins. The second keeps the loader working if the copy step
 * was ever skipped.
 */
function resolveDemoDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "demo"), join(here, "..", "..", "src", "trace", "demo")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "cases.json"))) return candidate;
  }
  throw new Error(`Demo data not found. Looked in: ${candidates.join(", ")}`);
}

function readDemoFile<T>(name: string): T {
  return JSON.parse(readFileSync(join(resolveDemoDir(), name), "utf8")) as T;
}

const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

function assertAmount(value: string, where: string): string {
  if (!AMOUNT_PATTERN.test(value)) {
    throw new Error(`Demo data: ${where} has a non-numeric amount '${value}'.`);
  }
  return value;
}

interface DemoData {
  entities: Map<string, DemoEntityFile>;
  wallets: Map<string, DemoWalletFile>;
  cases: DemoCaseFile[];
  transactionsByCase: Map<string, DemoTxFile[]>;
}

let cached: DemoData | null = null;

/** Load and cross-check the authored ledger once per process. */
function loadDemoData(): DemoData {
  if (cached) return cached;

  const entities = new Map<string, DemoEntityFile>();
  for (const entity of readDemoFile<DemoEntityFile[]>("entities.json")) {
    entities.set(entity.id, entity);
  }

  const wallets = new Map<string, DemoWalletFile>();
  const addresses = new Map<number, string>();
  for (const [id, wallet] of Object.entries(readDemoFile<Record<string, DemoWalletFile>>("wallets.json"))) {
    wallets.set(id, wallet);
    // Two wallet ids sharing an address tag would silently merge two actors in
    // a screenshot, which is exactly the confusion a demo must not create.
    const existing = addresses.get(wallet.tag);
    if (existing && existing !== id) {
      throw new Error(`Demo data: wallets ${existing} and ${id} share address tag ${wallet.tag}.`);
    }
    addresses.set(wallet.tag, id);
  }

  const cases = readDemoFile<DemoCaseFile[]>("cases.json");
  const caseIds = new Set<string>();
  for (const c of cases) {
    if (caseIds.has(c.id)) throw new Error(`Demo data: duplicate case id '${c.id}'.`);
    caseIds.add(c.id);
    assertAmount(c.amount, `case '${c.id}'`);
    if (!wallets.has(c.root)) throw new Error(`Demo data: case '${c.id}' has unknown root '${c.root}'.`);
  }

  const transactionsByCase = new Map<string, DemoTxFile[]>();
  const txIds = new Set<string>();
  for (const tx of readDemoFile<DemoTxFile[]>("transactions.json")) {
    if (txIds.has(tx.id)) throw new Error(`Demo data: duplicate transaction id '${tx.id}'.`);
    txIds.add(tx.id);
    if (!caseIds.has(tx.case)) throw new Error(`Demo data: transaction '${tx.id}' names unknown case '${tx.case}'.`);
    for (const ref of [tx.from, tx.to]) {
      if (!wallets.has(ref)) throw new Error(`Demo data: transaction '${tx.id}' references unknown wallet '${ref}'.`);
    }
    assertAmount(tx.amount, `transaction '${tx.id}'`);
    const bucket = transactionsByCase.get(tx.case);
    if (bucket) bucket.push(tx);
    else transactionsByCase.set(tx.case, [tx]);
  }
  for (const c of cases) {
    if (!transactionsByCase.has(c.id)) throw new Error(`Demo data: case '${c.id}' has no transactions.`);
  }

  cached = { entities, wallets, cases, transactionsByCase };
  return cached;
}

/* ------------------------------------------------------------------ *
 * Deterministic, obviously-fake identifiers. Not valid on any real network.
 * ------------------------------------------------------------------ */

function addr(tag: number): string {
  return `0xdead${tag.toString(16).padStart(4, "0").toLowerCase()}00000000000000000000000000000000`;
}

function txHash(tag: number): string {
  return `0xdead${tag.toString(16).padStart(4, "0")}${"0".repeat(56)}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/* ------------------------------------------------------------------ *
 * Graph construction
 * ------------------------------------------------------------------ */

/**
 * Longest-path hop distance from the root.
 *
 * Shortest-path would be the obvious choice, but a fund-flow graph routinely
 * reconverges: in `fund-splitting` both branches reach the exchange. Under
 * shortest-path the exchange lands on the same layer as its own predecessor, so
 * the headline route reads as one hop shorter than it is. Longest-path keeps
 * every edge pointing forward and the primary route readable, at the cost of a
 * converging leg spanning more than one layer, which the layout renders as a
 * longer arrow. Bounded by `passes` and the hop cap so a cyclic ledger cannot
 * loop.
 */
function assignHops(root: string, edges: DemoTxFile[], maxHops: number, nodeCount: number): Map<string, number> {
  const hop = new Map<string, number>([[root, 0]]);
  const passes = Math.min(nodeCount + 1, 64);
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const edge of edges) {
      // Never walk back into the root: an inbound leg does not shorten a
      // forward trace.
      if (edge.to === root) continue;
      const from = hop.get(edge.from);
      if (from === undefined) continue;
      const next = Math.min(from + 1, maxHops);
      const current = hop.get(edge.to);
      if (current === undefined || next > current) {
        hop.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return hop;
}

function demoFactors(
  wallet: DemoWalletFile,
  entity: DemoEntityFile | undefined
): RiskFactor[] {
  const indicators = [...(wallet.riskIndicators ?? []), ...(entity?.indicators ?? [])];
  return indicators.map((text) => ({
    code: slug(text),
    label: text,
    weight: wallet.riskScore >= 70 ? 0.8 : 0.5,
    confidence: 0.5,
    detail: DEMO_FACTOR_DETAIL,
    source: "demo",
    observedAt: DEMO_OBSERVED_AT,
    evidence: []
  }));
}

/** Build the trace graph for one demo case, running the real attribution engine. */
export function buildDemoGraph(
  caseId: string,
  method?: TraceMethod,
  amountToTrace?: string
): TraceGraph | null {
  const data = loadDemoData();
  const spec = data.cases.find((c) => c.id === caseId);
  if (!spec) return null;

  const txs = data.transactionsByCase.get(spec.id) ?? [];
  const rootAddress = addr(requireWallet(data, spec.root).tag);

  const involved = new Set<string>([spec.root]);
  for (const tx of txs) {
    involved.add(tx.from);
    involved.add(tx.to);
  }

  const hopByWallet = assignHops(spec.root, txs, spec.maxHops, involved.size);
  const hopByAddress = new Map<string, number>();
  for (const walletId of involved) {
    const wallet = requireWallet(data, walletId);
    hopByAddress.set(addr(wallet.tag), hopByWallet.get(walletId) ?? 0);
  }

  const order = [...involved];
  const nodes: GraphNode[] = order
    .map((walletId, index) => ({ walletId, wallet: requireWallet(data, walletId), index }))
    .sort((a, b) => {
      const hopDelta = (hopByWallet.get(a.walletId) ?? 0) - (hopByWallet.get(b.walletId) ?? 0);
      return hopDelta !== 0 ? hopDelta : a.index - b.index;
    })
    .map(({ walletId, wallet }) => {
      const address = addr(wallet.tag);
      const touching = txs.filter((t) => t.from === walletId || t.to === walletId);
      const times = touching.map((t) => t.timestamp).sort();
      return {
        id: address,
        address,
        canonicalAddress: address,
        chain: wallet.chain,
        kind: wallet.kind,
        label: wallet.label,
        riskScore: wallet.riskScore,
        riskLevel: wallet.riskLevel,
        txCount: touching.length,
        hopDistance: hopByAddress.get(address) ?? 0,
        factors: demoFactors(wallet, wallet.entity ? data.entities.get(wallet.entity) : undefined),
        firstSeen: times[0] ?? null,
        lastSeen: times[times.length - 1] ?? null
      } satisfies GraphNode;
    });

  const noteByEdgeId = new Map<string, string>();
  const rawEdges: GraphEdge[] = txs.map((tx, i) => {
    const id = `d${i + 1}`;
    if (tx.note) noteByEdgeId.set(id, tx.note);
    return {
      id,
      source: addr(requireWallet(data, tx.from).tag),
      target: addr(requireWallet(data, tx.to).tag),
      txHash: txHash(tx.txTag),
      timestamp: tx.timestamp,
      valueNative: tx.amount,
      valueUsd: null,
      status: "confirmed",
      hop: hopByAddress.get(addr(requireWallet(data, tx.from).tag)) ?? 0,
      asset: tx.asset,
      observedAmount: tx.amount,
      tracedAmount: null,
      relationship: tx.type,
      evidenceStatus: tx.evidenceStatus,
      traceMethod: null,
      confidence: tx.confidence,
      // Marks the provenance as fabricated, separately from the demo flag.
      evidenceSource: "demo",
      blockNumber: tx.block,
      reasons: tx.reasons ?? []
    };
  });

  const chosenMethod = method ?? spec.suggestedMethod;
  // An investigator-supplied quantity replaces the authored suggestion, so the
  // demo answers the question actually asked rather than the one we wrote down.
  const quantity = amountToTrace ? assertAmount(amountToTrace, `trace request for '${spec.id}'`) : spec.amount;

  const result = attributeFunds({
    root: rootAddress,
    chain: spec.chain,
    nodes,
    edges: rawEdges,
    amountToTrace: quantity,
    asset: spec.asset,
    method: chosenMethod,
    direction: "forward",
    maxHops: spec.maxHops,
    demo: true
  });

  // Authored scenario commentary is appended after attribution, because
  // attribution rewrites `reasons` on any edge it apportions and would otherwise
  // discard it.
  const edges = result.edges.map((edge) => {
    const note = noteByEdgeId.get(edge.id);
    if (!note || edge.reasons.some((r) => r.code === "demo_context")) return edge;
    return {
      ...edge,
      reasons: [...edge.reasons, { code: "demo_context", detail: note, weight: "supports" as const }]
    };
  });

  const locatedNodes = applyNodeAmounts(nodes, result.nodeAmounts);

  // Graph-level risk is the riskiest actor in the graph, not the root. In the
  // SIH cases the root is the victim, so grading the graph by the root would
  // headline a low-risk wallet.
  const riskiest = locatedNodes.reduce<GraphNode | null>(
    (best, n) => (best === null || n.riskScore > best.riskScore ? n : best),
    null
  );

  return {
    root: rootAddress,
    chain: spec.chain,
    maxHops: spec.maxHops,
    direction: "forward",
    nodes: locatedNodes,
    edges,
    asset: spec.asset,
    method: chosenMethod,
    amountToTrace: quantity,
    demo: true,
    demoCaseId: spec.id,
    reconciliation: result.reconciliation,
    totals: {
      valueInUsd: 0,
      valueOutUsd: 0,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      truncated: false,
      truncatedReasons: []
    },
    riskScore: riskiest?.riskScore ?? 0,
    riskLevel: riskiest?.riskLevel ?? "Unrated",
    mlAdvisory: null,
    generatedAt: new Date().toISOString(),
    notes: [
      DEMO_NOTE,
      spec.caseRef ? `${spec.caseRef}: ${spec.teaches}` : spec.teaches
    ]
  };
}

function requireWallet(data: DemoData, walletId: string): DemoWalletFile {
  const wallet = data.wallets.get(walletId);
  if (!wallet) throw new Error(`Demo data: unknown wallet '${walletId}'.`);
  return wallet;
}

/** Catalogue for the UI's demo picker. Contains no amounts beyond the suggestions. */
export function listDemoCases(): DemoCaseSummary[] {
  const data = loadDemoData();
  return data.cases.map((c) => ({
    id: c.id,
    caseRef: c.caseRef,
    name: c.name,
    teaches: c.teaches,
    chain: c.chain,
    rootAddress: addr(requireWallet(data, c.root).tag),
    amount: c.amount,
    asset: c.asset,
    suggestedMethod: c.suggestedMethod,
    expectedOutcome: c.expectedOutcome,
    maxHops: c.maxHops,
    headline: c.headline
  }));
}
