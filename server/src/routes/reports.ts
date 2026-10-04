import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { findCaseByIdOrRef, getDb, many, one } from "../db/index.js";

import { CASE_STATUSES, RISK_LEVELS } from "../types.js";
import { CHAINS } from "../chains/index.js";
import { CHAIN_META } from "../chains/detect.js";
import { RULES, DEFAULT_THRESHOLDS } from "../risk/engine.js";
import type { RiskFactor } from "../types.js";

/**
 * Read models that back the dashboard and the remaining reporting modules.
 * Aggregates are computed in SQL rather than in the client so the numbers on
 * screen are the numbers in the database.
 */

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.get(
  "/dashboard",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const days = z.coerce.number().int().min(7).max(180).default(30).parse(req.query.days ?? 30);

    const [kpis, statusMix, riskMix, activity, topRisk, recentAlerts] = await Promise.all([
      one<{ open_cases: number; critical_cases: number; entities: number; high_risk: number; evidence: number; open_alerts: number; critical_alerts: number; traced_usd: string | null }>(
        db,
        `SELECT
           count(*) FILTER (WHERE status <> 'Closed')::int AS open_cases,
           count(*) FILTER (WHERE status <> 'Closed' AND priority = 'Critical')::int AS critical_cases,
           (SELECT count(*)::int FROM entities) AS entities,
           (SELECT count(*)::int FROM entities WHERE risk_score >= 55) AS high_risk,
           (SELECT count(*)::int FROM evidence) AS evidence,
           (SELECT count(*)::int FROM alerts WHERE state = 'open') AS open_alerts,
           (SELECT count(*)::int FROM alerts WHERE state = 'open' AND severity = 'critical') AS critical_alerts,
           (SELECT COALESCE(SUM(amount_usd),0) FROM case_entities WHERE amount_usd IS NOT NULL) AS traced_usd
         FROM cases`
      ),
      many<{ status: string; n: number }>(db, `SELECT status, count(*)::int AS n FROM cases GROUP BY status`),
      many<{ priority: string; n: number }>(db, `SELECT priority, count(*)::int AS n FROM cases GROUP BY priority`),
      many<{ day: string; opened: number; closed: number }>(
        db,
        `WITH days AS (
           SELECT generate_series(date_trunc('day', now()) - ($1::int || ' days')::interval, date_trunc('day', now()), '1 day')::date AS day
         )
         SELECT d.day::text AS day,
                count(c.id) FILTER (WHERE c.opened_at::date = d.day)::int AS opened,
                count(c.id) FILTER (WHERE c.closed_at::date = d.day)::int AS closed
         FROM days d LEFT JOIN cases c ON c.opened_at::date = d.day OR c.closed_at::date = d.day
         GROUP BY d.day ORDER BY d.day`,
        [days]
      ),
      many(
        db,
        `SELECT e.id, e.chain, e.address, e.label, e.risk_score, e.risk_level, e.kind,
                (SELECT count(*) FROM case_entities ce WHERE ce.entity_id = e.id)::int AS linked_cases
         FROM entities e WHERE e.risk_score > 0
         ORDER BY e.risk_score DESC LIMIT 10`
      ),
      many(
        db,
        `SELECT a.id, a.severity, a.category, a.title, a.detail, a.created_at, c.case_ref
         FROM alerts a LEFT JOIN cases c ON c.id = a.case_id
         WHERE a.state IN ('open','acknowledged') ORDER BY a.created_at DESC LIMIT 8`
      )
    ]);

    res.json({
      kpis,
      statusMix,
      riskMix,
      activity,
      topRisk,
      recentAlerts,
      chains: CHAINS.map((c: (typeof CHAINS)[number]) => ({ chain: c, ...CHAIN_META[c] })),
      thresholds: DEFAULT_THRESHOLDS,
      generatedAt: new Date().toISOString(),
      caveat: "Risk figures are triage signals from configurable rules, not determinations of wrongdoing."
    });
  })
);

reportsRouter.get(
  "/risk-distribution",
  requirePermission("case:read"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    // The cut-offs come from the engine's own constants rather than being
    // retyped here. A literal copy silently drifts the moment a band moves,
    // and the resulting chart would disagree with every score in the system.
    const bands = await many<{ band: string; n: number }>(
      db,
      `SELECT CASE
                WHEN risk_score >= $1 THEN 'Critical'
                WHEN risk_score >= $2 THEN 'High'
                WHEN risk_score >= $3 THEN 'Medium'
                WHEN risk_score >= $4 THEN 'Low'
                ELSE 'Unrated' END AS band,
              count(*)::int AS n
       FROM entities GROUP BY band`,
      [DEFAULT_THRESHOLDS.critical, DEFAULT_THRESHOLDS.high, DEFAULT_THRESHOLDS.medium, DEFAULT_THRESHOLDS.low]
    );
    const byChain = await many<{ chain: string; avg_score: string; n: number }>(
      db,
      `SELECT chain, ROUND(AVG(risk_score), 1)::text AS avg_score, count(*)::int AS n FROM entities GROUP BY chain`
    );
    const factors = await many<{ code: string; label: string; n: number }>(
      db,
      `SELECT f->>'code' AS code, f->>'label' AS label, count(*)::int AS n
       FROM entities e, jsonb_array_elements(e.risk_factors) f
       GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`
    );
    res.json({ bands, byChain, factors, thresholds: DEFAULT_THRESHOLDS });
  })
);

