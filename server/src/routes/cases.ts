import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, badRequest, conflict, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { findCaseByIdOrRef, getDb, many, one } from "../db/index.js";
import { can } from "../security.js";
import {
  applyStatusChange,
  actorFromRequest,
  closureReadiness,
  type CaseStatusRow,
  type ReadinessCheck
} from "../caseStatus.js";
import {
  allowedCaseTransitions,
  CASE_STATUSES,
  nextCaseStatus,
  RISK_LEVELS,
  CHAINS,
  type CaseStatus,
  type Chain
} from "../types.js";

export const casesRouter = Router();
casesRouter.use(requireAuth);

const CASE_YEAR = new Date().getFullYear();

type CaseRow = CaseStatusRow;

export type { ReadinessCheck };

async function nextCaseRef(db: Awaited<ReturnType<typeof getDb>>): Promise<string> {
  const { rows } = await db.query<{ n: number }>(`SELECT nextval('case_ref_seq')::int AS n`);
  return `CT-${CASE_YEAR}-${String(rows[0]?.n ?? 1).padStart(4, "0")}`;
}

const listQuerySchema = z.object({
  status: z.enum(CASE_STATUSES as [string, ...string[]]).optional(),
  chain: z.string().optional(),
  priority: z.enum(RISK_LEVELS as [string, ...string[]]).optional(),
  q: z.string().max(200).optional(),
  /** Substring match on the recorded referral / allegation source. */
  referral: z.string().max(200).optional(),
  mine: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(["updated", "opened", "priority"]).default("updated")
});

casesRouter.get(
  "/",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const q = listQuerySchema.parse(req.query);
    const db = await getDb();
    const clauses: string[] = [];
    const params: (string | number | boolean | null)[] = [];

    if (q.status) {
      params.push(q.status);
      clauses.push(`c.status = $${params.length}`);
    }
    if (q.chain) {
      params.push(q.chain);
      clauses.push(`c.chain = $${params.length}`);
    }
    if (q.priority) {
      params.push(q.priority);
      clauses.push(`c.priority = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      clauses.push(`(lower(c.title) LIKE $${params.length} OR lower(c.case_ref) LIKE $${params.length} OR lower(coalesce(c.description,'')) LIKE $${params.length})`);
    }
    if (q.referral) {
      params.push(`%${q.referral.toLowerCase()}%`);
      clauses.push(`lower(coalesce(c.referral_source,'')) LIKE $${params.length}`);
    }
    if (q.mine === "true") {
      params.push(req.user!.id);
      clauses.push(`(c.lead_investigator_id = $${params.length} OR EXISTS (SELECT 1 FROM case_assignees a WHERE a.case_id = c.id AND a.user_id = $${params.length}))`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const order =
      q.sort === "opened"
        ? "c.opened_at DESC"
        : q.sort === "priority"
          ? `array_position(ARRAY['Critical','High','Medium','Low','Unrated']::risk_level[], c.priority) ASC NULLS LAST, c.updated_at DESC`
          : "c.updated_at DESC";

    params.push(q.limit, q.offset);
    const rows = await many(
      db,
      `SELECT c.*, u.display_name AS lead_name,
              (SELECT count(*) FROM case_entities ce WHERE ce.case_id = c.id)::int AS entity_count,
              (SELECT count(*) FROM evidence e WHERE e.case_id = c.id)::int AS evidence_count,
              (SELECT count(*) FROM alerts a WHERE a.case_id = c.id AND a.state = 'open')::int AS open_alert_count
       FROM cases c
       LEFT JOIN users u ON u.id = c.lead_investigator_id
       ${where}
       ORDER BY ${order}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countRow = await one<{ total: number }>(
      db,
      `SELECT count(*)::int AS total FROM cases c ${where}`,
      params.slice(0, -2)
    );

    res.json({ cases: rows, total: countRow?.total ?? rows.length, limit: q.limit, offset: q.offset });
  })
);

