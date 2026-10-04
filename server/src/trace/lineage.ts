import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { one, many } from "../db/index.js";

/**
 * Data Lineage Tracking
 * 
 * Tracks the complete lineage of data from source to report:
 * Blockchain → Provider Response → Raw Response Hash → Normalized Event → 
 * Graph Edge → Flow Analysis → Risk/Alert → Report Finding → Audit Record
 * 
 * This allows an investigator to click from any finding back to its ultimate source.
 */

export interface LineageStep {
  step: number;
  stage: "provider_response" | "raw_response_hash" | "normalized_event" | "graph_edge" | "flow_analysis" | "risk_alert" | "report_finding" | "audit_record";
  entityType: string;
  entityId: string;
  description: string;
  previousStepId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  chainId: string;
}

export interface LineageChain {
  id: string;
  rootId: string; // The original provider response ID
  caseId: string | null;
  steps: LineageStep[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderResponseRecord {
  id: string;
  chain: string;
  requestType: "address" | "transaction" | "transactions_for_address" | "block" | "health";
  requestParams: Record<string, unknown>;
  responseData: unknown;
  responseHash: string;
  provider: string;
  latencyMs: number;
  success: boolean;
  error: string | null;
  createdAt: string;
}

export interface NormalizedEventRecord {
  id: string;
  providerResponseId: string;
  eventType: "transaction" | "transfer" | "utxo" | "address_info";
  chain: string;
  normalizedData: unknown;
  rawResponseRef: string;
  createdAt: string;
}

export interface GraphEdgeRecord {
  id: string;
  traceId: string;
  caseId: string | null;
  source: string;
  target: string;
  txHash: string;
  timestamp: string | null;
  valueNative: string;
  valueUsd: number | null;
  asset: string;
  assetIdentifier: string | null;
  decimals: number;
  normalizedEventId: string | null;
  providerResponseId: string | null;
  /** What the chain recorded on this leg. Distinct from `valueNative`. */
  observedAmount: string | null;
  /** Portion of the investigated quantity this edge carried. Null when none was. */
  tracedAmount: string | null;
  relationship: string;
  evidenceStatus: string;
  traceMethod: string | null;
  confidence: number | null;
  evidenceSource: string;
  evidenceReasons: unknown;
  createdAt: string;
}

export interface FlowAnalysisRecord {
  id: string;
  caseId: string;
  graphEdgeId: string;
  analysisType: "fund_flow" | "conservation_check" | "path_reconstruction";
  inputTotalNative: string;
  outputTotalNative: string;
  inputTotalUsd: number | null;
  outputTotalUsd: number | null;
  discrepancyNative: string;
  discrepancyUsd: number | null;
  status: "balanced" | "partial" | "data_limitation" | "unreconciled";
  details: unknown;
  createdAt: string;
}

export interface RiskAlertRecord {
  id: string;
  caseId: string;
  flowAnalysisId: string | null;
  graphEdgeId: string | null;
  entityId: string | null;
  alertType: "risk_signal" | "alert";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  evidence: unknown;
  sourceSteps: string[]; // Lineage step IDs
  createdAt: string;
}

export interface ReportFindingRecord {
  id: string;
  caseId: string;
  reportId: string;
  riskAlertId: string | null;
  flowAnalysisId: string | null;
  findingType: string;
  title: string;
  description: string;
  sourceSteps: string[];
  createdAt: string;
}

export interface AuditRecord {
  id: string;
  caseId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  findingId: string | null;
  riskAlertId: string | null;
  flowAnalysisId: string | null;
  graphEdgeId: string | null;
  description: string;
  createdAt: string;
}

/**
 * Find the lineage chain for a given provider response ID.
 * Returns the chain ID (which equals lineage_chains.id) if found.
 */
async function findChainIdForProviderResponse(
  db: Db,
  providerResponseId: string
): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    `SELECT id FROM lineage_chains WHERE root_id = $1`,
    [providerResponseId]
  );
  return row?.id ?? null;
}