/**
 * Case-specific risk signals with full detail for the risk screen.
 * Returns individual risk signals with node, transaction, evidence, and explanation.
 */
reportsRouter.get(
  "/cases/:id/risk-signals",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);

    // Get case entities with their risk factors
    const entities = await many<{
      id: string;
      chain: string;
      address: string;
      kind: string;
      label: string | null;
      risk_score: number;
      risk_level: string;
      risk_factors: RiskFactor[] | null;
      hop_count: number;
      amount_usd: string | null;
    }>(
      db,
      `SELECT e.id, e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level,
              e.risk_factors, ce.hop_count, ce.amount_usd
       FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
       WHERE ce.case_id = $1 ORDER BY e.risk_score DESC`,
      [caseId]
    );

    // Get case transactions for flow values (reserved for future signal enrichment)
    const _transactions = await many<{
      tx_hash: string;
      chain: string;
      from_address: string;
      to_address: string;
      value_native: string;
      value_usd: string | null;
      timestamp: string;
    }>(
      db,
      `SELECT t.tx_hash, t.chain, t.from_address, t.to_address, t.value_native, t.value_usd, t.timestamp
       FROM transactions t
       JOIN case_transactions ct ON ct.transaction_id = t.id
       WHERE ct.case_id = $1 ORDER BY t.timestamp DESC LIMIT 200`,
      [caseId]
    );

    // Get alerts for this case
    const alerts = await many<{
      id: string;
      severity: string;
      category: string;
      title: string;
      detail: string | null;
      created_at: string;
      entity_id: string | null;
    }>(
      db,
      `SELECT id, severity, category, title, detail, created_at, entity_id
       FROM alerts WHERE case_id = $1 ORDER BY created_at DESC`,
      [caseId]
    );

    // Build detailed risk signals
    const signals = entities.flatMap((e) => {
      const factors = e.risk_factors ?? [];
      return factors.map((f) => ({
        node: {
          address: e.address,
          chain: e.chain,
          label: e.label,
          kind: e.kind,
          hop: e.hop_count,
          riskScore: e.risk_score,
          riskLevel: e.risk_level
        },
        transaction: null as { txHash: string; chain: string; valueUsd: string | null } | null,
        riskSignal: f.label,
        evidence: f.evidence,
        explanation: f.detail,
        confidence: f.confidence,
        timestamp: new Date().toISOString(),
        alertId: alerts.find((a) => a.entity_id === e.id)?.id ?? null
      }));
    });

    // Calculate summary KPIs
    const criticalCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.critical).length;
    const highCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.high && e.risk_score < DEFAULT_THRESHOLDS.critical).length;
    const mediumCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.medium && e.risk_score < DEFAULT_THRESHOLDS.high).length;
    const lowCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.low && e.risk_score < DEFAULT_THRESHOLDS.medium).length;

    const tracedUsd = entities.reduce((sum, e) => sum + Number(e.amount_usd ?? 0), 0);
    const suspiciousFlowUsd = entities
      .filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.high)
      .reduce((sum, e) => sum + Number(e.amount_usd ?? 0), 0);
    const exchangeExposureUsd = entities
      .filter((e) => (e.risk_factors ?? []).some((f) => f.code === "exchange_deposit"))
      .reduce((sum, e) => sum + Number(e.amount_usd ?? 0), 0);
    const crossChainExposureUsd = entities
      .filter((e) => (e.risk_factors ?? []).some((f) => f.code === "bridge_exposure"))
      .reduce((sum, e) => sum + Number(e.amount_usd ?? 0), 0);
    const unresolvedNodes = entities.filter((e) => (e.risk_factors ?? []).length === 0).length;

    res.json({
      signals,
      summary: {
        criticalSignals: criticalCount,
        highSignals: highCount,
        mediumSignals: mediumCount,
        lowSignals: lowCount,
        unresolvedNodes,
        totalValueTraced: tracedUsd,
        suspiciousFlowValue: suspiciousFlowUsd,
        exchangeExposure: exchangeExposureUsd,
        crossChainExposure: crossChainExposureUsd
      }
    });
  })
);

