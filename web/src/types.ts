/**
 * API response shapes, mirroring the server contract in `server/src`.
 *
 * Two conventions worth knowing before reading these:
 *  - Anything the server sends as SQL `numeric` arrives as a *string* (Postgres
 *    has no exact decimal JS type). Use `num()` from lib/format rather than
 *    `Number()` when precision matters.
 *  - `value_usd` and friends are nullable because no price feed is configured
 *    by default. A null means "not priced", never "zero".
 */

export type UserRole = "admin" | "investigator" | "analyst" | "viewer";
export type CaseStatus = "Open" | "In Progress" | "Under Review" | "Escalated" | "Closed";
export type RiskLevel = "Critical" | "High" | "Medium" | "Low" | "Unrated";
export type Chain = "bitcoin" | "ethereum" | "tron" | "polygon" | "unknown";
export type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";
export type AlertState = "open" | "acknowledged" | "resolved" | "dismissed";

export type Permission =
  | "case:read"
  | "case:write"
  | "case:close"
  | "case:assign"
  | "trace:run"
  | "evidence:read"
  | "evidence:write"
  | "evidence:export"
  | "alert:read"
  | "alert:triage"
  | "label:challenge"
  | "audit:read"
  | "user:manage"
  | "integration:manage"
  | "case:delete"
  | "ai:read"
  | "ai:upload"
  | "ai:apply";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  agency: string | null;
  permissions: Permission[];
  lastLoginAt?: string | null;
  createdAt?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: SessionUser;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  driver: "pglite" | "pg";
  uptimeSeconds: number;
  environment: string;
  version: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: { path: string; message: string }[] | unknown;
  requestId?: string;
}

export interface CaseRow {
  id: string;
  case_ref: string;
  title: string;
  description: string | null;
  chain: Chain;
  status: CaseStatus;
  priority: RiskLevel;
  lead_investigator_id: string | null;
  lead_name?: string | null;
  lead_email?: string | null;
  opened_at: string;
  closed_at: string | null;
  closed_by?: string | null;
  closed_by_name?: string | null;
  closure_note?: string | null;
  created_at: string;
  updated_at: string;
  /** What the investigation starts from: an address, a transaction hash, or unparsed text. */
  seed_kind?: "address" | "tx" | null;
  seed_value?: string | null;
  /** Where the allegation came from, recorded on intake. */
  referral_source?: string | null;
  entity_count?: number;
  evidence_count?: number;
  open_alert_count?: number;
}