/**
 * Find the lineage chain by walking from an entity back to its provider response.
 * Walks: graph_edge -> provider_response_id
 *        flow_analysis -> graph_edge_id -> provider_response_id
 *        risk_alert -> graph_edge_id OR flow_analysis_id -> provider_response_id
 *        report_finding -> risk_alert_id -> graph_edge_id -> provider_response_id
 *        audit_record -> finding_id -> risk_alert_id -> graph_edge_id -> provider_response_id
 */
async function findChainIdForEntity(
  db: Db,
  entityType: string,
  entityId: string
): Promise<string | null> {
  let providerResponseId: string | null = null;

  if (entityType === "graph_edge") {
    const ge = await one<{ provider_response_id: string | null }>(
      db,
      `SELECT provider_response_id FROM graph_edges WHERE id = $1`,
      [entityId]
    );
    providerResponseId = ge?.provider_response_id ?? null;
  } else if (entityType === "flow_analysis") {
    const fa = await one<{ graph_edge_id: string }>(
      db,
      `SELECT graph_edge_id FROM flow_analyses WHERE id = $1`,
      [entityId]
    );
    if (fa?.graph_edge_id) {
      const ge = await one<{ provider_response_id: string | null }>(
        db,
        `SELECT provider_response_id FROM graph_edges WHERE id = $1`,
        [fa.graph_edge_id]
      );
      providerResponseId = ge?.provider_response_id ?? null;
    }
  } else if (entityType === "risk_alert") {
    const ra = await one<{ flow_analysis_id: string | null; graph_edge_id: string | null }>(
      db,
      `SELECT flow_analysis_id, graph_edge_id FROM risk_alerts_lineage WHERE id = $1`,
      [entityId]
    );
    if (ra?.graph_edge_id) {
      const ge = await one<{ provider_response_id: string | null }>(
        db,
        `SELECT provider_response_id FROM graph_edges WHERE id = $1`,
        [ra.graph_edge_id]
      );
      providerResponseId = ge?.provider_response_id ?? null;
    } else if (ra?.flow_analysis_id) {
      const fa = await one<{ graph_edge_id: string }>(
        db,
        `SELECT graph_edge_id FROM flow_analyses WHERE id = $1`,
        [ra.flow_analysis_id]
      );
      if (fa?.graph_edge_id) {
        const ge = await one<{ provider_response_id: string | null }>(
          db,
          `SELECT provider_response_id FROM graph_edges WHERE id = $1`,
          [fa.graph_edge_id]
        );
        providerResponseId = ge?.provider_response_id ?? null;
      }
    }
  } else if (entityType === "report_finding") {
    const rf = await one<{ risk_alert_id: string | null }>(
      db,
      `SELECT risk_alert_id FROM report_findings WHERE id = $1`,
      [entityId]
    );
    if (rf?.risk_alert_id) {
      // Recurse through risk_alert
      providerResponseId = await findChainIdForEntity(db, "risk_alert", rf.risk_alert_id);
    }
  } else if (entityType === "audit_record") {
    // Audit log doesn't directly link, but recordAuditWithLineage is called with findingId
    // This is handled by the caller passing the findingId
    return null;
  }

  if (!providerResponseId) return null;
  return findChainIdForProviderResponse(db, providerResponseId);
}

/**
 * Append a step to an existing lineage chain.
 * Uses a simple subquery for step numbering, avoiding GROUP BY fanout bugs.
 */
