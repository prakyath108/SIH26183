import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";
import { caseEventBus } from "../status/events.js";
import { logger } from "../logger.js";

export const alertsRouter = Router();
alertsRouter.use(requireAuth);

alertsRouter.get(
  "/",
  requirePermission("alert:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const q = z
      .object({
        state: z.enum(["open", "acknowledged", "resolved", "dismissed"]).optional(),
        severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
        caseId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(req.query);
    const db = await getDb();

    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (q.state) {
      params.push(q.state);
      clauses.push(`a.state = $${params.length}`);
    }
    if (q.severity) {
      params.push(q.severity);
      clauses.push(`a.severity = $${params.length}`);
    }
    if (q.caseId) {
      params.push(q.caseId);
      clauses.push(`a.case_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // Over-fetch by one so the client can be told whether a further page exists
    // instead of inferring it from a page that merely looks full.
    params.push(q.limit + 1, q.offset);
    const rows = await many(
      db,
      `SELECT a.*, c.case_ref, c.title AS case_title, e.address AS entity_address, e.chain AS entity_chain
       FROM alerts a
       LEFT JOIN cases c ON c.id = a.case_id
       LEFT JOIN entities e ON e.id = a.entity_id
       ${where}
       ORDER BY
         array_position(ARRAY['critical','high','medium','low','info']::alert_severity[], a.severity),
         a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const hasMore = rows.length > q.limit;
    const alerts = hasMore ? rows.slice(0, q.limit) : rows;

    // Unfiltered, so the state tallies describe the whole register rather than
    // the current filter. The UI labels these as totals to keep the two
    // populations distinguishable.
    const counts = await many<{ state: string; n: number }>(db, `SELECT state, count(*)::int AS n FROM alerts GROUP BY state`);
    const severityCounts = await many<{ severity: string; n: number }>(
      db,
      `SELECT severity::text, count(*)::int AS n FROM alerts WHERE state = 'open' GROUP BY severity`
    );
    res.json({ alerts, counts, severityCounts, hasMore, limit: q.limit, offset: q.offset });
  })
);

alertsRouter.post(
  "/:id/acknowledge",
  requirePermission("alert:triage"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const before = await one<{ state: string; case_ref: string | null; title: string }>(
      db,
      `SELECT a.state, c.case_ref, a.title FROM alerts a LEFT JOIN cases c ON c.id = a.case_id WHERE a.id = $1`,
      [id]
    );
    if (!before) throw notFound("Alert not found");

    const updated = await one(
      db,
      `UPDATE alerts SET state = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
       WHERE id = $1 AND state = 'open' RETURNING *`,
      [id, req.user!.id]
    );
    if (!updated) {
      res.status(409).json({ error: "conflict", message: `Alert is already ${before.state}` });
      return;
    }
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "alert.acknowledge",
      entityType: "alert",
      entityId: id,
      caseRef: before.case_ref,
      before,
      after: { state: "acknowledged" },
      req
    });
    res.json({ alert: updated });
  })
);

alertsRouter.post(
  "/:id/resolve",
  requirePermission("alert:triage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z.object({ resolution: z.string().max(2000).optional() }).parse(req.body ?? {});
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const before = await one<{ state: string; case_ref: string | null; title: string }>(
      db,
      `SELECT a.state, c.case_ref, a.title FROM alerts a LEFT JOIN cases c ON c.id = a.case_id WHERE a.id = $1`,
      [id]
    );
    if (!before) throw notFound("Alert not found");

    const updated = await one(
      db,
      `UPDATE alerts SET state = 'resolved', resolved_by = $2, resolved_at = now(), detail = COALESCE($3, detail) WHERE id = $1 RETURNING *`,
      [id, req.user!.id, body.resolution ?? null]
    );
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "alert.resolve",
      entityType: "alert",
      entityId: id,
      caseRef: before.case_ref,
      before,
      after: { state: "resolved", resolution: body.resolution ?? null },
      req
    });
    res.json({ alert: updated });
  })
);