casesRouter.get(
  "/stats",
  requirePermission("case:read"),
  asyncRoute(async (_req: Request, res: Response) => {
    const db = await getDb();
    const [byStatus, byPriority, totals, entities, evidence, alerts, recent] = await Promise.all([
      many<{ status: string; n: number }>(db, `SELECT status, count(*)::int AS n FROM cases GROUP BY status`),
      many<{ priority: string; n: number }>(db, `SELECT priority, count(*)::int AS n FROM cases GROUP BY priority`),
      one<{ cases: number; open_value_usd: string | null }>(
        db,
        `SELECT count(*)::int AS cases, COALESCE(SUM((SELECT COALESCE(SUM(ce.amount_usd),0) FROM case_entities ce WHERE ce.case_id = c.id)),0) AS open_value_usd FROM cases c WHERE c.status <> 'Closed'`
      ),
      one<{ total: number; high_risk: number }>(
        db,
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE risk_score >= 55)::int AS high_risk FROM entities`
      ),
      one<{ total: number }>(db, `SELECT count(*)::int AS total FROM evidence`),
      one<{ open: number; critical: number }>(
        db,
        `SELECT count(*) FILTER (WHERE state = 'open')::int AS open, count(*) FILTER (WHERE state = 'open' AND severity = 'critical')::int AS critical FROM alerts`
      ),
      many(db, `SELECT case_ref, title, status, priority, updated_at FROM cases ORDER BY updated_at DESC LIMIT 5`)
    ]);

    void recent;
    res.json({ byStatus, byPriority, totals, entities, evidence, alerts, recent });
  })
);

const createSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(5000).optional(),
  chain: z.enum(CHAINS as [string, ...string[]]),
  priority: z.enum(RISK_LEVELS as [string, ...string[]]).default("Unrated"),
  leadInvestigatorId: z.string().uuid().nullish(),
  assigneeIds: z.array(z.string().uuid()).max(50).default([]),
  /** Address *or* transaction hash the investigation starts from. */
  seed: z.string().max(200).nullish(),
  /** @deprecated Superseded by `seed`, which also accepts a transaction hash. */
  seedAddress: z.string().max(200).nullish(),
  source: z.string().max(500).nullish(),
  referralSource: z.string().max(500).nullish()
});

interface ResolvedSeed {
  kind: "address" | "tx" | null;
  value: string;
  chain: Chain;
  /** The address a forward trace can actually start from. Null when a
   *  transaction seed could not be resolved to a payable output. */
  entityAddress: string | null;
  /** Chain facts, stated as observations. No interpretation is added here. */
  facts: string[];
}

/**
 * Work out what a seed identifier is and where a forward trace can begin.
 *
 * A transaction hash has no address to trace from, so the largest payable
 * output is used as the hop-0 entity. That is a *selection rule*, not an
 * observation: nothing on-chain says which output continues the funds, so the
 * choice and every alternative output are recorded on the case and the
 * investigator decides. Returns null only when there was no seed at all.
 *
 * Network I/O happens here, outside the caller's database transaction, so a
 * slow provider cannot hold a transaction open.
 */
async function resolveSeed(raw: string, caseChain: Chain): Promise<ResolvedSeed> {
  const trimmed = raw.trim();
  const facts: string[] = [];
  const { detect, isValidAddress, isValidTxHash } = await import("../chains/detect.js");

  const det = detect(trimmed);
  if (!det) {
    logger.warn("Seed identifier could not be parsed", { value: trimmed });
    facts.push(`Seed ${trimmed} could not be parsed as an address or transaction hash. It is recorded but nothing was traced from it.`);
    return { kind: null, value: trimmed, chain: caseChain, entityAddress: null, facts };
  }

  // The case's chain governs, matching how `lookup()` routes a chain hint: a
  // bare 64-hex string reads as Bitcoin first, but attaching a Bitcoin entity to
  // an Ethereum case would silently put foreign-chain data in the case. Record
  // the mismatch and let the investigator correct the case chain instead.
  const chain: Chain = caseChain;
  const normalized = det.normalized.toLowerCase();
  const crossChain = det.ambiguousChains.includes(chain) === false && det.chain !== chain;
  const mismatch = crossChain
    ? ` It matches the ${det.chain} shape rather than ${chain}, so it was not attached to this case.`
    : "";

  if (det.type === "address") {
    if (!isValidAddress(chain, normalized)) {
      facts.push(`Seed ${trimmed} is not a valid ${chain} address.${mismatch}`);
      return { kind: "address", value: normalized, chain, entityAddress: null, facts };
    }
    facts.push(`Seed address: ${normalized} (${chain}).${mismatch}`);
    return { kind: "address", value: normalized, chain, entityAddress: normalized, facts };
  }

  if (!isValidTxHash(chain, normalized)) {
    facts.push(`Seed ${trimmed} is not a valid ${chain} transaction hash.${mismatch}`);
    return { kind: "tx", value: normalized, chain, entityAddress: null, facts };
  }

  facts.push(`Seed transaction: ${normalized} (${chain}).${mismatch}`);
  try {
    const { adapterFor } = await import("../chains/index.js");
    const tx = await adapterFor(chain).getTransaction(normalized);
    const outputs = (tx.outputs ?? [])
      .filter((o): o is typeof o & { address: string; value: string } => Boolean(o.address) && Number(o.value) > 0)
      .sort((a, b) => Number(b.value) - Number(a.value));

    const summary =
      outputs.length > 0
        ? outputs.map((o) => `${o.address} (${o.value})`).join("; ")
        : "no payable outputs were returned";
    facts.push(
      `Seed transaction has ${tx.inputCount ?? tx.inputs?.length ?? 0} input(s) and ${tx.outputCount ?? tx.outputs?.length ?? 0} output(s). Outputs: ${summary}.`
    );

    if (!outputs.length) {
      facts.push("No output address was available to seed a trace from. Look the transaction up in the Explorer and add an entity manually.");
      return { kind: "tx", value: normalized, chain, entityAddress: null, facts };
    }

    facts.push(
      `Hop 0 entity set to ${outputs[0]!.address} as the largest output. This is a selection rule, not an observation: the other output(s) above are equally traceable and are not excluded.`
    );
    return { kind: "tx", value: normalized, chain, entityAddress: outputs[0]!.address, facts };
  } catch (err) {
    // A provider outage must not cost the investigator their case. The hash is
    // still recorded and the trace can be seeded from the Explorer later.
    const detail = err instanceof Error ? err.message : "unknown error";
    logger.warn("Seed transaction could not be fetched", { txHash: normalized, chain, detail });
    facts.push(`The seed transaction could not be fetched from the provider (${detail}). It is recorded; look it up in the Explorer and add an entity manually.`);
    return { kind: "tx", value: normalized, chain, entityAddress: null, facts };
  }
}

casesRouter.post(
  "/",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = createSchema.parse(req.body);
    const db = await getDb();
    const lead = body.leadInvestigatorId ?? req.user!.id;
    const referralSource = body.referralSource ?? body.source ?? null;

    // Resolved before the transaction opens: this performs chain I/O, and a
    // slow provider must not hold a database transaction open.
    const seedRaw = body.seed ?? body.seedAddress ?? null;
    const seed = seedRaw ? await resolveSeed(seedRaw, body.chain as Chain) : null;

    const created = await db.transaction(async (tx) => {
      const caseRef = await nextCaseRef(tx);
      const row = await one<{ id: string; case_ref: string }>(
        tx,
        `INSERT INTO cases (case_ref, title, description, chain, status, priority, lead_investigator_id, seed_kind, seed_value, referral_source)
         VALUES ($1,$2,$3,$4,'Open',$5,$6,$7,$8,$9) RETURNING id, case_ref`,
        [
          caseRef,
          body.title,
          body.description ?? null,
          body.chain,
          body.priority,
          lead,
          seed?.kind ?? null,
          seed?.value ?? null,
          referralSource
        ]
      );
      if (!row) throw new Error("Case insert returned no row");

      const assignees = new Set([lead, ...body.assigneeIds]);
      for (const uid of assignees) {
        await tx.query(
          `INSERT INTO case_assignees (case_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [row.id, uid]
        );
      }

      if (seed?.entityAddress) {
        const ent = await one<{ id: string }>(
          tx,
          `INSERT INTO entities (chain, address, kind) VALUES ($1,$2,'unknown')
           ON CONFLICT (chain, address) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [seed.chain, seed.entityAddress.toLowerCase()]
        );
        if (ent) {
          await tx.query(
            `INSERT INTO case_entities (case_id, entity_id, hop_count, note) VALUES ($1,$2,0,$3)
             ON CONFLICT (case_id, entity_id) DO NOTHING`,
            [
              row.id,
              ent.id,
              seed.kind === "tx"
                ? `Hop 0 entity derived from seed transaction ${seed.value} by largest-output rule`
                : "Seed address entered at case creation"
            ]
          );
        }
      }

      if (referralSource) {
        await tx.query(
          `INSERT INTO case_notes (case_id, author_id, body, kind) VALUES ($1,$2,$3,'note')`,
          [row.id, req.user!.id, `Allegation / referral source: ${referralSource}`]
        );
      }

      // Pinned, because this is the provenance of the whole investigation: if
      // it is edited away later the case still shows where it started and what
      // the platform could observe about the seed at creation time.
      if (seed?.facts.length) {
        await tx.query(
          `INSERT INTO case_notes (case_id, author_id, body, kind, pinned) VALUES ($1,$2,$3,'status',TRUE)`,
          [row.id, req.user!.id, [`Seed record.`, ...seed.facts].join("\n")]
        );
      }
      return row;
    });

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "case.create",
      entityType: "case",
      entityId: created.id,
      caseRef: created.case_ref,
      after: {
        title: body.title,
        chain: body.chain,
        priority: body.priority,
        seedKind: seed?.kind ?? null,
        seedEntity: seed?.entityAddress ?? null
      },
      req
    });

    res.status(201).json({ case: created });
  })
);

casesRouter.get(
  "/:id",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    // Accepts a case UUID or a human case_ref; anything else is a 404, not a 500.
    const found = await findCaseByIdOrRef<Record<string, unknown>>(db, String(req.params.id ?? ""));
    if (!found) throw notFound("Case not found");
    const id = String(found.id);

    const row = await one(
      db,
      `SELECT c.*, u.display_name AS lead_name, u.email AS lead_email,
              cu.display_name AS closed_by_name
       FROM cases c
       LEFT JOIN users u ON u.id = c.lead_investigator_id
       LEFT JOIN users cu ON cu.id = c.closed_by
       WHERE c.id = $1::uuid`,
      [id]
    );
    if (!row) throw notFound("Case not found");

    const [entities, transactions, evidence, alerts, notes, assignees, traces] = await Promise.all([
      many(
        db,
        `SELECT e.id, e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level, e.risk_factors, e.tx_count, e.first_seen, e.last_seen,
                ce.hop_count, ce.amount_usd, ce.note
         FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
         WHERE ce.case_id = $1 ORDER BY ce.hop_count ASC, e.risk_score DESC`,
        [id]
      ),
      many(
        db,
        `SELECT t.id, t.chain, t.tx_hash, t.timestamp, t.from_address, t.to_address, t.value_native, t.value_usd, t.status
         FROM case_transactions ct JOIN transactions t ON t.id = ct.transaction_id
         WHERE ct.case_id = $1 ORDER BY t.timestamp DESC NULLS LAST LIMIT 200`,
        [id]
      ),
      many(db, `SELECT id, kind, title, description, chain, address, tx_hash, content_sha256, collected_by, collected_at FROM evidence WHERE case_id = $1 ORDER BY collected_at DESC`, [id]),
      many(db, `SELECT id, severity, state, category, title, detail, created_at FROM alerts WHERE case_id = $1 ORDER BY created_at DESC`, [id]),
      many(db, `SELECT n.id, n.body, n.kind, n.pinned, n.created_at, u.display_name AS author FROM case_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.case_id = $1 ORDER BY n.created_at DESC`, [id]),
      many(db, `SELECT u.id, u.display_name, u.email, u.role FROM case_assignees ca JOIN users u ON u.id = ca.user_id WHERE ca.case_id = $1`, [id]),
      many(db, `SELECT id, chain, root_address, max_hops, direction, node_count, edge_count, total_usd, risk_score, risk_level, created_at, COALESCE((graph ->> 'demo')::boolean, false) AS is_demo FROM traces WHERE case_id = $1 ORDER BY created_at DESC LIMIT 20`, [id])
    ]);

    res.json({ case: row, entities, transactions, evidence, alerts, notes, assignees, traces });
  })
);

/**
 * What it would take to close this case, right now.
 *
 * Readable by anyone who can read the case — including roles that may not close
 * it — so the interface can explain *why* the close control is unavailable
 * instead of silently omitting it.
 */
casesRouter.get(
  "/:id/closure-readiness",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const found = await findCaseByIdOrRef<{ id: string; case_ref: string; status: CaseStatus }>(
      db,
      String(req.params.id ?? "")
    );
    if (!found) throw notFound("Case not found");

    const readiness = await closureReadiness(db, String(found.id));
    const allowed = allowedCaseTransitions(found.status);
    const mayClose = can(req.user!.role, "case:close");

    res.json({
      caseId: found.id,
      caseRef: found.case_ref,
      status: found.status,
      nextStatus: nextCaseStatus(found.status),
      allowedTransitions: allowed,
      canClose: mayClose && found.status !== "Closed",
      closeBlockedReason: !mayClose
        ? `Your role (${req.user!.role}) cannot close a case. Closing is restricted to investigators and administrators.`
        : found.status === "Closed"
          ? "This case is already closed."
          : null,
      ready: readiness.blockers.every((c) => c.ok),
      blockers: readiness.blockers,
      advisories: readiness.advisories,
      counts: readiness.counts
    });
  })
);

const closeSchema = z.object({
  /** The written outcome. Kept in the audit log, on the case row, and as a pinned note. */
  closureNote: z.string().min(10).max(5000),
  /** Set when the closer wants the blockers acknowledged rather than cleared. Always recorded, never silently ignored. */
  acknowledgeBlockers: z.boolean().default(false)
});

/**
 * Close a case. The dedicated close action, kept separate from the generic
 * patch so the permission, the note and the audit action cannot drift apart.
 */
casesRouter.post(
  "/:id/close",
  requirePermission("case:close"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = closeSchema.parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const before = await one<Record<string, unknown>>(db, `SELECT * FROM cases WHERE id = $1`, [id]);
    if (!before) throw notFound("Case not found");

    if (before.status === "Closed") {
      const updated = await one<CaseRow>(
        db,
        `SELECT id, case_ref, status, closed_at, closed_by, closure_note FROM cases WHERE id = $1`,
        [id]
      );
      res.json({ case: updated, alreadyClosed: true });
      return;
    }

    const readiness = await closureReadiness(db, id);
    const blocking = readiness.blockers.filter((c) => !c.ok);
    if (blocking.length && !body.acknowledgeBlockers) {
      // Refusal is itself an auditable event: someone tried to close a case
      // that was not ready, and a reviewer will want to see that attempt.
      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "case.close_blocked",
        entityType: "case",
        entityId: id,
        caseRef: String(before.case_ref),
        before: { status: before.status },
        after: { attempted: true, blockers: blocking.map((c) => c.code) },
        outcome: "failure",
        req
      });
      throw conflict(
        `This case is not ready to close. ${blocking.map((c) => c.detail).join(" ")} Resolve them, or re-send with acknowledgeBlockers to record an accepted override.`
      );
    }

    const updated = await applyStatusChange({
      db,
      id,
      before,
      next: "Closed",
      actor: actorFromRequest(req),
      closureNote: body.closureNote,
      acknowledgeBlockers: body.acknowledgeBlockers,
      req
    });

    res.json({ case: updated, closure: { closedAt: updated.closed_at, closedBy: updated.closed_by, note: updated.closure_note } });
  })
);

/** Reopen a closed case. Same grant as closing, and recorded the same way. */
casesRouter.post(
  "/:id/reopen",
  requirePermission("case:close"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z.object({ note: z.string().min(5).max(2000).optional() }).parse(req.body ?? {});
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const before = await one<Record<string, unknown>>(db, `SELECT * FROM cases WHERE id = $1`, [id]);
    if (!before) throw notFound("Case not found");
    if (before.status !== "Closed") throw conflict("This case is not closed.");

    const updated = await applyStatusChange({ db, id, before, next: "Open", actor: actorFromRequest(req), req });

    if (body.note) {
      await db.query(`INSERT INTO case_notes (case_id, author_id, body, kind, pinned) VALUES ($1,$2,$3,'status',TRUE)`, [
        id,
        req.user!.id,
        `Case reopened by ${req.user!.displayName}: ${body.note}`
      ]);
    }

    res.json({ case: updated });
  })
);

/** Analyst approval — auto-closes the case when analyst reviews and approves.
 *  Requires ai:apply permission (analyst, investigator, admin).
 *  Only valid from Under Review. */
casesRouter.post(
  "/:id/analyst-approve",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const before = await one<Record<string, unknown>>(db, `SELECT * FROM cases WHERE id = $1`, [id]);
    if (!before) throw notFound("Case not found");

    if (before.status !== "Under Review") {
      throw conflict("Analyst approval only available when case is Under Review.");
    }

    const updated = await applyStatusChange({
      db,
      id,
      before,
      next: "Closed",
      actor: actorFromRequest(req),
      req
    });

    if (body.note) {
      await db.query(`INSERT INTO case_notes (case_id, author_id, body, kind, pinned) VALUES ($1,$2,$3,'status',TRUE)`, [
        id,
        req.user!.id,
        `Analyst approved by ${req.user!.displayName}: ${body.note}`
      ]);
    }

    res.json({ case: updated });
  })
);

const updateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(5000).nullish(),
  status: z.enum(CASE_STATUSES as [string, ...string[]]).optional(),
  priority: z.enum(RISK_LEVELS as [string, ...string[]]).optional(),
  leadInvestigatorId: z.string().uuid().nullish(),
  /** Required to close. Recorded on the case and in the audit log. */
  closureNote: z.string().min(10).max(5000).optional()
});

casesRouter.patch(
  "/:id",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = updateSchema.parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const before = await one<Record<string, unknown>>(db, `SELECT * FROM cases WHERE id = $1`, [id]);
    if (!before) throw notFound("Case not found");

    const sets: string[] = [];
    const params: (string | null)[] = [];
    const push = (col: string, value: string | null) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    // Status is owned by applyStatusChange: it enforces the workflow, the
    // closure grant, the readiness gate and its own audit entry.
    if (body.title !== undefined) push("title", body.title);
    if (body.description !== undefined) push("description", body.description);
    if (body.priority !== undefined) push("priority", body.priority);
    if (body.leadInvestigatorId !== undefined) push("lead_investigator_id", body.leadInvestigatorId);

    let updated: CaseRow | null = null;

    if (sets.length) {
      params.push(id);
      updated = await one<CaseRow>(
        db,
        `UPDATE cases SET ${sets.join(", ")} WHERE id = $${params.length}
         RETURNING id, case_ref, status, closed_at, closed_by, closure_note`,
        params
      );
      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "case.update",
        entityType: "case",
        entityId: id,
        caseRef: String(before.case_ref),
        before,
        after: { ...body, status: undefined, closureNote: undefined },
        req
      });
    }

    if (body.status !== undefined) {
      updated = await applyStatusChange({
        db,
        id,
        before,
        next: body.status as CaseStatus,
        actor: actorFromRequest(req),
        closureNote: body.closureNote,
        req
      });
    }

    if (!updated) throw badRequest("No fields to update");

    res.json({ case: updated });
  })
);

casesRouter.delete(
  "/:id",
  requirePermission("case:delete"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const before = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [id]);
    if (!before) throw notFound("Case not found");

    await db.query(`DELETE FROM cases WHERE id = $1`, [id]);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "case.delete",
      entityType: "case",
      entityId: id,
      caseRef: before.case_ref,
      before,
      req
    });
    res.status(204).end();
  })
);

const assignSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) });

casesRouter.post(
  "/:id/assignees",
  requirePermission("case:assign"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = assignSchema.parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const row = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [id]);
    if (!row) throw notFound("Case not found");

    for (const uid of body.userIds) {
      await db.query(`INSERT INTO case_assignees (case_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, uid]);
    }
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "case.assign",
      entityType: "case",
      entityId: id,
      caseRef: row.case_ref,
      after: { userIds: body.userIds },
      req
    });
    res.status(201).json({ ok: true });
  })
);

