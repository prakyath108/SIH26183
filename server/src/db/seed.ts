import { fileURLToPath } from "node:url";
import { getDb } from "./index.js";

import { hashPassword } from "../security.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import type { Chain } from "../types.js";

/**
 * Development seed. Creates one user per role, a few cases, labelled entities
 * and evidence so every module has something real to render on first run.
 *
 * Entity addresses below are well-known public exchange/hub addresses used as
 * illustration. Labels carry a source and confidence so the UI has to render
 * provenance correctly; the risk engine treats them as third-party claims.
 */

interface SeedUser {
  email: string;
  displayName: string;
  password: string;
  role: "admin" | "investigator" | "analyst" | "viewer";
  agency: string;
}

const USERS: SeedUser[] = [
  { email: env.seedAdminEmail, displayName: "Agent Chen", password: env.seedAdminPassword, role: "admin", agency: "Platform Operations" },
  { email: "investigator@cryptotrace.local", displayName: "Agent Miller", password: "Investigate!2026x", role: "investigator", agency: "National Cyber Cell" },
  { email: "analyst@cryptotrace.local", displayName: "Investigator Yuki", password: "Analyse!2026xy", role: "analyst", agency: "Financial Intelligence Unit" },
  { email: "viewer@cryptotrace.local", displayName: "Analyst Rodriguez", password: "Observe!2026xyz", role: "viewer", agency: "Oversight Office" }
];