alertsRouter.post(
  "/:id/link-case",
  requirePermission("alert:triage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z.object({ caseId: z.string().uuid() }).parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const c = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [body.caseId]);
    if (!c) throw notFound("Case not found");

    const updated = await one(db, `UPDATE alerts SET case_id = $2 WHERE id = $1 RETURNING *`, [id, body.caseId]);
    if (!updated) throw notFound("Alert not found");
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "alert.link_case",
      entityType: "alert",
      entityId: id,
      caseRef: c.case_ref,
      after: { caseId: body.caseId },
      req
    });
    res.json({ alert: updated });
  })
);

/**
 * Rule evaluation over entities, run on demand.
 *
 * A sweep is investigator-triggered rather than scheduled so it is inspectable
 * and attributable. Alerts it raises are attached to whatever cases the scored
 * entity belongs to, and reported to the status engine, so a critical signal
 * escalates the cases it touches instead of sitting in a register nobody is
 * watching. An entity in no case produces a case-less alert: it is still a real
 * finding, and inventing an owning case for it would be wrong.
 */
alertsRouter.post(
  "/scan",
  requirePermission("alert:triage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.body ?? {});
    const db = await getDb();

    const candidates = await many<{ id: string; chain: string; address: string; risk_level: string; risk_score: number; risk_factors: unknown }>(
      db,
      `SELECT id, chain, address, risk_level, risk_score, risk_factors FROM entities ORDER BY risk_score DESC LIMIT $1`,
      [body.limit]
    );

    let created = 0;
    // Cases touched, so the risk pass is reported once per case rather than
    // once per alert.
    const touched = new Map<string, number>();

    for (const ent of candidates) {
      const factors = (ent.risk_factors ?? []) as { code: string; label: string; source: string; observedAt: string }[];
      for (const f of factors) {
        if (!["mixer_interaction", "sanctioned_exposure", "darknet_reference", "bridge_exposure"].includes(f.code)) continue;
        const dedupe = `${ent.chain}:${ent.address}:${f.code}`;
        const severity = ent.risk_level === "Critical" ? "critical" : ent.risk_level === "High" ? "high" : "medium";
        const inserted = await one<{ id: string }>(
          db,
          `INSERT INTO alerts (entity_id, severity, category, title, detail, dedupe_key, risk_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
          [
            ent.id,
            severity,
            f.code,
            `${f.label} — ${ent.address.slice(0, 10)}…${ent.address.slice(-6)}`,
            `Entity scored ${ent.risk_score}/100 (${ent.risk_level}). Indicator source: ${f.source}, observed ${f.observedAt}. Requires analyst review; not a determination of wrongdoing.`,
            dedupe,
            ent.risk_score
          ]
        );
        if (!inserted) continue;
        created += 1;

        // One entity can sit in several cases; the alert is raised on each, and
        // each case is told about it separately.
        const caseIds = await many<{ case_id: string }>(
          db,
          `SELECT case_id FROM case_entities WHERE entity_id = $1`,
          [ent.id]
        );
        for (const { case_id } of caseIds) {
          await db.query(`UPDATE alerts SET case_id = $2 WHERE id = $1`, [inserted.id, case_id]);
          await caseEventBus.alertCreated(case_id, req.user!.id, inserted.id, severity);
          touched.set(case_id, (touched.get(case_id) ?? 0) + 1);
        }
      }
    }

    // The risk pass is over for every case it covered, whether or not it raised
    // anything. Reported after the alerts so "analysis complete" is not observed
    // while alerts are still being written.
    for (const caseId of touched.keys()) {
      await caseEventBus.riskAnalysisCompleted(caseId, req.user!.id, touched.get(caseId));
    }

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "alert.scan",
      entityType: "alert",
      after: { scanned: candidates.length, created, casesAffected: touched.size },
      req
    });
    logger.info("Alert scan completed", { scanned: candidates.length, created, casesAffected: touched.size });
    res.json({ scanned: candidates.length, created, casesAffected: touched.size });
  })
);