casesRouter.delete(
  "/:id/assignees/:userId",
  requirePermission("case:assign"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const userId = z.string().uuid().parse(req.params.userId);
    await db.query(`DELETE FROM case_assignees WHERE case_id = $1 AND user_id = $2`, [id, userId]);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "case.unassign",
      entityType: "case",
      entityId: id,
      after: { userId },
      req
    });
    res.status(204).end();
  })
);

const noteSchema = z.object({
  body: z.string().min(1).max(10000),
  kind: z.enum(["note", "hypothesis", "finding", "status"]).default("note"),
  pinned: z.boolean().default(false)
});

casesRouter.post(
  "/:id/notes",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = noteSchema.parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const row = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [id]);
    if (!row) throw notFound("Case not found");

    const note = await one(
      db,
      `INSERT INTO case_notes (case_id, author_id, body, kind, pinned) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, req.user!.id, body.body, body.kind, body.pinned]
    );
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "case.note_add",
      entityType: "case",
      entityId: id,
      caseRef: row.case_ref,
      after: { kind: body.kind },
      req
    });
    res.status(201).json({ note });
  })
);

casesRouter.post(
  "/:id/entities",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const { detect } = await import("../chains/detect.js");
    const body = z
      .object({ address: z.string().min(10).max(200), chain: z.string().optional(), note: z.string().max(1000).optional() })
      .parse(req.body);
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const row = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [id]);
    if (!row) throw notFound("Case not found");

    const det = detect(body.address);
    if (!det) throw badRequest("Identifier does not match a supported address or transaction hash format");
    const chain = body.chain ?? det.chain;
    const address = det.normalized.toLowerCase();

    const ent = await one<{ id: string }>(
      db,
      `INSERT INTO entities (chain, address, kind) VALUES ($1,$2,'unknown')
       ON CONFLICT (chain, address) DO UPDATE SET updated_at = now() RETURNING id`,
      [chain, address]
    );
    if (!ent) throw new Error("Entity upsert failed");

    await db.query(
      `INSERT INTO case_entities (case_id, entity_id, hop_count, note) VALUES ($1,$2,0,$3)
       ON CONFLICT (case_id, entity_id) DO UPDATE SET note = EXCLUDED.note`,
      [id, ent.id, body.note ?? null]
    );

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "case.entity_add",
      entityType: "entity",
      entityId: ent.id,
      caseRef: row.case_ref,
      after: { address, chain, detection: det },
      req
    });
    res.status(201).json({ entityId: ent.id, address, chain, detection: det });
  })
);

casesRouter.delete(
  "/:id/entities/:entityId",
  requirePermission("case:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const entityId = z.string().uuid().parse(req.params.entityId);
    await db.query(`DELETE FROM case_entities WHERE case_id = $1 AND entity_id = $2`, [id, entityId]);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "case.entity_remove",
      entityType: "entity",
      entityId,
      req
    });
    res.status(204).end();
  })
);

import { logger } from "../logger.js";
export { conflict };
