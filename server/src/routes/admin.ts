import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";
import { CHAINS, RISK_LEVELS } from "../types.js";
import { RULES, DEFAULT_THRESHOLDS } from "../risk/engine.js";
import { chainHealth } from "../chains/index.js";
import { env } from "../config.js";
import { can, permissionsFor, hashPassword, PERMISSIONS } from "../security.js";
import type { UserRole } from "../types.js";

export const adminRouter = Router();
adminRouter.use(requireAuth);

// ------------------------------------------------------------------- users
adminRouter.get(
  "/users",
  requirePermission("user:manage"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    const users = await many(
      db,
      `SELECT u.id, u.email, u.display_name, u.role, u.agency, u.is_active, u.last_login_at, u.created_at,
              (SELECT count(*) FROM case_assignees ca WHERE ca.user_id = u.id)::int AS assigned_cases,
              (SELECT count(*) FROM cases c WHERE c.lead_investigator_id = u.id)::int AS led_cases
       FROM users u ORDER BY u.role, u.display_name`
    );
    res.json({ users, roles: roleMatrix() });
  })
);

function roleMatrix() {
  const roles: UserRole[] = ["admin", "investigator", "analyst", "viewer"];
  return roles.map((role) => ({
    role,
    permissions: permissionsFor(role),
    capabilities: (Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]).filter((p) => can(role, p))
  }));
}

const createUserSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(2).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(["admin", "investigator", "analyst", "viewer"]),
  agency: z.string().max(200).optional()
});

adminRouter.post(
  "/users",
  requirePermission("user:manage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = createUserSchema.parse(req.body);
    const db = await getDb();
    const exists = await one(db, `SELECT id FROM users WHERE email = $1`, [body.email.toLowerCase()]);
    if (exists) {
      res.status(409).json({ error: "conflict", message: "A user with that email already exists" });
      return;
    }

    const hash = await hashPassword(body.password);
    const user = await one(
      db,
      `INSERT INTO users (email, display_name, password_hash, role, agency) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, display_name, role, agency, created_at`,
      [body.email.toLowerCase(), body.displayName, hash, body.role, body.agency ?? null]
    );

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "user.create",
      entityType: "user",
      entityId: (user as { id: string }).id,
      after: { email: body.email, role: body.role },
      req
    });
    res.status(201).json({ user });
  })
);

const updateUserSchema = z.object({
  role: z.enum(["admin", "investigator", "analyst", "viewer"]).optional(),
  isActive: z.boolean().optional(),
  agency: z.string().max(200).nullish(),
  password: z.string().min(12).max(200).optional()
});

adminRouter.patch(
  "/users/:id",
  requirePermission("user:manage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = updateUserSchema.parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const before = await one<{ role: string; is_active: boolean; email: string }>(
      db,
      `SELECT role, is_active, email FROM users WHERE id = $1`,
      [id]
    );
    if (!before) throw notFound("User not found");

    // Guard against locking everyone out of admin.
    if (before.role === "admin" && (body.role && body.role !== "admin" || body.isActive === false)) {
      const admins = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active = true`);
      if ((admins?.n ?? 0) <= 1) {
        res.status(409).json({ error: "conflict", message: "Cannot demote or deactivate the last active administrator" });
        return;
      }
    }

    const sets: string[] = [];
    const params: (string | boolean | null)[] = [];
    if (body.role) {
      params.push(body.role);
      sets.push(`role = $${params.length}`);
    }
    if (body.isActive !== undefined) {
      params.push(body.isActive);
      sets.push(`is_active = $${params.length}`);
    }
    if (body.agency !== undefined) {
      params.push(body.agency);
      sets.push(`agency = $${params.length}`);
    }
    if (body.password) {
      params.push(await hashPassword(body.password));
      sets.push(`password_hash = $${params.length}`);
    }
    if (!sets.length) {
      res.status(400).json({ error: "bad_request", message: "No fields to update" });
      return;
    }
    params.push(id);

    const updated = await one(
      db,
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id, email, display_name, role, agency, is_active`,
      params
    );

    if (body.isActive === false || body.password) {
      const reason = body.isActive === false ? "deactivated" : "admin_password_reset";
      await db.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [
        id,
        reason
      ]);
    }

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "user.update",
      entityType: "user",
      entityId: id,
      before,
      after: { role: body.role, isActive: body.isActive, passwordChanged: Boolean(body.password) },
      req
    });
    res.json({ user: updated });
  })
);

// ------------------------------------------------------------ integrations
adminRouter.get(
  "/integrations",
  requirePermission("integration:manage"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    const configured = await many(
      db,
      `SELECT id, name, kind, chain, base_url, enabled, rate_limit_per_min, notes, updated_at FROM integration_config ORDER BY kind, name`
    );
    const health = await chainHealth();

    res.json({
      integrations: configured,
      health,
      effective: {
        mempool: { baseUrl: env.MEMPOOL_API, auth: "none (public)" },
        ethereum: {
          baseUrl: env.ETH_RPC_URL,
          fallbacks: env.ethRpcUrls.slice(1),
          auth: "none (public)",
          note: "Requests fail over across these in order. Public nodes rarely support address-indexed history."
        },
        polygon: {
          baseUrl: env.POLYGON_RPC_URL,
          fallbacks: env.polygonRpcUrls.slice(1),
          auth: "none (public)",
          note: "Polygon uses its own endpoints and chain id 137, separate from Ethereum."
        },
        tron: { baseUrl: env.TRONGRID_API, auth: env.hasTrongridKey ? "API key present" : "none (public, rate limited)" },
        sahyog: { baseUrl: env.SAHYOG_API_URL, auth: env.hasSahyogKey ? "API key present" : "none (not configured)", note: "Indian LE intelligence sharing platform" },
        ncrp: { baseUrl: env.NCRP_API_URL, auth: env.hasNcrpKey ? "API key present" : "none (not configured)", note: "National Cybercrime Reporting Portal" }
      },
      securityNote:
        "API keys are referenced by name, never stored here. Supply them through environment variables or a secrets manager so they are not captured in exports or logs."
    });
  })
);