export interface CaseListResponse {
  cases: CaseRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface CaseStatsResponse {
  byStatus: { status: CaseStatus; n: number }[];
  byPriority: { priority: RiskLevel; n: number }[];
  totals: { cases: number; open_value_usd: string | null };
  entities: { total: number; high_risk: number };
  evidence: { total: number };
  alerts: { open: number; critical: number };
  recent: { case_ref: string; title: string; status: CaseStatus; priority: RiskLevel; updated_at: string }[];
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
}

export interface EntityRow {
  id: string;
  chain: Chain;
  address: string;
  kind: string;
  label: string | null;
  risk_score: number;
  risk_level: RiskLevel;
  risk_factors: RiskFactor[] | null;
  first_seen: string | null;
  last_seen: string | null;
  tx_count: number;
  volume_native: string | null;
  volume_usd: string | null;
  created_at: string;
  updated_at: string;
  hop_count?: number;
  amount_usd?: string | null;
  note?: string | null;
}

export interface TransactionRow {
  id: string;
  chain: Chain;
  tx_hash: string;
  block_height: string | number | null;
  timestamp: string | null;
  from_address: string | null;
  to_address: string | null;
  value_native: string | null;
  value_usd: string | null;
  status: string | null;
  fee_native: string | null;
  raw?: unknown;
}

export interface NormalizedTransfer {
  kind: "native" | "token" | "utxo";
  asset: string;
  from: string | null;
  to: string | null;
  amount: string;
  decimals: number;
  contract?: string | null;
  logIndex?: number | null;
}

export interface NormalizedUtxo {
  index: number;
  address: string | null;
  value: string;
  spends?: { txid: string; vout: number } | null;
  coinbase?: boolean;
}

export interface NormalizedTransaction {
  chain: Chain;
  txHash: string;
  blockHeight: number | null;
  timestamp: string | null;
  from: string | null;
  to: string | null;
  valueNative: string;
  valueUsd: number | null;
  status: "confirmed" | "failed" | "pending" | "unknown";
  feeNative: string | null;
  transfers?: NormalizedTransfer[];
  /** UTXO detail. Absent on account-model chains such as Ethereum and Tron. */
  inputTotal?: string;
  outputTotal?: string;
  inputCount?: number;
  outputCount?: number;
  inputs?: NormalizedUtxo[];
  outputs?: NormalizedUtxo[];
  raw?: unknown;
}

export interface NormalizedAddress {
  chain: Chain;
  address: string;
  firstSeen: string | null;
  lastSeen: string | null;
  txCount: number;
  receivedTotal: number;
  sentTotal: number;
  balance: string | null;
  raw?: unknown;
}

/**
 * ML service second opinion, attached to root assessments only.
 *
 * Advisory by construction: a relative rank within traffic resembling the
 * model's training sample, never an absolute risk level, and never blended into
 * the rule engine's score.
 */
export interface MlAdvisory {
  score: number;
  /** Rarity band, not a severity. May be empty when the service sent none. */
  level: string;
  calibrated: boolean;
  bandBasis?: string | null;
  modelVersion: string;
  trainedAt: string | null;
  caveat: string;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  methodology: string;
  caveats: string[];
  /** Absent or null when no advisory is available. Never a fallback number. */
  mlAdvisory?: MlAdvisory | null;
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

/**
 * How strong the evidence is for an edge or node.
 *
 * The ordering matters: a UI can filter to `confirmed` and everything that
 * survives is directly observed.
 */
export type EvidenceStatus =
  /** Directly recorded by the chain or a provider, and unambiguous. */
  | "confirmed"
  /** Computed by our own normaliser from transaction inputs and outputs. */
  | "derived"
  /** Destination reached by apportioning a nominated quantity across a split. */
  | "attributed"
  /** Cross-ledger or otherwise reasoned rather than observed. */
  | "inferred"
  /** The underlying observation is itself unreliable. */
  | "uncertain"
  /** Carries none of the investigated quantity. Drawn as context only. */
  | "excluded";

/** How a nominated quantity is apportioned when funds split. */
export type TraceMethod = "direct" | "fifo" | "pro_rata" | "haircut" | "poison";

/** What kind of movement an edge represents. */
export type EdgeRelationship =
  | "direct_transfer"
  | "token_transfer"
  | "bridge_crossing"
  | "cross_chain_link"
  /** A suspected link we cannot evidence as a movement. Carries no quantity. */
  | "possible_association"
  | "contract_interaction"
  | "change_output"
  | "fee";

/** One line of "why did this edge appear?". */
export interface EvidenceReason {
  code: string;
  detail: string;
  weight: "supports" | "qualifies" | "weakens";
}

export interface GraphNode {
  id: string;
  /** Graph identity. Lower-cased, matching the `entities` unique key. */
  address: string;
  /** The chain's own spelling, for display and copy-to-clipboard. */
  canonicalAddress?: string;
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
  /** Portion of the investigated quantity that reached this node. */
  tracedAmount?: string | null;
  /** Of `tracedAmount`, the portion placed here by direct observation. */
  confirmedAmount?: string | null;
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
  providerResponseId?: string;
  asset: string;
  /** What the chain actually recorded. Always a fact. */
  observedAmount: string;
  /**
   * Portion of the investigated quantity on this edge. `null` in
   * trace-everything mode; less than `observedAmount` on a split.
   */
  tracedAmount: string | null;
  relationship: EdgeRelationship;
  evidenceStatus: EvidenceStatus;
  /** Method that produced `tracedAmount`. Null when the status is `confirmed`. */
  traceMethod: TraceMethod | null;
  /** 0–1. 1 only for a directly observed, unambiguous transfer. */
  confidence: number;
  /** Provenance. Named `evidenceSource` because `source`/`target` are the direction. */
  evidenceSource: "on_chain" | "stored" | "demo" | "derived";
  blockNumber: number | null;
  /**
   * Network fee the sender paid on this leg's transaction. Credited to
   * reconciliation rather than drawn as a leg, because the fee recipient is a
   * validator that changes every transaction.
   */
  feeNative?: string | null;
  /** Always populated for non-`confirmed` edges. */
  reasons: EvidenceReason[];
}

/** Per-hop accounting, so a shortfall can be pinned to a point in the path. */
export interface HopReconciliation {
  hop: number;
  inAmount: string;
  attributedOut: string;
  /** Arrived here and did not leave. Accounted for and located. */
  located: string;
  /** Left as a fee or change rather than to another tracked address. */
  explained: string;
  /** Could not be attributed onward and was not explained. Genuinely lost. */
  unresolved: string;
  outputCount: number;
}

/** Amount conservation for the whole trace. */
export interface TraceReconciliation {
  asset: string;
  /** Quantity under investigation. Null in trace-everything mode. */
  initialAmount: string | null;
  /** Quantity whose destination we can point at, on directly observed transfers. */
  directlyObserved: string;
  /** Quantity whose destination rests on apportionment. */
  attributed: string;
  /**
   * Quantity that provably left the traced path as a transaction fee or as
   * change returning to the sender. Accounted, not lost: without this a correct
   * trace reports gas as missing funds at every hop.
   */
  explainedOutflow: string;
  /** Quantity that could not be attributed to any edge. */
  unresolved: string;
  /** (directlyObserved + attributed + explainedOutflow) / initialAmount, 0-1. */
  coverage: number | null;
  status: "reconciled" | "partial" | "unreconciled" | "not_applicable";
  perHop: HopReconciliation[];
  /** Plain-language limits. Must be shown alongside the numbers. */
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
  /** Root-only ML second opinion. Absent or null when unavailable. */
  mlAdvisory?: MlAdvisory | null;
  generatedAt: string;
  /** Why the graph is smaller than a reader might assume. */
  notes?: string[];
  /** Quantity under investigation. Null means every observed movement was traced. */
  amountToTrace?: string | null;
  /** Asset the investigation is denominated in. */
  asset?: string;
  /** Method used to attribute the quantity across splits. */
  method?: TraceMethod;
  /** Amount conservation. Present whenever a quantity was traced. */
  reconciliation?: TraceReconciliation;
  /** True when every address, amount and score in this graph is synthetic. */
  demo?: boolean;
  demoCaseId?: string | null;
}

export interface TraceResponse {
  graph: TraceGraph;
  meta: { durationMs: number; truncated: boolean; demo?: boolean; demoCaseId?: string };
}

/** Catalogue entry for a synthetic scenario. */
export interface DemoCaseSummary {
  id: string;
  /** Judge-facing reference, e.g. `CT-DEMO-001`. Absent on method-teaching cases. */
  caseRef?: string;
  name: string;
  teaches: string;
  chain: Chain;
  rootAddress: string;
  amount: string;
  asset: string;
  suggestedMethod: TraceMethod;
  expectedOutcome: "reconciled" | "partial" | "unresolved" | "over_attributed";
  /** Hop budget the scenario was authored for. */
  maxHops: number;
  /** Whether this is the case to lead with. */
  headline?: boolean;
}

export interface Detection {
  input: string;
  type: "address" | "tx";
  chain: Chain;
  encoding: string;
  ambiguousChains: Chain[];
  normalized: string;
  chainName?: string;
  explorer?: string;
  recognized?: boolean;
  message?: string;
}

export interface LabelRow {
  id: string;
  chain: Chain;
  address: string;
  kind: "exchange" | "mixer" | "bridge" | "sanctioned" | "darknet" | "service";
  name: string;
  source: string;
  source_url: string | null;
  confidence: "low" | "medium" | "high";
  observed_at: string;
  note: string | null;
  status: "active" | "challenged" | "retracted";
  created_at: string;
  challenged_at: string | null;
  challenge_reason: string | null;
}

export interface AlertRow {
  id: string;
  /** Absent in some case-scoped and report projections, which select fewer columns. */
  case_id?: string | null;
  entity_id?: string | null;
  severity: AlertSeverity;
  state: AlertState;
  category: string;
  title: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  case_ref?: string | null;
  case_title?: string | null;
  entity_address?: string | null;
  entity_chain?: Chain | null;
  /** Entity score that triggered the alert, as a number. Null when unlinked. */
  risk_score?: number | null;
}

export interface EvidenceRow {
  id: string;
  case_id: string;
  kind: string;
  title: string;
  description: string | null;
  chain: Chain | null;
  address: string | null;
  tx_hash: string | null;
  content_sha256: string;
  collected_by: string | null;
  collected_at: string;
  created_at: string;
  case_ref?: string;
  case_title?: string;
  collected_by_name?: string | null;
  content?: unknown;
}

export interface CaseNoteRow {
  id: string;
  body: string;
  kind: "note" | "hypothesis" | "finding" | "status";
  pinned: boolean;
  created_at: string;
  author: string | null;
}

export interface AssigneeRow {
  id: string;
  display_name: string;
  email: string;
  role: UserRole;
}

export interface TraceSummaryRow {
  id: string;
  chain: Chain;
  root_address: string;
  max_hops: number;
  direction: string;
  node_count: number;
  edge_count: number;
  total_usd: string | null;
  risk_score: number;
  risk_level: RiskLevel;
  created_at: string;
  /** The stored graph is synthetic. Surfaces the SIMULATED marker in pickers. */
  is_demo?: boolean;
}

export interface CaseDetailResponse {
  case: CaseRow;
  entities: EntityRow[];
  transactions: TransactionRow[];
  evidence: EvidenceRow[];
  alerts: AlertRow[];
  notes: CaseNoteRow[];
  assignees: AssigneeRow[];
  traces: TraceSummaryRow[];
}

/** One precondition of closure: a blocker refuses the close, an advisory warns. */
export interface ReadinessCheck {
  code: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** `GET /api/cases/:id/closure-readiness` â€” why the case can or cannot be closed now. */
export interface ClosureReadinessResponse {
  caseId: string;
  caseRef: string;
  status: CaseStatus;
  nextStatus: CaseStatus | null;
  allowedTransitions: CaseStatus[];
  canClose: boolean;
  closeBlockedReason: string | null;
  ready: boolean;
  blockers: ReadinessCheck[];
  advisories: ReadinessCheck[];
  counts: {
    openCriticalAlerts: number;
    openAlerts: number;
    entities: number;
    evidence: number;
    traces: number;
    findings: number;
  };
}

export interface DashboardResponse {
  kpis: {
    open_cases: number;
    critical_cases: number;
    entities: number;
    high_risk: number;
    evidence: number;
    open_alerts: number;
    critical_alerts: number;
    traced_usd: string | null;
  };
  statusMix: { status: CaseStatus; n: number }[];
  riskMix: { priority: RiskLevel; n: number }[];
  activity: { day: string; opened: number; closed: number }[];
  topRisk: {
    id: string;
    chain: Chain;
    address: string;
    label: string | null;
    risk_score: number;
    risk_level: RiskLevel;
    kind: string;
    linked_cases: number;
  }[];
  recentAlerts: {
    id: string;
    severity: AlertSeverity;
    category: string;
    title: string;
    detail: string | null;
    created_at: string;
    case_ref: string | null;
  }[];
  chains: { chain: Chain; name: string; symbol: string; explorer: string }[];
  thresholds: Record<RiskLevel | "critical" | "high" | "medium" | "low", number>;
  generatedAt: string;
  caveat: string;
}

export interface RiskDistributionResponse {
  bands: { band: RiskLevel; n: number }[];
  byChain: { chain: string; avg_score: string; n: number }[];
  factors: { code: string; label: string; n: number }[];
  thresholds: Record<string, number>;
}

export interface RiskRule {
  code: string;
  label: string;
  defaultWeight: number;
  confidence: number;
  detail: string;
  source: string;
  limitations: string | null;
}

export interface RiskRulesResponse {
  thresholds: Record<string, number>;
  rules: RiskRule[];
}

export interface RiskConfigResponse {
  thresholds: Record<string, number>;
  rules: RiskRule[];
  overrides: { rule: string; weight: number; updated_by: string; updated_at: string }[];
  notice: string;
}

export interface ChainHealthRow {
  chain: Chain;
  name: string;
  symbol: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  agency: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  assigned_cases?: number;
  led_cases?: number;
  open_cases_led?: number;
  notes_authored?: number;
  evidence_collected?: number;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name?: string | null;
  actor_role?: UserRole | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  case_ref: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  outcome: "success" | "failure";
}

export interface CaseReport {
  case: CaseRow;
  sections: {
    chainFacts: { entities: EntityRow[]; traces: TraceSummaryRow[] };
    thirdPartyAttribution: { labels: LabelRow[] };
    analystHypotheses: { notes: CaseNoteRow[] };
    evidence: { items: EvidenceRow[] };
    alerts: AlertRow[];
    analystFindings: { notes: CaseNoteRow[] };
  };
  methodology: {
    riskScoring: string;
    dataSources: string;
    limitations: string[];
  };
  generatedAt: string;
  generatedBy: { id: string; email: string; role: UserRole };
}

/* ------------------------------------------------------------------ *
 * Chain module response envelopes
 *
 * Note the two transaction shapes below. `/chain/lookup` always returns a
 * normalized (camelCase) object, but `/chain/transaction/:hash` returns a
 * database row (snake_case) on a cache hit and a normalized object on a live
 * fetch. `normalizeTxRow` in lib/normalize.ts bridges them.
 * ------------------------------------------------------------------ */

export interface LookupResponse {
  kind: "address" | "tx";
  detection: Detection;
  address?: NormalizedAddress;
  transaction?: NormalizedTransaction;
  risk?: RiskResult;
}

export interface StoredTransactionRow {
  id: string;
  chain: Chain;
  tx_hash: string;
  block_height: string | number | null;
  timestamp: string | null;
  from_address: string | null;
  to_address: string | null;
  value_native: string | null;
  value_usd: string | number | null;
  status: string | null;
  fee_native: string | null;
}

export interface AddressTransactionsResponse {
  source: "store" | "live";
  transactions: (StoredTransactionRow | NormalizedTransaction)[];
  cursor: string | null;
  note?: string;
}

export interface TransactionDetailResponse {
  source: "cache" | "live";
  transaction: StoredTransactionRow | NormalizedTransaction;
}

export interface ChainHealthResponse {
  chains: ChainHealthRow[];
  checkedAt: string;
}

export interface SupportedChainsResponse {
  chains: {
    id: Chain;
    name: string;
    symbol: string;
    explorer: string;
    addressExample: string;
    txExample: string;
  }[];
  note: string;
}

export interface MetaResponse {
  chains: Chain[];
  statuses: CaseStatus[];
  priorities: RiskLevel[];
  roles: UserRole[];
}

/* ------------------------------------------------ alerts / VASP / admin */

export interface AlertsResponse {
  alerts: AlertRow[];
  /** Unfiltered tally across the whole register, by state. */
  counts: { state: AlertState; n: number }[];
  /** Unfiltered tally of *open* alerts, by severity. */
  severityCounts: { severity: string; n: number }[];
  /** Server-determined, so Next is never dead-ended or looped onto an empty page. */
  hasMore: boolean;
  limit: number;
  offset: number;
}

export interface VaspLabelsResponse {
  labels: LabelRow[];
  byKind: { kind: string; n: number }[];
  disclaimer: string;
}

export interface VaspRegisterResponse {
  register: (LabelRow & { linked_cases: number; case_volume_usd: string | null })[];
  notice: string;
}

export interface LabelChallengeResponse {
  label: LabelRow;
}

export interface RoleMatrixRow {
  role: UserRole;
  permissions: Permission[];
  capabilities: string[];
}

export interface AdminUsersResponse {
  users: UserRow[];
  roles: RoleMatrixRow[];
}

export interface IntegrationRow {
  id: string;
  name: string;
  kind: "node" | "indexer" | "rpc" | "intelligence" | "storage";
  chain: string | null;
  base_url: string | null;
  api_key_ref: string | null;
  enabled: boolean;
  rate_limit_per_min: number;
  notes: string | null;
  updated_at: string;
}

export interface IntegrationsResponse {
  integrations: IntegrationRow[];
  health: ChainHealthRow[];
  effective: Record<string, { baseUrl: string; auth: string; note?: string }>;
  securityNote: string;
}

export interface SystemResponse {
  runtime: { node: string; env: string; driver: string; uptimeSeconds: number };
  users: { active: number; total: number };
  tables: { table_name: string; n: number }[];
  audit: { entries: number; oldest: string | null };
}

export interface SavedSearchRow {
  id: string;
  name: string;
  query: string;
  filters: Record<string, unknown>;
  shared: boolean;
  created_at: string;
  owner: string | null;
}

export interface TeamMembersResponse {
  members: UserRow[];
  workload: { display_name: string; open_cases: number }[];
}

export interface TeamActivityResponse {
  activity: (AuditEntry & { action: string; entity_type: string })[];
}

export interface AuditVerifyResponse {
  appendOnly: boolean;
  trigger: string | null;
  entries: number;
  verifiedAt: string;
  note: string;
}

export interface AuditListResponse {
  entries: AuditEntry[];
  actions: { action: string; n: number }[];
  limit: number;
  offset: number;
}

export interface EvidenceVerifyResponse {
  valid: boolean;
  sealVersion: "canonical-v2" | "payload-only-v1" | "unknown";
  stored: string;
  recomputed: string;
  algorithm: string;
  canonicalisation: string;
  note?: string;
  checkedAt: string;
}

export interface EvidenceListResponse {
  evidence: EvidenceRow[];
  limit: number;
  offset: number;
}

/* ------------------------------------------------------------ AI assistant */

/** Mirrors `AiStatus` in `server/src/routes/ai.ts`. */
export interface AiStatus {
  available: boolean;
  enabled: boolean;
  hasKey: boolean;
  model: string;
  promptVersion: string;
  maxUploadMb: number;
  maxInputChars: number;
  reason: string | null;
}

/** Mirrors `ExtractedText["kind"]` in `server/src/ai/extract.ts`. */
export type DocumentKind = "pdf" | "csv" | "json" | "text";

export type DocumentStatus = "uploaded" | "extracted" | "analyzed" | "failed";

export interface CaseDocument {
  id: string;
  filename: string;
  mime: string;
  byteSize: number;
  sha256: string;
  pageCount: number | null;
  charCount: number | null;
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
  analyzedAt: string | null;
  uploadedByName?: string | null;
  truncated?: boolean;
  kind?: DocumentKind;
  duplicate?: boolean;
  /** OCR metadata when OCR was used. */
  ocr?: {
    used: boolean;
    language: string;
    averageConfidence: number;
    pagesProcessed: number;
  };
}

/**
 * The role a model assigned to an indicator. `subject` is the only role that
 * becomes a trace root on apply, because tracing a suspected counterparty as
 * though it were the subject inverts the direction of the investigation.
 */
export type IndicatorRole = "subject" | "counterparty" | "exchange" | "mixer" | "bridge" | "unknown";

/** `address` values are attached as entities; `tx` values as transactions. */
export type IndicatorKind = "address" | "tx";

export interface ProposalIndicator {
  value: string;
  kind: IndicatorKind;
  chain: Exclude<Chain, "unknown">;
  role: IndicatorRole;
  label: string | null;
  /** The surrounding text the value was read from, for the reviewer to check against. */
  excerpt: string | null;
  /** How clearly the document establishes this identifier. */
  confidence: "low" | "medium" | "high";
}

export interface CaseProposal {
  summary: string;
  caseFields: {
    title: string | null;
    description: string | null;
    priority: string | null;
  };
  indicators: ProposalIndicator[];
  /** Named parties mentioned in the document (not blockchain identifiers). */
  entities: { name: string; role: string; excerpt: string }[];
  hypotheses: { text: string; basis: string }[];
  /** Questions the document leaves undetermined. */
  openQuestions: string[];
}

export type ProposalStatus = "pending" | "applying" | "applied" | "rejected";

export interface AppliedTrace {
  address: string;
  traceId: string | null;
  nodes: number;
  edges: number;
  riskScore: number;
  riskLevel: RiskLevel;
  truncated: string[];
}

export interface AppliedSummary {
  entitiesCreated: number;
  transactionsCreated: number;
  indicatorsSkipped: { value: string; reason: string }[];
  traces: AppliedTrace[];
  tracesFailed: { address: string; reason: string }[];
  caseFieldsApplied: boolean;
  hypothesesAdded: number;
  evidenceId: string | null;
}

export interface AiProposalRow {
  id: string;
  document_id: string | null;
  status: ProposalStatus;
  proposal: CaseProposal;
  model: string;
  prompt_version: string;
  accepted_indexes: number[] | null;
  applied_summary: AppliedSummary | null;
  trace_id: string | null;
  evidence_id: string | null;
  created_at: string;
  decided_at: string | null;
  filename: string | null;
  created_by_name: string | null;
  decided_by_name: string | null;
}

export interface AiChatCitation {
  /** `document` or `evidence`, so the panel can link to the right view. */
  kind: "document" | "evidence" | "case";
  id: string | null;
  label: string;
  locator?: string;
}

export interface AiChatAnswer {
  answer: string;
  confidence: "low" | "medium" | "high";
  citations: AiChatCitation[];
  insufficientData: boolean;
}

/* ---------------------------------------------------------------- status engine */

/**
 * Case lifecycle events emitted by the backend.
 * Mirror of server/src/status/engine.ts CaseEvent.
 */
export type CaseEventType =
  | "DOCUMENT_UPLOADED"
  | "AI_ANALYSIS_STARTED"
  | "AI_ANALYSIS_COMPLETED"
  | "AI_APPLY_STARTED"
  | "AI_APPLY_COMPLETED"
  | "TRACE_STARTED"
  | "TRACE_COMPLETED"
  | "RISK_ANALYSIS_COMPLETED"
  | "ALERT_CREATED"
  | "CRITICAL_ALERT_CREATED"
  | "REVIEW_STARTED"
  | "ESCALATION_REQUIRED"
  | "ESCALATION_RESOLVED"
  | "CASE_APPROVED"
  | "CASE_REOPENED"
  | "MANUAL_STATUS_CHANGE";

export interface CaseEventBase {
  type: CaseEventType;
  caseId: string;
  actorId: string;
}

export type CaseEvent =
  | (CaseEventBase & { type: "DOCUMENT_UPLOADED" })
  | (CaseEventBase & { type: "AI_ANALYSIS_STARTED" })
  | (CaseEventBase & { type: "AI_ANALYSIS_COMPLETED"; proposalId: string })
  | (CaseEventBase & { type: "AI_APPLY_STARTED"; proposalId: string })
  | (CaseEventBase & { type: "AI_APPLY_COMPLETED"; proposalId: string })
  | (CaseEventBase & { type: "TRACE_STARTED"; traceJobId: string })
  | (CaseEventBase & { type: "TRACE_COMPLETED"; traceJobId: string; traceId: string })
  | (CaseEventBase & { type: "RISK_ANALYSIS_COMPLETED" })
  | (CaseEventBase & { type: "ALERT_CREATED"; alertId: string; severity: string })
  | (CaseEventBase & { type: "CRITICAL_ALERT_CREATED"; alertId: string })
  | (CaseEventBase & { type: "REVIEW_STARTED" })
  | (CaseEventBase & { type: "ESCALATION_REQUIRED"; reason: string })
  | (CaseEventBase & { type: "ESCALATION_RESOLVED"; reason: string })
  | (CaseEventBase & { type: "CASE_APPROVED"; closureNote: string })
  | (CaseEventBase & { type: "CASE_REOPENED"; reason: string })
  | (CaseEventBase & { type: "MANUAL_STATUS_CHANGE"; from: string; to: string; closureNote?: string });

/**
 * Status change event from SSE stream.
 */
export interface CaseStatusChangedEvent {
  caseId: string;
  from: CaseStatus;
  to: CaseStatus;
  trigger: string;
  at: string;
}

/**
 * Case event types pushed over the WebSocket (`/ws`, after `auth` +
 * `subscribe`). On subscribe the server sends an immediate `status` frame so a
 * client that connects mid-investigation renders the right state before waiting
 * for the next transition, then `status-changed` per move. `heartbeat`/`pong`
 * frames keep proxies from closing an idle socket.
 */
export type CaseStreamEventType = "connected" | "heartbeat" | "status" | "status-changed";

export interface CaseStreamEvent {
  type: CaseStreamEventType;
  caseId?: string;
  /** Present on the `status` frame: the case's status at connect time. */
  status?: CaseStatus;
  from?: CaseStatus;
  to?: CaseStatus;
  trigger?: string;
  at?: string;
}

/**
 * Pipeline step for the Analysis page.
 */
export type PipelineStep =
  | "idle"
  | "document_uploaded"
  | "extracting_text"
  | "ai_analysis_started"
  | "ai_analysis_completed"
  | "ai_apply_started"
  | "ai_apply_completed"
  | "trace_started"
  | "trace_completed"
  | "risk_analysis_completed"
  | "alert_created"
  | "review_started"
  | "escalation_required"
  | "escalation_resolved"
  | "case_approved"
  | "case_reopened";

/**
 * Analysis pipeline step status.
 */
export interface PipelineStepStatus {
  step: PipelineStep;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * Case status with workflow position.
 */
export interface CaseStatusInfo {
  caseId: string;
  caseRef: string;
  status: CaseStatus;
  workflowPosition: number; // 0 = Open, 1 = In Progress, 2 = Under Review, 3 = Escalated, 4 = Closed
  canClose: boolean;
  canManualStatusChange: boolean;
  lastEvent?: CaseEvent;
  updatedAt: string;
}

/**
 * Node selection for the Viewer.
 */
export interface ViewerSelection {
  type: "node" | "edge" | null;
  id: string | null;
  data?: {
    address?: string;
    chain?: string;
    riskScore?: number;
    riskLevel?: RiskLevel;
    txHash?: string;
    amount?: string;
    asset?: string;
    [key: string]: unknown;
  };
}

/**
 * AI Investigator context.
 */
export interface AIInvestigatorContext {
  caseId: string;
  caseRef: string;
  selectedNode?: ViewerSelection;
  selectedEdge?: ViewerSelection;
  caseStatus: CaseStatus;
  available: boolean;
  model: string;
}

/**
 * Viewer mode.
 */
export type ViewerMode = "graph" | "timeline" | "fund-flow" | "risk";

/**
 * Case workspace layout state, persisted per browser.
 *
 * The three panels share the available width, so the widths are stored as
 * percentages of the workspace rather than as pixel sizes: a percentage layout
 * survives the window being resized or the page being opened on a laptop.
 */
export interface LayoutPanels {
  widths: {
    analysis: number;
    viewer: number;
    ai: number;
  };
  collapsed: {
    analysis: boolean;
    viewer: boolean;
    ai: boolean;
  };
}

/**
 * A persisted pipeline event.
 *
 * Field names are snake_case because this is the raw row shape returned by
 * `GET /api/status/:id/events` (the persisted history, still polled over HTTP);
 * the mapping to `CaseEvent` above is the camelCase view model the WebSocket
 * event stream uses.
 */
export interface CaseEventRow {
  id: string;
  event_type: CaseEventType;
  actor_id: string | null;
  actor_name: string | null;
  /** Populated only when the event actually moved the case. */
  from_status: CaseStatus | null;
  to_status: CaseStatus | null;
  reason: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface CaseEventListResponse {
  events: CaseEventRow[];
}

/**
 * Response of `GET /api/status/:id`.
 *
 * `case` is the raw database row, so its fields stay snake_case; the
 * surrounding keys are camelCase because they are assembled in the handler.
 */
export interface CaseStatusResponse {
  case: {
    id: string;
    case_ref: string;
    status: CaseStatus;
    closed_at: string | null;
    closed_by: string | null;
    closure_note: string | null;
    created_at: string;
    updated_at: string;
  };
  status: CaseStatus;
  nextStatus: CaseStatus | null;
  allowedTransitions: CaseStatus[];
  permissions: {
    canChangeStatus: boolean;
    canClose: boolean;
    canReopen: boolean;
    canEscalate: boolean;
    canDeescalate: boolean;
  };
}

export interface TraceRunSummary {
  id: string;
  chain: string;
  rootAddress: string;
  nodeCount: number;
  edgeCount: number;
  totalUsd: number | null;
  riskScore: number;
  riskLevel: RiskLevel;
  truncatedReasons: string[];
  createdAt: string;
  createdBy: string | null;
}

/** Response of `GET /api/chain/cases/:caseId/graph`. */
export interface CaseGraphResponse {
  caseId: string;
  caseRef: string;
  status: CaseStatus;
  graph: TraceGraph | null;
  selectedTraceId: string | null;
  runs: TraceRunSummary[];
}

