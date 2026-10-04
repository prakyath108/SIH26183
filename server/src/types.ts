export type UserRole = "admin" | "investigator" | "analyst" | "viewer";
export type CaseStatus = "Open" | "In Progress" | "Under Review" | "Escalated" | "Closed";
export type RiskLevel = "Critical" | "High" | "Medium" | "Low" | "Unrated";
export type Chain = "bitcoin" | "ethereum" | "tron" | "polygon" | "unknown";

/**
 * ML service second opinion, attached to root assessments only.
 *
 * Advisory by construction: it is a relative rank within traffic resembling the
 * model's training sample, not an absolute risk level, and it never replaces or
 * blends into the rule engine's score.
 */
export interface MlAdvisory {
  /** 0-100, higher = more anomalous. */
  score: number;
  /**
   * Rarity band ("Typical" .. "Very rare"), deliberately NOT the rule engine's
   * severity vocabulary: nothing in the advisory supports a claim about
   * seriousness.
   */
  level: string;
  /** False until outcome labels exist to calibrate against. */
  calibrated: boolean;
  /** Plain statement of what the bands mean, for display alongside the score. */
  bandBasis?: string | null;
  modelVersion: string;
  trainedAt: string | null;
  caveat: string;
}

export const CHAINS: Chain[] = ["bitcoin", "ethereum", "tron", "polygon"];

export const CASE_STATUSES: CaseStatus[] = ["Open", "In Progress", "Under Review", "Escalated", "Closed"];
export const RISK_LEVELS: RiskLevel[] = ["Critical", "High", "Medium", "Low", "Unrated"];

/**
 * Case lifecycle: Open → In Progress → Under Review → Escalated → Closed.
 *
 * An investigation moves forward one stage at a time — stages are skipped
 * never, so a case cannot jump straight from Open to Escalated and lose the
 * record of the work in between. `Closed` is the one exception: it is reachable
 * from any open stage, because escalation is not a precondition for finishing
 * an investigation, only for handing it to another agency.
 */
export const CASE_WORKFLOW: CaseStatus[] = ["Open", "In Progress", "Under Review", "Escalated"];

/**
 * Where each stage may go, stated explicitly rather than derived from a
 * positional list.
 *
 * `Escalated` is a branch, not the last stage before closure: a case enters it
 * from `Under Review` when a condition requires it, and comes back to
 * `Under Review` once that condition is reviewed. A purely linear reading —
 * `Open → In Progress → Under Review → Escalated → Closed` — would make
 * de-escalation illegal and leave an escalated case closable but unreviewable,
 * which is the opposite of what escalating it was for. It also means a case can
 * be escalated and cleared more than once.
 *
 * `Closed` remains reachable from any open stage: escalation is a precondition
 * for handing a case to another agency, not for finishing one.
 */
const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  Open: ["In Progress", "Closed"],
  "In Progress": ["Under Review", "Closed"],
  "Under Review": ["Escalated", "Closed"],
  Escalated: ["Under Review", "Closed"],
  Closed: ["Open"]
};

/** The stage a case advances to next, or `null` when there is no forward step. */
export function nextCaseStatus(status: CaseStatus): CaseStatus | null {
  if (status === "Closed" || status === "Escalated") return null;
  return TRANSITIONS[status][0] ?? null;
}

/** Every status the case may legally move to from here, in flow order. */
export function allowedCaseTransitions(status: CaseStatus): CaseStatus[] {
  return [...TRANSITIONS[status]];
}