const integrationSchema = z.object({
  name: z.string().min(2).max(120),
  kind: z.enum(["node", "indexer", "rpc", "intelligence", "storage"]),
  chain: z.string().max(40).nullish(),
  baseUrl: z.string().url().max(500).nullish(),
  apiKeyRef: z.string().max(200).nullish(),
  enabled: z.boolean().default(true),
  rateLimitPerMin: z.coerce.number().int().min(1).max(100000).default(120),
  notes: z.string().max(2000).nullish()
});

adminRouter.post(
  "/integrations",
  requirePermission("integration:manage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = integrationSchema.parse(req.body);
    const db = await getDb();
    const row = await one(
      db,
      `INSERT INTO integration_config (name, kind, chain, base_url, api_key_ref, enabled, rate_limit_per_min, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, chain = EXCLUDED.chain, base_url = EXCLUDED.base_url,
         api_key_ref = EXCLUDED.api_key_ref, enabled = EXCLUDED.enabled, rate_limit_per_min = EXCLUDED.rate_limit_per_min,
         notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [body.name, body.kind, body.chain ?? null, body.baseUrl ?? null, body.apiKeyRef ?? null, body.enabled, body.rateLimitPerMin, body.notes ?? null, req.user!.id]
    );
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "integration.upsert",
      entityType: "integration",
      entityId: (row as { id: string }).id,
      after: { name: body.name, enabled: body.enabled, rateLimitPerMin: body.rateLimitPerMin },
      req
    });
    res.status(201).json({ integration: row });
  })
);

// -------------------------------------------------------------- risk config
adminRouter.get(
  "/risk-config",
  requirePermission("case:read"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    const overrides = await many<{ rule: string; weight: number; updated_by: string; updated_at: string }>(
      db,
      `SELECT rc.rule, rc.weight, u.display_name AS updated_by, rc.updated_at
       FROM risk_config rc LEFT JOIN users u ON u.id = rc.updated_by`
    );
    res.json({
      thresholds: DEFAULT_THRESHOLDS,
      rules: RULES.map((r) => ({
        code: r.code,
        label: r.label,
        defaultWeight: r.weight,
        confidence: r.confidence,
        detail: r.detail,
        source: r.source,
        limitations: r.limitations
      })),
      overrides,
      notice: "Risk scores prioritise review. They do not establish identity or wrongdoing and must not be presented as findings of fact."
    });
  })
);

adminRouter.put(
  "/risk-config/:rule",
  requirePermission("integration:manage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z.object({ weight: z.coerce.number().int().min(0).max(100) }).parse(req.body);
    const rule = z.string().min(2).max(60).parse(req.params.rule);
    const db = await getDb();

    const known = RULES.some((r) => r.code === rule);
    if (!known) {
      res.status(404).json({ error: "not_found", message: `Unknown rule '${rule}'` });
      return;
    }

    await db.query(
      `INSERT INTO risk_config (rule, weight, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (rule) DO UPDATE SET weight = EXCLUDED.weight, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [rule, body.weight, req.user!.id]
    );
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "risk_config.update",
      entityType: "risk_rule",
      entityId: rule,
      after: { weight: body.weight },
      req
    });
    res.json({ rule, weight: body.weight });
  })
);

// ------------------------------------------------------------- system stats
adminRouter.get(
  "/system",
  requirePermission("user:manage"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    const [tables, users, auditCount] = await Promise.all([
      many<{ table_name: string; n: number }>(
        db,
        `SELECT 'users' AS table_name, count(*)::int AS n FROM users
         UNION ALL SELECT 'cases', count(*)::int FROM cases
         UNION ALL SELECT 'entities', count(*)::int FROM entities
         UNION ALL SELECT 'transactions', count(*)::int FROM transactions
         UNION ALL SELECT 'evidence', count(*)::int FROM evidence
         UNION ALL SELECT 'alerts', count(*)::int FROM alerts
         UNION ALL SELECT 'traces', count(*)::int FROM traces
         UNION ALL SELECT 'labels', count(*)::int FROM labels
         UNION ALL SELECT 'audit_log', count(*)::int FROM audit_log`
      ),
      one<{ active: number; total: number }>(db, `SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*)::int AS total FROM users`),
      one<{ oldest: string | null }>(db, `SELECT min(at)::text AS oldest FROM audit_log`)
    ]);

    res.json({
      runtime: { node: process.version, env: env.NODE_ENV, driver: db.driver, uptimeSeconds: Math.round(process.uptime()) },
      users,
      tables,
      audit: { entries: tables.find((t) => t.table_name === "audit_log")?.n ?? 0, oldest: auditCount?.oldest ?? null }
    });
  })
);

export { CHAINS, RISK_LEVELS };
