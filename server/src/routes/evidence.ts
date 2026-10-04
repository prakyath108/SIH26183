import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, badRequest, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";
import { sha256Json } from "../security.js";
import { chainName } from "../chains/detect.js";

export const evidenceRouter = Router();
evidenceRouter.use(requireAuth);

const CANONICALISATION = "Recursive JSON with lexicographically sorted object keys; arrays keep order.";
const SEAL_VERSION = "canonical-v2";
const LEGACY_SEAL = "payload-only-v1";

/** The sealed envelope. `data` is always present (null when there is none). */
interface EvidenceEnvelope {
  data: unknown;
  provenance: Record<string, unknown>;
}

function isEnvelope(value: unknown): value is EvidenceEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "provenance" in (value as Record<string, unknown>)
  );
}


evidenceRouter.get(
  "/",
  requirePermission("evidence:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const q = z
      .object({
        caseId: z.string().uuid().optional(),
        kind: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(req.query);
    const db = await getDb();
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (q.caseId) {
      params.push(q.caseId);
      clauses.push(`e.case_id = $${params.length}`);
    }
    if (q.kind) {
      params.push(q.kind);
      clauses.push(`e.kind = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(q.limit, q.offset);

    const items = await many(
      db,
      `SELECT e.id, e.case_id, e.kind, e.title, e.description, e.chain, e.address, e.tx_hash,
              e.content_sha256, e.collected_by, e.collected_at, e.created_at,
              c.case_ref, c.title AS case_title, u.display_name AS collected_by_name
       FROM evidence e
       JOIN cases c ON c.id = e.case_id
       LEFT JOIN users u ON u.id = e.collected_by
       ${where}
       ORDER BY e.collected_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ evidence: items, limit: q.limit, offset: q.offset });
  })
);

const createSchema = z.object({
  caseId: z.string().uuid(),
  // `label` is for a third-party attribution: the entity metadata the platform
  // supplied, which is not an observation of the chain and not the investigator's
  // own conclusion. Sealing it separately keeps the two apart in the register.
  kind: z.enum(["snapshot", "transaction", "address_profile", "label", "note", "attachment", "report_snapshot"]),
  title: z.string().min(3).max(300),
  description: z.string().max(5000).optional(),
  chain: z.string().max(40).optional(),
  address: z.string().max(200).optional(),
  txHash: z.string().max(200).optional(),
  content: z.unknown().optional(),
  /** When true the server re-fetches live chain data at collection time. */
  fetchLive: z.boolean().default(false)
});

evidenceRouter.post(
  "/",
  requirePermission("evidence:write"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = createSchema.parse(req.body);
    const db = await getDb();
    const c = await one<{ case_ref: string; chain: string }>(db, `SELECT case_ref, chain FROM cases WHERE id = $1`, [body.caseId]);
    if (!c) throw notFound("Case not found");

    let content: unknown = body.content ?? null;
    const provenance: Record<string, unknown> = {
      collectedBy: req.user!.email,
      collectedAt: new Date().toISOString()
    };

    if (body.fetchLive) {
      const { adapterFor } = await import("../chains/index.js");
      const chain = (body.chain ?? c.chain) as never;
      try {
        if (body.txHash) {
          content = await adapterFor(chain).getTransaction(body.txHash);
        } else if (body.address) {
          content = await adapterFor(chain).getAddress(body.address);
        } else {
          throw badRequest("fetchLive requires an address or txHash");
        }
        provenance.source = chainName(String(chain));
        provenance.adapter = chain;
        provenance.note =
          "Captured from a live public endpoint at collection time. Public endpoints may serve stale or inconsistent data; verify against a second source before relying on this artifact.";
      } catch (err) {
        throw badRequest(`Live collection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // The digest covers the exact envelope that gets stored, so verification is
    // a pure round trip. Hashing the payload alone and storing it inside an
    // envelope made every non-live item unverifiable.
    const envelope: EvidenceEnvelope = { data: content, provenance };
    const digest = sha256Json(envelope);

    const item = await one(
      db,
      `INSERT INTO evidence (case_id, kind, title, description, chain, address, tx_hash, content, content_sha256, collected_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        body.caseId,
        body.kind,
        body.title,
        body.description ?? null,
        body.chain ?? c.chain,
        body.address ?? null,
        body.txHash ?? null,
        JSON.stringify(envelope),
        digest,
        req.user!.id
      ]
    );

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "evidence.create",
      entityType: "evidence",
      entityId: (item as { id: string }).id,
      caseRef: c.case_ref,
      after: { kind: body.kind, title: body.title, contentSha256: digest, fetchLive: body.fetchLive, seal: SEAL_VERSION },
      req
    });

    res.status(201).json({ evidence: item, contentSha256: digest, sealVersion: SEAL_VERSION, provenance });
  })
);