async function appendLineageStep(
  db: Db,
  chainId: string,
  params: {
    stage: LineageStep["stage"];
    entityType: string;
    entityId: string;
    description: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO lineage_steps (id, chain_id, step, stage, entity_type, entity_id, description, previous_step_id, metadata, created_at)
     SELECT $1, $2, COALESCE((SELECT MAX(step) FROM lineage_steps WHERE chain_id = $2), 0) + 1, $3, $4, $5, $6, ls.id, $7, $8
     FROM lineage_steps ls
     WHERE ls.chain_id = $2
     ORDER BY ls.step DESC
     LIMIT 1`,
    [
      randomUUID(),
      chainId,
      params.stage,
      params.entityType,
      params.entityId,
      params.description,
      params.metadata,
      now
    ]
  );
}

/**
 * Record a provider response and return its lineage ID (the chain ID).
 */
export async function recordProviderResponse(
  db: Db,
  params: {
    chain: string;
    requestType: ProviderResponseRecord["requestType"];
    requestParams: Record<string, unknown>;
    responseData: unknown;
    provider: string;
    latencyMs: number;
    success: boolean;
    error: string | null;
    caseId: string | null;
  }
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const responseHash = createHash("sha256").update(JSON.stringify(params.responseData)).digest("hex");

  const id = randomUUID();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO provider_responses (id, chain, request_type, request_params, response_data, response_hash, provider, latency_ms, success, error, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, params.chain, params.requestType, JSON.stringify(params.requestParams), JSON.stringify(params.responseData), responseHash, params.provider, params.latencyMs, params.success, params.error, now]
  );

  // Create lineage chain with SAME id for chain_id (fixes orphan bug)
  const chainId = id;
  await db.query(
    `INSERT INTO lineage_chains (id, root_id, case_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [chainId, id, params.caseId, now, now]
  );

  // Create first lineage step, linking to the chain we just created
  await db.query(
    `INSERT INTO lineage_steps (id, chain_id, step, stage, entity_type, entity_id, description, previous_step_id, metadata, created_at)
     VALUES ($1,$2,1,'provider_response','provider_response',$3,$4,NULL,$5,$6)`,
    [randomUUID(), chainId, id, `Provider ${params.provider} ${params.requestType} response`, JSON.stringify({ chain: params.chain, latencyMs: params.latencyMs }), now]
  );

  return chainId;
}

/**
 * Record a normalized event and link to provider response via lineage.
 */
export async function recordNormalizedEvent(
  db: Db,
  params: {
    providerResponseId: string;
    eventType: NormalizedEventRecord["eventType"];
    chain: string;
    normalizedData: unknown;
    caseId: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO normalized_events (id, provider_response_id, event_type, chain, normalized_data, raw_response_ref, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, params.providerResponseId, params.eventType, params.chain, JSON.stringify(params.normalizedData), params.providerResponseId, now]
  );

  // Find the lineage chain by provider response
  const chainId = await findChainIdForProviderResponse(db, params.providerResponseId);
  if (chainId) {
    await appendLineageStep(db, chainId, {
      stage: "normalized_event",
      entityType: "normalized_event",
      entityId: id,
      description: `Normalized ${params.eventType} event`,
      metadata: { chain: params.chain, eventType: params.eventType }
    });
  }

  return id;
}

/**
 * Record a graph edge and link to normalized event / provider response via lineage.
 */
export async function recordGraphEdge(
  db: Db,
  params: {
    traceId: string;
    caseId: string | null;
    source: string;
    target: string;
    txHash: string;
    timestamp: string | null;
    valueNative: string;
    valueUsd: number | null;
    asset: string;
    assetIdentifier: string | null;
    decimals: number;
    normalizedEventId: string | null;
    providerResponseId: string | null;
    observedAmount?: string | null;
    tracedAmount?: string | null;
    relationship?: string;
    evidenceStatus?: string;
    traceMethod?: string | null;
    confidence?: number | null;
    evidenceSource?: string;
    evidenceReasons?: unknown;
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();

  // Defaults describe the weakest claim that is still true of an edge inserted
  // without evidence detail: it came from our own store, and it is derived.
  await db.query(
    `INSERT INTO graph_edges (id, trace_id, case_id, source, target, tx_hash, timestamp, value_native, value_usd, asset, asset_identifier, decimals, normalized_event_id, provider_response_id, observed_amount, traced_amount, relationship, evidence_status, trace_method, confidence, evidence_source, evidence_reasons, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      id,
      params.traceId,
      params.caseId,
      params.source,
      params.target,
      params.txHash,
      params.timestamp,
      params.valueNative,
      params.valueUsd,
      params.asset,
      params.assetIdentifier,
      params.decimals,
      params.normalizedEventId,
      params.providerResponseId,
      // Falls back to the observed native value: a pre-evidence caller recorded
      // one amount, and it is an observation rather than an attribution.
      params.observedAmount ?? params.valueNative,
      params.tracedAmount ?? null,
      params.relationship ?? "direct_transfer",
      params.evidenceStatus ?? "derived",
      params.traceMethod ?? null,
      params.confidence ?? null,
      params.evidenceSource ?? "stored",
      JSON.stringify(params.evidenceReasons ?? []),
      now
    ]
  );

  // Link via lineage if we have a provider response
  if (params.providerResponseId) {
    const chainId = await findChainIdForProviderResponse(db, params.providerResponseId);
    if (chainId) {
      await appendLineageStep(db, chainId, {
        stage: "graph_edge",
        entityType: "graph_edge",
        entityId: id,
        description: `Graph edge ${params.source} -> ${params.target} via ${params.txHash}`,
        metadata: {
          asset: params.asset,
          valueUsd: params.valueUsd,
          evidenceStatus: params.evidenceStatus ?? "derived",
          relationship: params.relationship ?? "direct_transfer"
        }
      });
    }
  }

  return id;
}

/**
 * Record flow analysis and link to graph edges via lineage.
 */
export async function recordFlowAnalysis(
  db: Db,
  params: {
    caseId: string;
    graphEdgeId: string;
    analysisType: FlowAnalysisRecord["analysisType"];
    inputTotalNative: string;
    outputTotalNative: string;
    inputTotalUsd: number | null;
    outputTotalUsd: number | null;
    discrepancyNative: string;
    discrepancyUsd: number | null;
    status: FlowAnalysisRecord["status"];
    details: unknown;
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO flow_analyses (id, case_id, graph_edge_id, analysis_type, input_total_native, output_total_native, input_total_usd, output_total_usd, discrepancy_native, discrepancy_usd, status, details, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, params.caseId, params.graphEdgeId, params.analysisType, params.inputTotalNative, params.outputTotalNative, params.inputTotalUsd, params.outputTotalUsd, params.discrepancyNative, params.discrepancyUsd, params.status, JSON.stringify(params.details), now]
  );

  // Find lineage chain via graph_edge -> provider_response
  const chainId = await findChainIdForEntity(db, "graph_edge", params.graphEdgeId);
  if (chainId) {
    await appendLineageStep(db, chainId, {
      stage: "flow_analysis",
      entityType: "flow_analysis",
      entityId: id,
      description: `${params.analysisType} analysis`,
      metadata: { status: params.status, discrepancyUsd: params.discrepancyUsd }
    });
  }

  return id;
}

/**
 * Record risk/alert and link to flow analysis / graph edge via lineage.
 */
export async function recordRiskAlert(
  db: Db,
  params: {
    caseId: string;
    flowAnalysisId: string | null;
    graphEdgeId: string | null;
    entityId: string | null;
    alertType: RiskAlertRecord["alertType"];
    severity: RiskAlertRecord["severity"];
    title: string;
    description: string;
    evidence: unknown;
    sourceStepIds: string[];
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO risk_alerts_lineage (id, case_id, flow_analysis_id, graph_edge_id, entity_id, alert_type, severity, title, description, evidence, source_steps, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, params.caseId, params.flowAnalysisId, params.graphEdgeId, params.entityId, params.alertType, params.severity, params.title, params.description, JSON.stringify(params.evidence), params.sourceStepIds, now]
  );

  // Find lineage chain via graph_edge (preferred) or flow_analysis
  let chainId: string | null = null;
  if (params.graphEdgeId) {
    chainId = await findChainIdForEntity(db, "graph_edge", params.graphEdgeId);
  } else if (params.flowAnalysisId) {
    chainId = await findChainIdForEntity(db, "flow_analysis", params.flowAnalysisId);
  }
  if (chainId) {
    await appendLineageStep(db, chainId, {
      stage: "risk_alert",
      entityType: "risk_alert",
      entityId: id,
      description: `${params.severity.toUpperCase()} ${params.alertType}: ${params.title}`,
      metadata: { evidence: params.evidence }
    });
  }

  return id;
}

/**
 * Record report finding and link to risk/alert via lineage.
 */
export async function recordReportFinding(
  db: Db,
  params: {
    caseId: string;
    reportId: string;
    riskAlertId: string | null;
    flowAnalysisId: string | null;
    findingType: string;
    title: string;
    description: string;
    sourceStepIds: string[];
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO report_findings (id, case_id, report_id, risk_alert_id, flow_analysis_id, finding_type, title, description, source_steps, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, params.caseId, params.reportId, params.riskAlertId, params.flowAnalysisId, params.findingType, params.title, params.description, params.sourceStepIds, now]
  );

  // Find lineage chain via risk_alert -> graph_edge -> provider_response
  let chainId: string | null = null;
  if (params.riskAlertId) {
    chainId = await findChainIdForEntity(db, "risk_alert", params.riskAlertId);
  } else if (params.flowAnalysisId) {
    chainId = await findChainIdForEntity(db, "flow_analysis", params.flowAnalysisId);
  }
  if (chainId) {
    await appendLineageStep(db, chainId, {
      stage: "report_finding",
      entityType: "report_finding",
      entityId: id,
      description: `${params.findingType}: ${params.title}`,
      metadata: { reportId: params.reportId }
    });
  }

  return id;
}

/**
 * Record audit record and link to finding via lineage.
 */
export async function recordAuditWithLineage(
  db: Db,
  params: {
    caseId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    findingId: string | null;
    riskAlertId: string | null;
    flowAnalysisId: string | null;
    graphEdgeId: string | null;
    description: string;
    actorId: string;
    actorEmail: string;
    ip: string | null;
    userAgent: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO audit_log (id, at, actor_id, actor_email, action, entity_type, entity_id, case_ref, before, after, ip, user_agent, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT case_ref FROM cases WHERE id = $8),'{}', $9, $10, $11, 'success')`,
    [id, now, params.actorId, params.actorEmail, params.action, params.entityType, params.entityId, params.caseId, JSON.stringify({ findingId: params.findingId, riskAlertId: params.riskAlertId, flowAnalysisId: params.flowAnalysisId, graphEdgeId: params.graphEdgeId, description: params.description }), params.ip, params.userAgent]
  );

  // Find lineage chain via findingId (preferred) or riskAlertId or flowAnalysisId or graphEdgeId
  let chainId: string | null = null;
  if (params.findingId) {
    chainId = await findChainIdForEntity(db, "report_finding", params.findingId);
  } else if (params.riskAlertId) {
    chainId = await findChainIdForEntity(db, "risk_alert", params.riskAlertId);
  } else if (params.flowAnalysisId) {
    chainId = await findChainIdForEntity(db, "flow_analysis", params.flowAnalysisId);
  } else if (params.graphEdgeId) {
    chainId = await findChainIdForEntity(db, "graph_edge", params.graphEdgeId);
  }
  if (chainId) {
    await appendLineageStep(db, chainId, {
      stage: "audit_record",
      entityType: "audit_record",
      entityId: id,
      description: `Audit: ${params.action} on ${params.entityType}`,
      metadata: { action: params.action }
    });
  }

  return id;
}

/**
 * Get full lineage chain for a report finding
 */
export async function getLineageForFinding(
  db: Db,
  findingId: string
): Promise<LineageChain | null> {
  const finding = await one<{ id: string; case_id: string; report_id: string }>(
    db,
    `SELECT id, case_id, report_id FROM report_findings WHERE id = $1`,
    [findingId]
  );

  if (!finding) return null;

  // Find the chain ID by walking from finding to root provider response
  const chainId = await findChainIdForEntity(db, "report_finding", findingId);
  if (!chainId) return null;

  const steps = await many<LineageStep>(
    db,
    `SELECT ls.*, ls.chain_id as "chainId" FROM lineage_steps ls
     WHERE ls.chain_id = $1
     ORDER BY ls.step`,
    [chainId]
  );

  if (!steps.length) return null;

  const firstStep = steps[0]!;
  const lastStep = steps[steps.length - 1]!;

  return {
    id: chainId,
    rootId: firstStep.entityId,
    caseId: finding.case_id,
    steps,
    createdAt: firstStep.createdAt,
    updatedAt: lastStep.createdAt
  };
}