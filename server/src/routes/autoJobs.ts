import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, badRequest, notFound, conflict } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, one, many, type SqlParam } from "../db/index.js";

export const autoJobsRouter = Router();
autoJobsRouter.use(requireAuth);

const autoProcessConfigSchema = z.object({
  createCase: z.boolean().default(true),
  caseTitle: z.string().max(300).optional(),
  caseChain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]).optional(),
  analyzeDocument: z.boolean().default(true),
  applyIndicators: z.boolean().default(true),
  applyCaseFields: z.boolean().default(false),
  runTraces: z.boolean().default(true),
  maxHops: z.number().int().min(1).max(6).default(2),
  generateAlerts: z.boolean().default(true),
  generatePdf: z.boolean().default(true),
  traceSubjects: z.array(z.string()).optional()
});

/**
 * Statuses that mean "this job still owns the document". Kept as one list so
 * the enqueue guard and the list filter cannot drift apart.
 */
const IN_FLIGHT_STATUSES = [
  "queued", "running", "retry", "creating_case", "uploading_document",
  "extracting_text", "analyzing_document", "validating_indicators",
  "applying_indicators", "running_traces", "building_ledger",
  "generating_risk_alerts", "generating_pdf"
] as const;

const AUTO_JOB_STATUSES = [...IN_FLIGHT_STATUSES, "completed", "failed", "cancelled"] as const;

autoJobsRouter.post(
  "/auto-jobs",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const body = z.object({
      documentId: z.string().uuid(),
      caseId: z.string().uuid().optional(),
      config: autoProcessConfigSchema.optional()
    }).parse(req.body ?? {});

    const doc = await one<{ id: string; case_id: string; status: string }>(
      db, `SELECT id, case_id, status FROM documents WHERE id = $1`, [body.documentId]
    );
    if (!doc) throw notFound("Document not found");

    if (doc.status === "failed") {
      throw badRequest("Cannot process a document that failed extraction");
    }

    const caseId = body.caseId ?? doc.case_id;

    // Always run the config through the schema, even when the caller omitted
    // it. `body.config ?? {}` would store `{}`, and the worker reads these
    // booleans directly, so an omitted config would silently produce a job
    // that skips every step and reports success.
    const config = autoProcessConfigSchema.parse(body.config ?? {});

    if (!caseId && !config.createCase) {
      throw badRequest("No caseId provided and createCase is false");
    }

    const existing = await one<{ id: string }>(
      db,
      `SELECT id FROM auto_process_jobs WHERE document_id = $1 AND status = ANY($2::text[])`,
      [body.documentId, [...IN_FLIGHT_STATUSES]]
    );
    if (existing) {
      throw conflict("An auto-process job is already running for this document");
    }

    const job = await one<{ id: string; created_at: string }>(
      db,
      `INSERT INTO auto_process_jobs (case_id, document_id, status, config, created_by)
       VALUES ($1,$2,'queued',$3,$4) RETURNING id, created_at`,
      [caseId ?? null, body.documentId, JSON.stringify({ ...config, userId: req.user!.id }), req.user!.id]
    );

    if (!job) throw new Error("Failed to create auto-process job");

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "auto_job.create",
      entityType: "auto_process_job",
      entityId: job.id,
      caseRef: caseId ? (await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [caseId]))?.case_ref : null,
      after: { documentId: body.documentId, config },
      req
    });

    res.status(201).json({ job: { id: job.id, status: "queued", createdAt: job.created_at } });
  })
);