export function isValidCaseTransition(from: CaseStatus, to: CaseStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Human-readable explanation of why a transition was refused. */
export function caseTransitionError(from: CaseStatus, to: CaseStatus): string {
  if (from === "Closed") {
    return "This case is closed. Reopen it before setting another status.";
  }
  if (from === "Escalated" && to === "Under Review") {
    return "An escalated case returns to Under Review.";
  }
  const allowed = allowedCaseTransitions(from);
  const forward = allowed.filter((s) => s !== "Closed");
  const paths = [
    "a case advances one stage at a time (Open → In Progress → Under Review)",
    "Escalated is a branch: entered from Under Review, resolved back to Under Review",
    "and any open stage can be closed directly"
  ];
  return (
    (forward.length
      ? `From “${from}” the next stage is “${forward[0]}”`
      : `“${from}” has no forward stage`) +
    `; ${paths.join(", ")}. ` +
    `Permitted from here: ${allowed.join(", ")}.`
  );
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  agency: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface CaseRecord {
  id: string;
  case_ref: string;
  title: string;
  description: string | null;
  chain: string;
  status: CaseStatus;
  priority: RiskLevel;
  lead_investigator_id: string | null;
  opened_at: string;
  closed_at: string | null;
  closed_by: string | null;
  closure_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityRecord {
  id: string;
  chain: string;
  address: string;
  kind: string;
  label: string | null;
  risk_score: number;
  risk_level: RiskLevel;
  risk_factors: unknown;
  first_seen: string | null;
  last_seen: string | null;
  tx_count: number;
  volume_native: string | null;
  volume_usd: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionRecord {
  id: string;
  chain: string;
  tx_hash: string;
  block_height: string | number | null;
  timestamp: string | null;
  from_address: string | null;
  to_address: string | null;
  value_native: string | null;
  value_usd: string | null;
  status: string | null;
  fee_native: string | null;
  created_at: string;
}

export interface EvidenceRecord {
  id: string;
  case_id: string;
  kind: string;
  title: string;
  description: string | null;
  chain: string | null;
  address: string | null;
  tx_hash: string | null;
  content: unknown;
  content_sha256: string;
  collected_by: string | null;
  collected_at: string;
  created_at: string;
}

export interface AlertRecord {
  id: string;
  case_id: string | null;
  entity_id: string | null;
  severity: "critical" | "high" | "medium" | "low" | "info";
  state: "open" | "acknowledged" | "resolved" | "dismissed";
  category: string;
  title: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface RiskFactor {
  code: string;
  label: string;
  weight: number;
  confidence: number;
  detail: string;
  source: string;
  sourceUrl?: string;
  observedAt: string;
  evidence: { txHash?: string; address?: string; valueNative?: string; valueUsd?: string }[];
  limitations?: string;
  challenged?: boolean;
}

/** Explicit state for a graph node indicating data completeness. */
export type NodeStatus =
  | "known"
  | "verified"
  | "unknown"
  | "unresolved"
  | "partial"
  | "truncated"
  | "unsupported"
  | "unavailable";

/* ------------------------------------------------------------------ *
 * Evidence model
 *
 * The distinction that matters forensically is between a fact the chain
 * recorded and a conclusion this system drew. A graph that renders both as the
 * same arrow is misleading, so every edge carries an explicit evidence status
 * and the UI styles each one differently.
 * ------------------------------------------------------------------ */

/**
 * How much we trust that a fund movement along an edge actually happened as
 * drawn.
 *
 * The ordering is deliberate and is a *descending* order of evidentiary
 * strength: `confirmed` is blockchain fact, `excluded` is a statement that the
 * movement was considered and ruled out of this trace.
 */
export type EvidenceStatus =
  /** Directly observed on-chain transfer. Blockchain fact. */
  | "confirmed"
  /** Calculated from transaction structure (input/output pairing, change). */
  | "derived"
  /** Fund attribution produced by the selected trace method. Not a fact. */
  | "attributed"
  /** Heuristic relationship; no single transaction proves it. */
  | "inferred"
  /** Evidence is insufficient to place this movement. */
  | "uncertain"
  /** Ruled out of the selected trace. Shown, but explicitly not part of it. */
  | "excluded";

export const EVIDENCE_STATUSES: EvidenceStatus[] = [
  "confirmed",
  "derived",
  "attributed",
  "inferred",
  "uncertain",
  "excluded"
];

/**
 * Attribution methodology for a specific quantity of funds.
 *
 * There is no single correct answer when a wallet co-mingles investigated funds
 * with unrelated ones, so the choice is the investigator's and the result is
 * always labelled with which method produced it.
 */
export type TraceMethod =
  /** Follow only clean pass-through outputs. Conservative and often inconclusive. */
  | "direct"
  /** Consume outputs oldest-first until the traced quantity is exhausted. */
  | "fifo"
  /** Each output receives a share proportional to its value. Conservation-preserving. */
  | "pro_rata"
  /** Pro-rata, then discounted for co-mingling uncertainty. Under-attributes by design. */
  | "haircut"
  /** Treat every output of a co-mingled wallet as fully tainted. Over-inclusive by design. */
  | "poison";

export const TRACE_METHODS: TraceMethod[] = ["direct", "fifo", "pro_rata", "haircut", "poison"];

/**
 * What kind of movement an edge represents.
 *
 * `contract_interaction` in particular exists to stop the graph implying a
 * transfer where a transaction merely called a contract.
 */
export type EdgeRelationship =
  | "direct_transfer"
  | "token_transfer"
  | "contract_interaction"
  | "change_output"
  | "fee"
  | "bridge_crossing"
  /** Movement between ledgers via a bridge/exchange. Correlation-based, never direct. */
  | "cross_chain_link"
  /**
   * A suspected link between two addresses that we cannot evidence as a
   * movement. Carries no quantity: it records that co-mingling is plausible,
   * not that funds arrived.
   */
  | "possible_association"
  | "consolidation"
  | "attributed_flow";

export interface GraphNode {
  id: string;
  address: string;
  chain: Chain;
  kind: string;
  label?: string;
  riskScore: number;
  riskLevel: RiskLevel;
  firstSeen?: string | null;
  lastSeen?: string | null;
  txCount: number;
  inVolumeUsd?: number;
  outVolumeUsd?: number;
  hopDistance: number;
  factors?: RiskFactor[];
  /** Explicit data state for this node. */
  status?: NodeStatus;
  /** Reason for non-known status, if applicable. */
  statusReason?: string;
  /** Address as the chain spells it, when it is case-sensitive (base58/bech32). */
  canonicalAddress?: string;
  /**
   * Portion of the investigated quantity attributed to this address at this
   * point in the trace. Null when no quantity was specified (trace-everything
   * mode) or when the address carries none of it.
   */
  tracedAmount?: string | null;
  /** Of `tracedAmount`, how much reached this address by direct observation. */
  confirmedAmount?: string | null;
}

/** One line of "why did this edge appear?", shown for non-obvious edges. */
export interface EvidenceReason {
  /** Stable code so the UI can group or filter, e.g. `amount_match`. */
  code: string;
  /** Plain statement, safe to show an investigator verbatim. */
  detail: string;
  /** Whether this reason supports or weakens the edge. */
  weight: "supports" | "qualifies" | "weakens";
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  txHash: string;
  timestamp: string | null;
  valueNative: string;
  valueUsd: number | null;
  /** Chain-level status (confirmed/failed/pending), NOT the evidence status. */
  status: string | null;
  hop: number;
  /** Provider response ID from live lookup, for evidence lineage. */
  providerResponseId?: string;
  /** Asset moved on this edge. Defaults to the chain's native asset. */
  asset: string;
  /**
   * Amount the chain actually recorded for this leg. Always a fact.
   * Never the investigated quantity.
   */
  observedAmount: string;
  /**
   * Portion of the *investigated* quantity carried by this edge.
   *
   * `null` in trace-everything mode, where every observed movement is in scope.
   * Less than `observedAmount` on a split, which is the whole point: the
   * difference is the amount not attributed to this leg.
   */
  tracedAmount: string | null;
  relationship: EdgeRelationship;
  evidenceStatus: EvidenceStatus;
  /** Method that produced `tracedAmount`. Null when status is `confirmed`. */
  traceMethod: TraceMethod | null;
  /** 0–1. 1 only for a directly observed, unambiguous transfer. */
  confidence: number;
  /**
   * Where the underlying observation came from. Named `evidenceSource` because
   * `source`/`target` above are the graph's direction, not provenance.
   */
  evidenceSource: "on_chain" | "stored" | "demo" | "derived";
  blockNumber: number | null;
  /**
   * Network fee the sender paid on this leg's transaction, denominated in the
   * leg's asset.
   *
   * Carried on the edge rather than drawn as a leg to a fee address because the
   * fee recipient is a validator that changes every transaction: a synthetic
   * sink would put an address in the graph that no investigator can ever look
   * up, and a real one would imply the traced funds went to that validator.
   * Reconciliation credits it instead, so a trace that pays gas at every hop
   * still balances. Deduplicated per transaction when it is summed.
   */
  feeNative?: string | null;
  /** Why this edge exists. Always populated for non-`confirmed` edges. */
  reasons: EvidenceReason[];
}

/**
 * Per-hop accounting of the investigated quantity.
 *
 * Exists so the trace can state where it lost the money rather than implying a
 * continuous path that never happened.
 */
export interface HopReconciliation {
  hop: number;
  /** Investigated quantity arriving at this hop. */
  inAmount: string;
  /** Portion of it attributed onward to the next hop. */
  attributedOut: string;
  /**
   * Portion that arrived here and did not leave: no outbound movement was
   * recorded, or none of the recorded movements can carry the investigated
   * quantity. Accounted for and located, so it is never reported as missing.
   */
  located: string;
  /**
   * Portion that left as a fee or change rather than to another tracked address.
   * Accounted for, so it is never reported as missing funds.
   */
  explained: string;
  /**
   * Portion that could not be attributed onward and was not explained by an
   * observed fee or change. This is the only genuinely lost quantity, and it is
   * the per-hop counterpart of `TraceReconciliation.unresolved`.
   */
  unresolved: string;
  /** Outbound edges considered at this hop. */
  outputCount: number;
}

/**
 * Amount conservation for the whole trace (§10 of the design).
 *
 * `unresolved` is deliberately surfaced rather than distributed across wallets
 * to make the graph look continuous. A trace that can only account for 8.7 of
 * 10 ETH has to say so.
 */
export interface TraceReconciliation {
  asset: string;
  /** Quantity under investigation. Null in trace-everything mode. */
  initialAmount: string | null;
  /** Sum of `tracedAmount` on `confirmed` edges. */
  directlyObserved: string;
  /** Sum of `tracedAmount` on `attributed`/`inferred` edges. */
  attributed: string;
  /**
   * Quantity that provably left the traced path as a transaction fee or as
   * change returning to the sender, bounded by the observed value of those
   * legs. Every hop on a fee-paying chain pays gas, so without this bucket a
   * correct trace reports the gas as missing funds.
   */
  explainedOutflow: string;
  /** `initialAmount` that could not be attributed to any edge. */
  unresolved: string;
  /** (observed + attributed + explained) / initialAmount, 0–1. Null when tracing everything. */
  coverage: number | null;
  status: "reconciled" | "partial" | "unreconciled" | "not_applicable";
  /** Per-hop breakdown, in hop order. */
  perHop: HopReconciliation[];
  /** Plain-language notes about limits, always shown with the numbers. */
  caveats: string[];
}

export interface TraceGraph {
  root: string;
  chain: Chain;
  maxHops: number;
  direction: "forward" | "backward" | "both";
  nodes: GraphNode[];
  edges: GraphEdge[];
  totals: {
    valueInUsd: number;
    valueOutUsd: number;
    nodeCount: number;
    edgeCount: number;
    truncated: boolean;
    truncatedReasons: string[];
  };
  riskScore: number;
  riskLevel: RiskLevel;
  /**
   * Optional ML second opinion for the root only. Never set on individual nodes:
   * calling the service per node would make a hop's latency the traversal's
   * latency. Null when the service is disabled, unreachable, or unfitted.
   *
   * Advisory only. `riskScore`/`riskLevel` above remain the analyst-facing
   * assessment produced by the cited rule factors.
   */
  mlAdvisory?: MlAdvisory | null;
  generatedAt: string;
  /** Present only when the trace was persisted to a case. */
  traceId?: string;
  /**
   * Why the graph is smaller than a reader might assume. A limit that trips is
   * recorded in `totals.truncatedReasons`; a source that could not be queried
   * at all is recorded here, so an empty graph is never mistaken for "no funds
   * moved".
   */
  notes?: string[];
  /** Fund-flow ledger with amount conservation checks. */
  ledger?: import("./trace/ledger.js").FundFlowLedger;
  /** Quantity under investigation, when one was supplied. */
  amountToTrace?: string | null;
  /** Asset the investigation is denominated in. */
  asset?: string;
  /** Method used to attribute the quantity across splits. */
  method?: TraceMethod;
  /** Amount conservation across the whole trace. Present whenever a quantity was traced. */
  reconciliation?: TraceReconciliation;
  /**
   * True when every address, transaction and amount in this graph is synthetic.
   * The UI is required to display a visible simulation notice when set.
   */
  demo?: boolean;
  /** Identifier of the demo case that produced this graph, when applicable. */
  demoCaseId?: string | null;
}
