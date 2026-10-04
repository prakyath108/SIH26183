import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";
import { listLabels, challengeLabel, upsertLabel } from "../risk/service.js";

import { CHAINS, type Chain } from "../types.js";

export const vaspRouter = Router();
vaspRouter.use(requireAuth);

vaspRouter.get(
  "/labels",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const q = z
      .object({
        chain: z.string().optional(),
        status: z.enum(["active", "challenged", "retracted"]).optional(),
        kind: z.string().optional(),
        q: z.string().max(200).optional()
      })
      .parse(req.query);
    const db = await getDb();
    const labels = await listLabels(db, { ...(q.chain ? { chain: q.chain } : {}), ...(q.status ? { status: q.status } : {}), ...(q.q ? { q: q.q } : {}) });

    const filtered = q.kind ? labels.filter((l) => l.kind === q.kind) : labels;
    const byKind = await many<{ kind: string; n: number }>(db, `SELECT kind, count(*)::int AS n FROM labels WHERE status = 'active' GROUP BY kind`);

    res.json({
      labels: filtered,
      byKind,
      disclaimer:
        "Labels are third-party or analyst attributions with a recorded source. They can be stale, incomplete or incorrect and are never evidence of identity or wrongdoing on their own. Challenge any label you believe is wrong."
    });
  })
);

type LabelKind = "exchange" | "mixer" | "bridge" | "sanctioned" | "darknet" | "service";

/**
 * A VASP label describes the *role* of an address; the entity taxonomy describes
 * what the address *is*. Only exchange, mixer and bridge exist in both, so the
 * remaining roles collapse to "unknown" rather than inventing an enum value.
 */
const LABEL_KIND_TO_ENTITY_KIND: Record<LabelKind, string> = {
  exchange: "exchange",
  mixer: "mixer",
  bridge: "bridge",
  sanctioned: "unknown",
  darknet: "unknown",
  service: "unknown"
};

const labelSchema = z.object({
  chain: z.enum(CHAINS as [string, ...string[]]).transform((c) => c as Chain),
  address: z.string().min(10).max(200),
  kind: z.enum(["exchange", "mixer", "bridge", "sanctioned", "darknet", "service"]),
  name: z.string().min(2).max(200),
  source: z.string().min(2).max(300),
  sourceUrl: z.string().url().max(500).optional(),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  observedAt: z.string().datetime().optional(),
  note: z.string().max(2000).optional()
});

vaspRouter.post(
  "/labels",
  requirePermission("label:challenge"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = labelSchema.parse(req.body);
    const db = await getDb();
    const observedAt = body.observedAt ?? new Date().toISOString();

    const label = await upsertLabel(
      db,
      {
        chain: body.chain,
        address: body.address,
        kind: body.kind,
        name: body.name,
        source: body.source,
        ...(body.sourceUrl ? { sourceUrl: body.sourceUrl } : {}),
        confidence: body.confidence,
        observedAt,
        ...(body.note ? { note: body.note } : {})
      },
      req.user!.id
    );

    // `labels.kind` and `entities.kind` are different vocabularies: a label may
    // say "sanctioned" or "service" while the entity taxonomy only has
    // wallet/transaction/contract/exchange/mixer/bridge/unknown. Map onto the
    // entity taxonomy instead of copying the label kind across verbatim.
    const entityKind = LABEL_KIND_TO_ENTITY_KIND[body.kind];
    await db.query(
      `UPDATE entities SET label = $3, kind = $4::entity_kind, updated_at = now() WHERE chain = $1 AND address = $2`,
      [body.chain, body.address.toLowerCase(), body.name, entityKind]
    );

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "label.create",
      entityType: "label",
      entityId: label.id,
      after: { ...body, observedAt },
      req
    });
    res.status(201).json({ label });
  })
);

vaspRouter.post(
  "/labels/:id/challenge",
  requirePermission("label:challenge"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z.object({ reason: z.string().min(10, "Explain why this label appears incorrect").max(2000) }).parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const before = await one<{ address: string; name: string; status: string; source: string }>(
      db,
      `SELECT address, name, status, source FROM labels WHERE id = $1`,
      [id]
    );
    if (!before) throw notFound("Label not found");
    if (before.status !== "active") {
      res.status(409).json({ error: "conflict", message: `Label is already ${before.status}` });
      return;
    }

    const updated = await challengeLabel(db, id, body.reason, req.user!.id);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "label.challenge",
      entityType: "label",
      entityId: id,
      before,
      after: { reason: body.reason },
      req
    });
    res.json({ label: updated });
  })
);

/** VASP register: labelled service providers with the cases that touch them. */
vaspRouter.get(
  "/register",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const rows = await many(
      db,
      `SELECT l.id, l.chain, l.address, l.name, l.kind, l.source, l.source_url, l.confidence, l.observed_at, l.status,
              count(DISTINCT ce.case_id)::int AS linked_cases,
              COALESCE(SUM(ce.amount_usd), 0) AS case_volume_usd
       FROM labels l
       LEFT JOIN case_entities ce ON ce.entity_id = (SELECT id FROM entities WHERE chain = l.chain AND address = l.address)
       WHERE l.kind = 'exchange' AND l.status = 'active'
       GROUP BY l.id
       ORDER BY linked_cases DESC, l.name ASC
       LIMIT 200`
    );
    res.json({
      register: rows,
      notice:
        "This register records operator-entered attributions, not an official VASP list. Confirm any entity's registration status against the competent authority in your jurisdiction before relying on it."
    });
  })
);
