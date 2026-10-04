import { one, type Db } from "../db/index.js";
import type { Chain, RiskLevel } from "../types.js";
import { scoreRisk, levelFor, type Label, type RiskResult, type TraversalContext } from "./engine.js";
import { fetchAdvisory } from "./mlClient.js";

/**
 * Label store. Every label is a third-party or analyst attribution with a
 * source, so it stays distinguishable from on-chain facts downstream. Analysts
 * can challenge (dispute) a label, and a challenge never deletes the original:
 * it records the dispute so the provenance chain remains auditable.
 */

/** Row shape as returned by the database (snake_case). */
export interface StoredLabel {
  id: string;
  chain: string;
  address: string;
  kind: Label["kind"];
  name: string;
  source: string;
  source_url: string | null;
  confidence: Label["confidence"];
  observed_at: string;
  note: string | null;
  status: "active" | "challenged" | "retracted";
  created_by: string | null;
  created_at: string;
  challenged_by: string | null;
  challenged_at: string | null;
  challenge_reason: string | null;
}

export async function upsertLabel(
  db: Db,
  label: Label,
  actorId: string | null
): Promise<StoredLabel> {
  const existing = await one<{ id: string }>(
    db,
    `SELECT id FROM labels WHERE chain = $1 AND address = $2 AND kind = $3 AND source = $4 AND status = 'active'`,
    [label.chain, label.address.toLowerCase(), label.kind, label.source]
  );

  if (existing) {
    return (
      (await one<StoredLabel>(db, `UPDATE labels SET name = $2, confidence = $3, observed_at = $4, note = $5 WHERE id = $1 RETURNING *`, [
        existing.id,
        label.name,
        label.confidence,
        label.observedAt,
        label.note ?? null
      ])) as StoredLabel
    );
  }

  return (await one<StoredLabel>(
    db,
    `INSERT INTO labels (chain, address, kind, name, source, source_url, confidence, observed_at, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      label.chain,
      label.address.toLowerCase(),
      label.kind,
      label.name,
      label.source,
      label.sourceUrl ?? null,
      label.confidence,
      label.observedAt,
      label.note ?? null,
      actorId
    ]
  )) as StoredLabel;
}

export async function labelsForAddresses(db: Db, chain: string, addresses: string[]): Promise<Array<StoredLabel>> {
  if (!addresses.length) return [];
  const lower = addresses.map((a) => a.toLowerCase());
  return (await db.query<StoredLabel>(
    `SELECT * FROM labels WHERE chain = $1 AND address = ANY($2::text[]) AND status = 'active'`,
    [chain, lower]
  )).rows;
}

export async function challengeLabel(
  db: Db,
  id: string,
  reason: string,
  actorId: string
): Promise<StoredLabel | null> {
  return one<StoredLabel>(
    db,
    `UPDATE labels SET status = 'challenged', challenged_by = $2, challenged_at = now(), challenge_reason = $3
     WHERE id = $1 RETURNING *`,
    [id, actorId, reason]
  );
}

export async function listLabels(db: Db, filters: { chain?: string; status?: string; q?: string } = {}): Promise<StoredLabel[]> {
  const clauses: string[] = [];
  const params: (string | null)[] = [];
  if (filters.chain) {
    params.push(filters.chain);
    clauses.push(`chain = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    clauses.push(`(lower(address) LIKE $${params.length} OR lower(name) LIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (await db.query<StoredLabel>(`SELECT * FROM labels ${where} ORDER BY created_at DESC LIMIT 500`, params)).rows;
}

export interface AssessInput extends Omit<Partial<TraversalContext>, "labels"> {
  labels: StoredLabel[];
  /** Subject of the assessment. Carried for the caller's context, not scored. */
  chain?: Chain;
  address?: string;
}

/** Build a traversal context from stored labels, then score. */
export function assess(ctx: AssessInput, extraWeights: Record<string, number> = {}): RiskResult {
  return scoreRisk(toContext(ctx), extraWeights);
}

/** The rule engine's view of one assessment, with no advisory attached. */
function toContext(ctx: AssessInput): TraversalContext {
  return buildTraversalContext(ctx);
}

/**
 * Convert stored label rows into the engine's `Label` shape.
 *
 * Exported so the ML client is fed exactly the same context the rule engine
 * scored, rather than a second hand-built approximation that could drift.
 */
export function buildTraversalContext(ctx: AssessInput): TraversalContext {
  const { chain: _chain, address: _address, ...context } = ctx;
  const base = {
    hopIntervals: context.hopIntervals ?? [],
    consolidationRatio: context.consolidationRatio ?? null,
    counterpartyCount: context.counterpartyCount ?? 0,
    totalValueUsd: context.totalValueUsd ?? 0,
    bridgeCrossings: context.bridgeCrossings ?? 0,
    analystNotes: context.analystNotes ?? []
  };
  const labels: Label[] = ctx.labels.map((l) => ({
    chain: l.chain as Chain,
    address: l.address,
    kind: l.kind,
    name: l.name,
    source: l.source,
    ...(l.source_url ? { sourceUrl: l.source_url } : {}),
    confidence: l.confidence,
    observedAt: l.observed_at,
    ...(l.note ? { note: l.note } : {})
  }));
  return { ...base, labels };
}

/**
 * Assess and attach the ML service's advisory.
 *
 * Kept separate from `assess` for two reasons: the advisory needs the network,
 * and `assess` is called once per graph node. Calling a service per node would
 * turn a single hop's latency into a traversal's latency and rate-limit the
 * advisory into uselessness. Only root assessments use this.
 *
 * The rule result is returned untouched: the advisory is carried alongside it,
 * never folded into `score` or `level`.
 */
export async function assessWithAdvisory(
  ctx: AssessInput,
  extraWeights: Record<string, number> = {}
): Promise<RiskResult> {
  const context = buildTraversalContext(ctx);
  // One conversion, one context: the advisory and the rules must see the same
  // inputs, or the two numbers describe different things.
  const result = scoreRisk(context, extraWeights);
  const advisory = await fetchAdvisory(context);
  return { ...result, mlAdvisory: advisory };
}

export { levelFor };
export type { RiskLevel, RiskResult };