/** Rules reference, so the UI can explain any score it displays. */
reportsRouter.get("/risk-rules", requirePermission("case:read"), (_req: Request, res: Response) => {
  res.json({
    thresholds: DEFAULT_THRESHOLDS,
    rules: RULES.map((r) => ({
      code: r.code,
      label: r.label,
      defaultWeight: r.weight,
      confidence: r.confidence,
      detail: r.detail,
      source: r.source,
      limitations: r.limitations ?? null
    }))
  });
});

/**
 * Structured case report. Sections are deliberately labelled by evidentiary
 * weight so a reader cannot mistake an analyst hypothesis for a chain fact.
 */
reportsRouter.get(
  "/cases/:id",
  requirePermission("evidence:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    // Accepts a case UUID or a human case_ref, e.g. CT-2026-0004.
    const found = await findCaseByIdOrRef<Record<string, unknown>>(db, String(req.params.id ?? ""));
    if (!found) {
      res.status(404).json({ error: "not_found", message: "Case not found" });
      return;
    }
    const id = String(found.id);

    const c = await one<Record<string, unknown>>(
      db,
      `SELECT c.*, u.display_name AS lead_name, u.email AS lead_email
       FROM cases c LEFT JOIN users u ON u.id = c.lead_investigator_id WHERE c.id = $1::uuid`,
      [id]
    );
    if (!c) {
      res.status(404).json({ error: "not_found", message: "Case not found" });
      return;
    }

    const [entities, evidence, traces, notes, alerts, labels] = await Promise.all([
      many(
        db,
        `SELECT e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level, e.risk_factors, e.tx_count,
                ce.hop_count, ce.amount_usd
         FROM case_entities ce JOIN entities e ON e.id = ce.entity_id WHERE ce.case_id = $1
         ORDER BY ce.hop_count, e.risk_score DESC`,
        [id]
      ),
      many(
        db,
        `SELECT id, kind, title, description, chain, address, tx_hash, content_sha256, collected_at FROM evidence
         WHERE case_id = $1 ORDER BY collected_at`,
        [id]
      ),
      many(
        db,
        `SELECT id, chain, root_address, max_hops, direction, node_count, edge_count, total_usd, risk_score, risk_level, created_at
         FROM traces WHERE case_id = $1 ORDER BY created_at`,
        [id]
      ),
      many(
        db,
        `SELECT n.body, n.kind, n.created_at, u.display_name AS author
         FROM case_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.case_id = $1 ORDER BY n.created_at`,
        [id]
      ),
      many(db, `SELECT severity, state, category, title, detail, created_at, resolved_at FROM alerts WHERE case_id = $1`, [id]),
      many(
        db,
        `SELECT l.chain, l.address, l.kind, l.name, l.source, l.source_url, l.confidence, l.observed_at, l.status
         FROM labels l
         JOIN case_entities ce ON ce.entity_id = (SELECT id FROM entities WHERE chain = l.chain AND address = l.address)
         WHERE ce.case_id = $1`,
        [id]
      )
    ]);

    res.json({
      case: c,
      sections: {
        chainFacts: { entities, traces },
        thirdPartyAttribution: { labels },
        analystHypotheses: { notes: notes.filter((n) => (n as { kind: string }).kind === "hypothesis") },
        evidence: { items: evidence },
        alerts,
        analystFindings: { notes: notes.filter((n) => (n as { kind: string }).kind === "finding") }
      },
      methodology: {
        riskScoring: "Weighted rule matches discounted by confidence, saturating curve to 0-100. Weights are operator-configurable.",
        dataSources: "Public chain endpoints (mempool.space, Cloudflare Ethereum RPC, TronGrid). Public data can be stale or inconsistent; corroborate before relying on it.",
        limitations: [
          "Public nodes generally cannot enumerate address history on EVM chains; coverage is partial for Ethereum and Polygon.",
          "A wallet address is pseudonymous. No finding here identifies a person or establishes unlawful conduct.",
          "Third-party labels may be stale, incomplete or incorrect and remain subject to analyst challenge.",
          "Tracing is bounded by the hop, node, edge and time limits used for the run; a bounded graph is not a complete picture of the funds."
        ]
      },
      generatedAt: new Date().toISOString(),
      generatedBy: { id: req.user!.id, email: req.user!.email, role: req.user!.role }
    });
  })
);

reportsRouter.get("/meta", requirePermission("case:read"), (_req: Request, res: Response) => {
  res.json({ chains: CHAINS, statuses: CASE_STATUSES, priorities: RISK_LEVELS, roles: ["admin", "investigator", "analyst", "viewer"] });
});