evidenceRouter.get(
  "/:id",
  requirePermission("evidence:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const item = await one(
      db,
      `SELECT e.*, c.case_ref, u.display_name AS collected_by_name, u.email AS collected_by_email
       FROM evidence e JOIN cases c ON c.id = e.case_id
       LEFT JOIN users u ON u.id = e.collected_by WHERE e.id = $1`,
      [id]
    );
    if (!item) throw notFound("Evidence item not found");

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "evidence.view",
      entityType: "evidence",
      entityId: id,
      caseRef: (item as { case_ref: string }).case_ref,
      req
    });

    res.json({ evidence: item });
  })
);

/**
 * Recompute the digest and compare. Proves the stored artifact is unmodified.
 *
 * Items sealed before `SEAL_VERSION` were hashed over the payload only while
 * the provenance was stored alongside it, so their digests can never be
 * reproduced by the current rule. Those are re-checked against the old rule and
 * reported as `legacy` rather than as tampering — a false "the artifact was
 * altered" finding is worse than an honest "this predates the current seal".
 */
evidenceRouter.get(
  "/:id/verify",
  requirePermission("evidence:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const item = await one<{ content: unknown; content_sha256: string; case_ref: string }>(
      db,
      `SELECT e.content, e.content_sha256, c.case_ref FROM evidence e JOIN cases c ON c.id = e.case_id WHERE e.id = $1`,
      [id]
    );
    if (!item) throw notFound("Evidence item not found");

    const stored = item.content ?? null;
    const envelope: EvidenceEnvelope = isEnvelope(stored)
      ? { data: (stored as EvidenceEnvelope).data ?? null, provenance: (stored as EvidenceEnvelope).provenance }
      : { data: stored, provenance: {} };

    const recomputed = sha256Json(envelope);
    const legacyRecomputed = sha256Json(envelope.data);

    const current = recomputed === item.content_sha256;
    const legacy = !current && legacyRecomputed === item.content_sha256;
    const matches = current || legacy;

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "evidence.verify",
      entityType: "evidence",
      entityId: id,
      caseRef: item.case_ref,
      after: { matches, sealVersion: current ? SEAL_VERSION : legacy ? LEGACY_SEAL : "unknown", recomputed, stored: item.content_sha256 },
      req
    });

    res.json({
      valid: matches,
      sealVersion: current ? SEAL_VERSION : legacy ? LEGACY_SEAL : "unknown",
      stored: item.content_sha256,
      recomputed,
      algorithm: "sha256",
      canonicalisation: CANONICALISATION,
      note: legacy
        ? "Sealed under the previous rule, which hashed the payload without its provenance block. The content matches that original digest exactly, so it is unmodified; re-seal it to move it onto the current rule."
        : undefined,
      checkedAt: new Date().toISOString()
    });
  })
);

/**
 * Re-seal legacy items onto the current rule. Only rows whose digest already
 * reproduces under the old rule are eligible, so this can never launder a
 * tampered artifact into a valid one.
 */
evidenceRouter.post(
  "/reseal",
  requirePermission("user:manage"),
  asyncRoute(async (req: Request, res: Response) => {
    const body = z
      .object({ caseId: z.string().uuid().optional(), dryRun: z.boolean().default(false) })
      .parse(req.body ?? {});
    const db = await getDb();
    const rows = await many<{ id: string; content: unknown; content_sha256: string; case_ref: string }>(
      db,
      `SELECT e.id, e.content, e.content_sha256, c.case_ref FROM evidence e
       JOIN cases c ON c.id = e.case_id
       ${body.caseId ? "WHERE e.case_id = $1" : ""}`,
      body.caseId ? [body.caseId] : []
    );

    const resealed: string[] = [];
    const rejected: { id: string; reason: string }[] = [];

    for (const row of rows) {
      const stored = row.content ?? null;
      const envelope: EvidenceEnvelope = isEnvelope(stored)
        ? { data: (stored as EvidenceEnvelope).data ?? null, provenance: (stored as EvidenceEnvelope).provenance }
        : { data: stored, provenance: {} };
      if (sha256Json(envelope) === row.content_sha256) continue; // already current
      if (sha256Json(envelope.data) !== row.content_sha256) {
        rejected.push({ id: row.id, reason: "digest reproduces under neither the current nor the previous rule" });
        continue;
      }
      resealed.push(row.id);
      if (body.dryRun) continue;

      const digest = sha256Json(envelope);
      await db.query(`UPDATE evidence SET content = $1, content_sha256 = $2 WHERE id = $3`, [
        JSON.stringify(envelope),
        digest,
        row.id
      ]);
      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "evidence.reseal",
        entityType: "evidence",
        entityId: row.id,
        caseRef: row.case_ref,
        before: { contentSha256: row.content_sha256 },
        after: { contentSha256: digest, sealVersion: SEAL_VERSION },
        req
      });
    }

    res.json({
      dryRun: body.dryRun,
      scanned: rows.length,
      resealed: resealed.length,
      rejected,
      ids: resealed
    });
  })
);