autoJobsRouter.get(
  "/auto-jobs",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const q = z.object({
      status: z.enum(AUTO_JOB_STATUSES).optional(),
      caseId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    }).parse(req.query);

    let where = "";
    const params: SqlParam[] = [];
    const conditions: string[] = [];

    if (q.status) { params.push(q.status); conditions.push(`status = $${params.length}`); }
    if (q.caseId) { params.push(q.caseId); conditions.push(`case_id = $${params.length}`); }
    if (conditions.length) where = "WHERE " + conditions.join(" AND ");

    params.push(q.limit, q.offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const jobs = await many(db,
      `SELECT id, case_id, document_id, status, progress, config, result, error, created_by, created_at, started_at, completed_at
       FROM auto_process_jobs ${where}
       ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    res.json({ jobs });
  })
);

autoJobsRouter.get(
  "/auto-jobs/:id",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const job = await one(db,
      `SELECT id, case_id, document_id, status, progress, config, result, error, created_by, created_at, started_at, completed_at
       FROM auto_process_jobs WHERE id = $1`, [id]
    );
    if (!job) throw notFound("Auto-process job not found");

    res.json({ job });
  })
);

autoJobsRouter.post(
  "/auto-jobs/:id/retry",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const job = await one<{ id: string; status: string }>(db, `SELECT id, status FROM auto_process_jobs WHERE id = $1`, [id]);
    if (!job) throw notFound("Auto-process job not found");
    if (job.status !== "failed") throw conflict(`Cannot retry job with status: ${job.status}`);

    await db.query(
      `UPDATE auto_process_jobs SET status = 'queued', error = NULL, progress = '{}', attempts = 0 WHERE id = $1`,
      [id]
    );

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "auto_job.retry",
      entityType: "auto_process_job",
      entityId: id,
      req
    });

    res.json({ retried: true });
  })
);

autoJobsRouter.delete(
  "/auto-jobs/:id",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const job = await one<{ id: string; status: string }>(db, `SELECT id, status FROM auto_process_jobs WHERE id = $1`, [id]);
    if (!job) throw notFound("Auto-process job not found");
    if (job.status === "running") throw conflict("Cannot delete a running job");

    await db.query(`DELETE FROM auto_process_jobs WHERE id = $1`, [id]);

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "auto_job.delete",
      entityType: "auto_process_job",
      entityId: id,
      req
    });

    res.json({ deleted: true });
  })
);

const traceJobConfigSchema = z.object({
  caseId: z.string().uuid(),
  tracePlanId: z.string().uuid().optional(),
  chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
  rootAddress: z.string().max(200),
  maxHops: z.number().int().min(1).max(6).default(3),
  direction: z.enum(["forward", "backward", "both"]).default("forward"),
  maxNodes: z.number().int().min(5).max(300).default(120),
  maxEdges: z.number().int().min(10).max(500).default(150)
});

autoJobsRouter.post(
  "/trace-jobs",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const config = traceJobConfigSchema.parse(req.body ?? {});

    const job = await one<{ id: string; created_at: string }>(
      db,
      `INSERT INTO trace_jobs (case_id, trace_plan_id, chain, root_address, max_hops, direction, max_nodes, max_edges, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9) RETURNING id, created_at`,
      [config.caseId, config.tracePlanId ?? null, config.chain, config.rootAddress, config.maxHops, config.direction, config.maxNodes, config.maxEdges, req.user!.id]
    );

    if (!job) throw new Error("Failed to create trace job");

    const caseRow = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [config.caseId]);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "trace_job.create",
      entityType: "trace_job",
      entityId: job.id,
      caseRef: caseRow?.case_ref ?? null,
      after: config,
      req
    });

    res.status(201).json({ job: { id: job.id, status: "queued", createdAt: job.created_at } });
  })
);

autoJobsRouter.get(
  "/trace-jobs",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const q = z.object({
      caseId: z.string().uuid().optional(),
      status: z.enum(["queued","running","partial","completed","failed","cancelled"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50)
    }).parse(req.query);

    let where = "WHERE 1=1";
    const params: SqlParam[] = [];
    if (q.caseId) { params.push(q.caseId); where += ` AND case_id = $${params.length}`; }
    if (q.status) { params.push(q.status); where += ` AND status = $${params.length}`; }
    params.push(q.limit);

    const jobs = await many(db,
      `SELECT id, case_id, trace_plan_id, chain, root_address, max_hops, direction, max_nodes, max_edges, status, progress, result_trace_id, error, started_at, completed_at, created_at
       FROM trace_jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );

    res.json({ jobs });
  })
);

autoJobsRouter.get(
  "/trace-jobs/:id",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const job = await one(db, `SELECT * FROM trace_jobs WHERE id = $1`, [id]);
    if (!job) throw notFound("Trace job not found");

    const snapshots = await many(db,
      `SELECT id, snapshot_type, node_count, edge_count, risk_score, risk_level, description, created_at
       FROM trace_snapshots WHERE trace_job_id = $1 ORDER BY created_at`,
      [id]
    );

    res.json({ job, snapshots });
  })
);

autoJobsRouter.post(
  "/trace-jobs/:id/retry",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const job = await one<{ id: string; status: string }>(db, `SELECT id, status FROM trace_jobs WHERE id = $1`, [id]);
    if (!job) throw notFound("Trace job not found");
    if (job.status !== "failed") throw conflict(`Cannot retry job with status: ${job.status}`);

    await db.query(`UPDATE trace_jobs SET status = 'queued', error = NULL, progress = '{}' WHERE id = $1`, [id]);
    res.json({ retried: true });
  })
);

autoJobsRouter.post(
  "/trace-jobs/:id/cancel",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const job = await one<{ id: string; status: string }>(db, `SELECT id, status FROM trace_jobs WHERE id = $1`, [id]);
    if (!job) throw notFound("Trace job not found");
    if (!["queued", "running"].includes(job.status)) throw conflict(`Cannot cancel job with status: ${job.status}`);

    await db.query(`UPDATE trace_jobs SET status = 'cancelled', completed_at = now() WHERE id = $1`, [id]);
    res.json({ cancelled: true });
  })
);