const LABELS: { chain: Chain; address: string; kind: string; name: string; source: string; confidence: string; note: string }[] = [
  { chain: "bitcoin", address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", kind: "exchange", name: "Example: public exchange deposit address", source: "Seed data (illustrative)", confidence: "medium", note: "Placeholder attribution for demonstration only." },
  { chain: "bitcoin", address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", kind: "mixer", name: "Example: tumbler service address", source: "Seed data (illustrative)", confidence: "low", note: "Illustrative mixer label. Real attributions require vetted sources." },
  { chain: "ethereum", address: "0x28c6c06298d514db089934071355e5743bf21d60", kind: "exchange", name: "Example: exchange hot wallet", source: "Seed data (illustrative)", confidence: "medium", note: "Placeholder attribution for demonstration only." },
  { chain: "ethereum", address: "0x3f5ce5fbfe3e9af3971dD833d26ba9b5c936f0be", kind: "bridge", name: "Example: cross-chain bridge contract", source: "Seed data (illustrative)", confidence: "low", note: "Illustrative bridge label." },
  { chain: "tron", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", kind: "exchange", name: "Example: TRC-20 contract", source: "Seed data (illustrative)", confidence: "low", note: "Illustrative label for demonstration only." }
];

const CASES = [
  {
    title: "Suspected investment scam cluster",
    description:
      "Complainants reported a fraudulent investment platform. Several deposit addresses were provided by the reporting party. Scope: trace deposits from a known victim address and identify consolidation points.",
    chain: "ethereum",
    status: "In Progress",
    priority: "Critical",
    seed: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    source: "Public complaint reference shared by reporting bank"
  },
  {
    title: "Ransomware proceeds consolidation",
    description:
      "A ransomware operator's published wallet addresses. Objective: locate consolidation into exchange deposit addresses ahead of any legal process.",
    chain: "bitcoin",
    status: "Under Review",
    priority: "High",
    seed: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    source: "Threat intelligence publication"
  },
  {
    title: "Cross-chain bridge exposure review",
    description: "A wallet moved value across chains shortly before a reported theft. Objective: document the bridge crossings and post-bridge counterparties.",
    chain: "ethereum",
    status: "Open",
    priority: "Medium",
    seed: "0x3f5ce5fbfe3e9af3971dD833d26ba9b5c936f0be",
    source: "Internal referral"
  }
];

export async function seed(): Promise<void> {
  const db = await getDb();

  const userIds = new Map<string, string>();
  for (const u of USERS) {
    const hash = await hashPassword(u.password);
    const row = await db.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role, agency)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, agency = EXCLUDED.agency
       RETURNING id`,
      [u.email, u.displayName, hash, u.role, u.agency]
    );
    const id = row.rows[0]?.id;
    if (id) userIds.set(u.role, id);
    logger.info(`Seed user ready: ${u.email} (${u.role})`);
  }

  const investigatorId = userIds.get("investigator") ?? null;

  for (const l of LABELS) {
    await db.query(
      `INSERT INTO labels (chain, address, kind, name, source, confidence, observed_at, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)
       ON CONFLICT (chain, address, kind, source) WHERE status = 'active'
       DO UPDATE SET name = EXCLUDED.name, confidence = EXCLUDED.confidence, note = EXCLUDED.note`,
      [l.chain, l.address.toLowerCase(), l.kind, l.name, l.source, l.confidence, l.note, investigatorId]
    );
    await db.query(
      `INSERT INTO entities (chain, address, kind, label, last_seen)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (chain, address) DO UPDATE SET label = COALESCE(entities.label, EXCLUDED.label), kind = CASE WHEN entities.kind = 'unknown' THEN EXCLUDED.kind ELSE entities.kind END`,
      [l.chain, l.address.toLowerCase(), l.kind, l.name]
    );
  }
  logger.info(`Seeded ${LABELS.length} labelled entities`);

  const year = new Date().getFullYear();
  for (const c of CASES) {
    const existing = await db.query<{ id: string }>(`SELECT id FROM cases WHERE title = $1`, [c.title]);
    if (existing.rows[0]) {
      logger.info(`Case already present, skipping: ${c.title}`);
      continue;
    }

    const seqRow = await db.query<{ n: number }>(`SELECT nextval('case_ref_seq')::int AS n`);
    const caseRef = `CT-${year}-${String(seqRow.rows[0]?.n ?? 1).padStart(4, "0")}`;

    const caseRow = await db.query<{ id: string }>(
      `INSERT INTO cases (case_ref, title, description, chain, status, priority, lead_investigator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [caseRef, c.title, c.description, c.chain, c.status, c.priority, investigatorId]
    );
    const caseId = caseRow.rows[0]?.id;
    if (!caseId) continue;

    // Every case, seeded or not, must open with a recorded event. Status is
    // now derived from the event log, so a case inserted with a status but no
    // history would show an empty pipeline while claiming to be mid-review.
    // The opening event is a no-op for the status engine (a case is already
    // Open) and exists purely so the log is not empty.
    await db.query(
      `INSERT INTO case_events (case_id, event_type, actor_id, from_status, to_status, reason, detail)
       VALUES ($1,$2,$3,NULL,NULL,$4,$5)`,
      [caseId, "MANUAL_STATUS_CHANGE", investigatorId, "Case opened from a referral", { source: c.source, seeded: true }]
    );

    // Then the steps that explain how a seeded case reached the status it was
    // created in, so the Analysis panel shows a coherent history rather than
    // one unexplained event.
    for (const step of statusPathFor(c.status)) {
      await db.query(
        `INSERT INTO case_events (case_id, event_type, actor_id, from_status, to_status, reason, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [caseId, step.event, investigatorId, step.from, step.to, step.reason, { seeded: true }]
      );
    }

    if (investigatorId) {
      await db.query(`INSERT INTO case_assignees (case_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [caseId, investigatorId]);
    }

    const { detect } = await import("../chains/detect.js");
    const det = detect(c.seed);
    if (det) {
      const ent = await db.query<{ id: string }>(
        `INSERT INTO entities (chain, address, kind) VALUES ($1,$2,'unknown')
         ON CONFLICT (chain, address) DO UPDATE SET updated_at = now() RETURNING id`,
        [det.chain, det.normalized.toLowerCase()]
      );
      const entId = ent.rows[0]?.id;
      if (entId) {
        await db.query(
          `INSERT INTO case_entities (case_id, entity_id, hop_count, note) VALUES ($1,$2,0,$3) ON CONFLICT DO NOTHING`,
          [caseId, entId, `Referral source: ${c.source}`]
        );
      }
    }

    await db.query(`INSERT INTO case_notes (case_id, author_id, body, kind) VALUES ($1,$2,$3,'note')`, [
      caseId,
      investigatorId,
      `Allegation / referral source: ${c.source}`
    ]);
    logger.info(`Seeded case ${caseRef}: ${c.title}`);
  }

  await seedAlerts(db, investigatorId);
  logger.info("Seed complete");
}

interface SeedEventStep {
  event: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * The chain of events that explains a seeded case's status.
 *
 * A seeded case is created directly at its target status, so without this the
 * event log would be empty and the Analysis panel would render every stage as
 * "not run" on a case that is supposed to be in review. The steps mirror what
 * the real pipeline reports: a trace runs, risk is scored, and the case then
 * waits for a person.
 */
function statusPathFor(status: string): SeedEventStep[] {
  const started: SeedEventStep = {
    event: "TRACE_STARTED",
    from: "Open",
    to: "In Progress",
    reason: "Trace started on the referral address"
  };
  if (status === "Open") return [];

  const traced: SeedEventStep = {
    event: "TRACE_COMPLETED",
    from: "In Progress",
    to: "Under Review",
    reason: "Trace completed — automated processing complete, awaiting investigator validation"
  };
  if (status === "In Progress") return [started];

  const scored: SeedEventStep = {
    event: "RISK_ANALYSIS_COMPLETED",
    from: "Under Review",
    to: "Under Review",
    reason: "Risk analysis completed — automated processing complete, awaiting investigator validation"
  };
  if (status === "Under Review") return [started, traced];

  if (status === "Escalated") {
    return [
      started,
      traced,
      scored,
      {
        event: "ESCALATION_REQUIRED",
        from: "Under Review",
        to: "Escalated",
        reason: "A critical condition requires investigator review"
      }
    ];
  }

  if (status === "Closed") {
    return [
      started,
      traced,
      scored,
      {
        event: "CASE_APPROVED",
        from: "Under Review",
        to: "Closed",
        reason: "Investigation concluded; findings referred for action"
      }
    ];
  }

  return [started, traced, scored];
}

async function seedAlerts(db: Awaited<ReturnType<typeof getDb>>, actorId: string | null): Promise<void> {  const seedAlertsData = [
    { severity: "critical", category: "mixer_interaction", title: "Mixer interaction detected on case entity", detail: "A case entity transacted with an address labelled as a tumbler. Requires analyst review.", chain: "bitcoin", address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy" },
    { severity: "high", category: "bridge_exposure", title: "Cross-chain bridge exposure", detail: "Funds moved through a bridge contract, which breaks native on-chain linkability.", chain: "ethereum", address: "0x3f5ce5fbfe3e9af3971dD833d26ba9b5c936f0be" },
    { severity: "high", category: "exchange_deposit", title: "VASP deposit identified", detail: "An entity sent funds to an address labelled as a virtual asset service provider.", chain: "ethereum", address: "0x28c6c06298d514db089934071355e5743bf21d60" },
    { severity: "info", category: "entity_risk_change", title: "Entity risk score recalculated", detail: "A stored entity's risk score changed after a configuration update.", chain: "tron", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }
  ];

  for (const a of seedAlertsData) {
    const ent = await db.query<{ id: string }>(`SELECT id FROM entities WHERE chain = $1 AND address = $2`, [a.chain, a.address.toLowerCase()]);
    const entityId = ent.rows[0]?.id ?? null;
    await db.query(
      `INSERT INTO alerts (entity_id, severity, category, title, detail, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
      [entityId, a.severity, a.category, a.title, a.detail, `seed:${a.chain}:${a.address.toLowerCase()}:${a.category}`]
    );
  }
  void actorId;
  logger.info(`Seeded ${seedAlertsData.length} alerts`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  seed()
    .then(async () => {
      const db = await getDb();
      await db.close();
      process.exit(0);
    })
    .catch((err) => {
      logger.error("Seed failed", err);
      process.exit(1);
    });
}
