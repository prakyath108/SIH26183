import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";

import { clientIp } from "../middleware/audit.js";

export const auditRouter = Router();
auditRouter.use(requireAuth);

const listSchema = z.object({
  actor: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(60).optional(),
  caseRef: z.string().max(60).optional(),
  outcome: z.enum(["success", "failure"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

auditRouter.get(
  "/",
  requirePermission("audit:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const q = listSchema.parse(req.query);
    const db = await getDb();

    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    const add = (sql: (placeholder: string) => string, value: string) => {
      params.push(value);
      clauses.push(sql(`$${params.length}`));
    };

    if (q.actor) add((p) => `(a.actor_email = ${p} OR u.display_name ILIKE ${p})`, q.actor);
    if (q.action) add((p) => `a.action = ${p}`, q.action);
    if (q.entityType) add((p) => `a.entity_type = ${p}`, q.entityType);
    if (q.caseRef) add((p) => `a.case_ref ILIKE ${p}`, `%${q.caseRef}%`);
    if (q.outcome) add((p) => `a.outcome = ${p}`, q.outcome);
    if (q.from) add((p) => `a.at >= ${p}`, q.from);
    if (q.to) add((p) => `a.at <= ${p}`, q.to);

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(q.limit, q.offset);

    const entries = await many(
      db,
      `SELECT a.id, a.at, a.actor_id, a.actor_email, a.action, a.entity_type, a.entity_id, a.case_ref,
              a.before, a.after, a.ip, a.user_agent, a.outcome, u.display_name AS actor_name, u.role AS actor_role
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${where}
       ORDER BY a.at DESC, a.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const actions = await many<{ action: string; n: number }>(
      db,
      `SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY n DESC LIMIT 50`
    );

    res.json({ entries, actions, limit: q.limit, offset: q.offset });
  })
);

/** CSV export of the audit trail, for external retention. */
auditRouter.get(
  "/export",
  requirePermission("audit:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const q = listSchema.omit({ limit: true, offset: true }).parse(req.query);
    const db = await getDb();
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    if (q.actor) {
      params.push(q.actor);
      clauses.push(`actor_email = $${params.length}`);
    }
    if (q.action) {
      params.push(q.action);
      clauses.push(`action = $${params.length}`);
    }
    if (q.caseRef) {
      params.push(`%${q.caseRef}%`);
      clauses.push(`case_ref ILIKE $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = await many<Record<string, unknown>>(db, `SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT 100000`, params);
    const csv = toCsv(rows);

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "audit.export",
      entityType: "audit_log",
      after: { rows: rows.length, ip: clientIp(req) },
      req
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="cryptotrace-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  })
);

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "id,at,actor_email,action,entity_type,entity_id,case_ref,outcome\n";
  const columns = Object.keys(rows[0]!);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

auditRouter.get(
  "/verify",
  requirePermission("audit:read"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    // The trigger blocks UPDATE/DELETE outright; this confirms the trigger exists.
    const trigger = await one<{ tgname: string }>(
      db,
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal ORDER BY tgname LIMIT 1`
    );
    const count = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log`);
    res.json({
      appendOnly: Boolean(trigger),
      trigger: trigger?.tgname ?? null,
      entries: count?.n ?? 0,
      verifiedAt: new Date().toISOString(),
      note: "Update and delete on audit_log are rejected by a database trigger. For tamper evidence against a database superuser, export and hash this log to external storage on a schedule."
    });
  })
);
