import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";



export const teamRouter = Router();
teamRouter.use(requireAuth);

teamRouter.get(
  "/members",
  requirePermission("case:read"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    const members = await many(
      db,
      `SELECT u.id, u.display_name, u.email, u.role, u.agency, u.is_active, u.last_login_at, u.created_at,
              (SELECT count(*) FROM case_assignees ca WHERE ca.user_id = u.id)::int AS assigned_cases,
              (SELECT count(*) FROM cases c WHERE c.lead_investigator_id = u.id AND c.status <> 'Closed')::int AS open_cases_led,
              (SELECT count(*) FROM case_notes n WHERE n.author_id = u.id)::int AS notes_authored,
              (SELECT count(*) FROM evidence e WHERE e.collected_by = u.id)::int AS evidence_collected
       FROM users u
       ORDER BY u.is_active DESC, u.display_name`
    );

    const workload = await many<{ display_name: string; open_cases: number }>(
      db,
      `SELECT u.display_name,
              count(ca.case_id) FILTER (WHERE c.status <> 'Closed')::int AS open_cases
       FROM users u
       LEFT JOIN case_assignees ca ON ca.user_id = u.id
       LEFT JOIN cases c ON c.id = ca.case_id
       WHERE u.is_active
       GROUP BY u.id, u.display_name
       ORDER BY open_cases DESC`
    );

    res.json({ members, workload });
  })
);

teamRouter.get(
  "/activity",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit ?? 50);
    const db = await getDb();
    const activity = await many(
      db,
      `SELECT a.id, a.at, a.action, a.entity_type, a.case_ref, a.actor_email, u.display_name AS actor_name, u.role AS actor_role
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.outcome = 'success'
       ORDER BY a.at DESC LIMIT $1`,
      [limit]
    );
    res.json({ activity });
  })
);

teamRouter.get(
  "/saved-searches",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const searches = await many(
      db,
      `SELECT s.id, s.name, s.query, s.filters, s.shared, s.created_at, u.display_name AS owner
       FROM saved_searches s LEFT JOIN users u ON u.id = s.owner_id
       WHERE s.shared = TRUE OR s.owner_id = $1 ORDER BY s.created_at DESC`,
      [req.user!.id]
    );
    res.json({ searches });
  })
);

teamRouter.post(
  "/saved-searches",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z
      .object({
        name: z.string().min(2).max(120),
        query: z.string().min(1).max(2000),
        filters: z.record(z.unknown()).default({}),
        shared: z.boolean().default(false)
      })
      .parse(req.body);
    const db = await getDb();
    const row = await one(
      db,
      `INSERT INTO saved_searches (owner_id, name, query, filters, shared) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user!.id, body.name, body.query, JSON.stringify(body.filters), body.shared]
    );
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "saved_search.create",
      entityType: "saved_search",
      entityId: (row as { id: string }).id,
      after: { name: body.name, shared: body.shared },
      req
    });
    res.status(201).json({ search: row });
  })
);

teamRouter.delete(
  "/saved-searches/:id",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const owner = await one<{ owner_id: string }>(db, `SELECT owner_id FROM saved_searches WHERE id = $1`, [id]);
    if (!owner) throw notFound("Saved search not found");
    if (owner.owner_id !== req.user!.id && req.user!.role !== "admin") {
      res.status(403).json({ error: "forbidden", message: "You can only delete your own saved searches" });
      return;
    }
    await db.query(`DELETE FROM saved_searches WHERE id = $1`, [id]);
    res.status(204).end();
  })
);
