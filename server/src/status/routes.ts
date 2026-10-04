import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, badRequest, conflict, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { getDb, many, one } from "../db/index.js";
import { can } from "../security.js";
import { caseEventBus } from "./events.js";
import { allowedCaseTransitions, CASE_STATUSES, nextCaseStatus, type CaseStatus } from "../types.js";

/**
 * The status view of a case: where it is, how it got there, and what may
 * legitimately move it next.
 *
 * Mounted at `/api/status`. Push updates for these transitions are delivered over
 * the WebSocket in `server/src/ws/index.ts`, which subscribes to the same
 * `caseEventBus`.
 */
export const statusRouter = Router();
statusRouter.use(requireAuth);

const idParam = z.string().uuid();

/** Read a case row, or 404. */
async function loadCase(id: string): Promise<{ id: string; case_ref: string; status: CaseStatus }> {
  const db = await getDb();
  const row = await one<{ id: string; case_ref: string; status: CaseStatus }>(
    db,
    `SELECT id, case_ref, status FROM cases WHERE id = $1`,
    [id]
  );
  if (!row) throw notFound("Case not found");
  return row;
}

statusRouter.get(
  "/:id",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const id = idParam.parse(req.params.id);
    const db = await getDb();

    const row = await one(
      db,
      `SELECT id, case_ref, status, closed_at, closed_by, closure_note, created_at, updated_at
         FROM cases WHERE id = $1`,
      [id]
    );
    if (!row) throw notFound("Case not found");

    const status = row.status as CaseStatus;
    const role = req.user!.role;
    const last = await one<{ event_type: string; reason: string | null; created_at: string; to_status: string | null }>(
      db,
      `SELECT event_type, reason, created_at, to_status
         FROM case_events WHERE case_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [id]
    );

    res.json({
      case: row,
      status,
      nextStatus: nextCaseStatus(status),
      allowedTransitions: allowedCaseTransitions(status),
      permissions: {
        // Read from the permission matrix rather than a hardcoded role list, so
        // this cannot drift from what the routes actually enforce.
        canClose: can(role, "case:close"),
        canManualStatusChange: can(role, "case:write")
      },
      lastEvent: last
        ? { type: last.event_type, reason: last.reason, to: last.to_status, at: last.created_at }
        : null
    });
  })
);

/**
 * The pipeline log: every event the automated processing reported, in order.
 * Drives the Analysis view, so it is the real history rather than a projection
 * of the current status.
 */
statusRouter.get(
  "/:id/events",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const id = idParam.parse(req.params.id);
    const db = await getDb();
    const caseRow = await one<{ id: string }>(db, `SELECT id FROM cases WHERE id = $1`, [id]);
    if (!caseRow) throw notFound("Case not found");

    const events = await many(
      db,
      `SELECT ce.id, ce.event_type, ce.actor_id, u.display_name AS actor_name,
              ce.from_status, ce.to_status, ce.reason, ce.detail, ce.created_at
         FROM case_events ce
         LEFT JOIN users u ON u.id = ce.actor_id
        WHERE ce.case_id = $1
        ORDER BY ce.created_at ASC, ce.id ASC`,
      [id]
    );
    res.json({ events });
  })
);

const changeSchema = z.object({
  status: z.enum(CASE_STATUSES as [string, ...string[]]),
  closureNote: z.string().min(10).max(5000).optional()
});

/**
 * Set a status explicitly. Restricted to roles that hold `case:write`; closing
 * is still refused by the shared transition logic unless the role also holds
 * `case:close`, so this endpoint cannot be used to route around that grant.
 */
statusRouter.post(
  "/:id/change",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = changeSchema.parse(req.body);
    const id = idParam.parse(req.params.id);
    const row = await loadCase(id);

    const outcome = await caseEventBus.manualStatusChange(id, req.user!.id, row.status, body.status, body.closureNote);
    if (!outcome) throw badRequest("The status change could not be applied");
    if (!outcome.changed && outcome.transition === "none" && body.status !== row.status) {
      throw conflict(`A case in â€œ${row.status}â€ cannot move to â€œ${body.status}â€.`);
    }

    res.json({ caseId: id, from: outcome.from, to: outcome.to, changed: outcome.changed, reason: outcome.reason });
  })
);

const escalateSchema = z.object({ reason: z.string().min(10).max(500) });

/**
 * Escalate. Any role that can read a case may raise one, because a reviewer
 * noticing a problem should not have to wait for an account that can also write.
 */
statusRouter.post(
  "/:id/escalate",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const { reason } = escalateSchema.parse(req.body);
    const id = idParam.parse(req.params.id);
    await loadCase(id);

    const outcome = await caseEventBus.escalationRequired(id, req.user!.id, reason);
    res.json({ caseId: id, escalated: true, reason, from: outcome?.from ?? null, to: outcome?.to ?? null });
  })
);

/**
 * Resolve an escalation, returning the case to Under Review.
 *
 * A higher-severity alert on the case re-escalates it, so resolving one
 * condition cannot quietly sign off a case that has since raised another.
 */
statusRouter.post(
  "/:id/deescalate",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const { reason } = escalateSchema.parse(req.body);
    const id = idParam.parse(req.params.id);
    const db = await getDb();

    const row = await one<{ status: CaseStatus }>(db, `SELECT status FROM cases WHERE id = $1`, [id]);
    if (!row) throw notFound("Case not found");
    if (row.status !== "Escalated") throw badRequest("Case is not escalated");

    const stillOpen = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM alerts WHERE case_id = $1 AND state = 'open' AND severity = 'critical'`,
      [id]
    );
    if ((stillOpen?.n ?? 0) > 0) {
      throw conflict(
        `${stillOpen?.n} critical alert(s) on this case are still open. Resolve or acknowledge them before clearing the escalation.`
      );
    }

    const outcome = await caseEventBus.escalationResolved(id, req.user!.id, reason);
    res.json({ caseId: id, deescalated: true, reason, from: outcome?.from ?? null, to: outcome?.to ?? null });
  })
);

statusRouter.post(
  "/:id/review/start",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const id = idParam.parse(req.params.id);
    await loadCase(id);
    const outcome = await caseEventBus.reviewStarted(id, req.user!.id);
    res.json({ caseId: id, reviewStarted: true, from: outcome?.from ?? null, to: outcome?.to ?? null });
  })
);

