import type { Request } from "express";
import type { Db } from "./db/index.js";
import { one } from "./db/index.js";
import { audit } from "./middleware/audit.js";
import { badRequest, conflict, HttpError, notFound } from "./middleware/error.js";
import { can } from "./security.js";
import { caseTransitionError, isValidCaseTransition, type CaseStatus, type UserRole } from "./types.js";

/**
 * The one place a case status may change, shared by the human-facing routes and
 * the automated status engine.
 *
 * Both callers need identical guarantees — one stage at a time, closure as a
 * separate `case:close` grant, a written rationale, a readiness gate that can be
 * overridden but never silently ignored, and an append-only audit entry. Keeping
 * two implementations of that is how the manual path and the automated path end
 * up disagreeing about what a legal transition is, so there is only one.
 *
 * The actor is passed explicitly rather than read off `req` because the pipeline
 * drives transitions with no HTTP request behind them.
 */

export interface StatusActor {
  /** NULL for machine-driven transitions. Never populated with a synthetic id. */
  id: string | null;
  email: string | null;
  /** How the transition is described on the case timeline, e.g. "Agent Chen". */
  displayName: string;
  /** Used for the close/reopen grant check; "system" never holds `case:close`. */
  role: UserRole | "system";
}

export const SYSTEM_ACTOR: StatusActor = {
  id: null,
  email: null,
  displayName: "Automated pipeline",
  role: "system"
};

export type CaseStatusRow = {
  id: string;
  case_ref: string;
  status: CaseStatus;
  closed_at: string | null;
  closed_by: string | null;
  closure_note: string | null;
};

export interface ReadinessCheck {
  code: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ClosureReadiness {
  blockers: ReadinessCheck[];
  advisories: ReadinessCheck[];
  counts: {
    openCriticalAlerts: number;
    openAlerts: number;
    entities: number;
    evidence: number;
    traces: number;
    findings: number;
  };
}

/** The actor behind an authenticated request. */
export function actorFromRequest(req: Request): StatusActor {
  return {
    id: req.user!.id,
    email: req.user!.email,
    displayName: req.user!.displayName,
    role: req.user!.role
  };
}

/**
 * Everything a closing investigator needs to see before the decision, and
 * everything the server needs to refuse a premature close.
 *
 * `blockers` are conditions that make closing unsafe — an unresolved critical
 * or high alert means the case is not finished. `advisories` are conditions
 * that make a case weak rather than wrong: an investigation with no evidence
 * sealed is still a legitimate investigation, so it is surfaced, not blocked.
 */
export async function closureReadiness(db: Db, id: string): Promise<ClosureReadiness> {
  const [alerts, entities, evidence, traces, findings, summary] = await Promise.all([
    one<{ open_critical: number; open_other: number }>(
      db,
      `SELECT count(*) FILTER (WHERE state = 'open' AND severity IN ('critical','high'))::int AS open_critical,
              count(*) FILTER (WHERE state = 'open')::int AS open_other
       FROM alerts WHERE case_id = $1`,
      [id]
    ),
    one<{ n: number }>(db, `SELECT count(*)::int AS n FROM case_entities WHERE case_id = $1`, [id]),
    one<{ n: number }>(db, `SELECT count(*)::int AS n FROM evidence WHERE case_id = $1`, [id]),
    one<{ n: number }>(db, `SELECT count(*)::int AS n FROM traces WHERE case_id = $1`, [id]),
    one<{ n: number }>(db, `SELECT count(*)::int AS n FROM case_notes WHERE case_id = $1 AND kind = 'finding'`, [id]),
    one<{ has_description: boolean }>(
      db,
      `SELECT length(coalesce(description,'')) > 0 AS has_description FROM cases WHERE id = $1`,
      [id]
    )
  ]);

  const openCritical = alerts?.open_critical ?? 0;
  const openAlerts = alerts?.open_other ?? 0;
  const entityCount = entities?.n ?? 0;
  const evidenceCount = evidence?.n ?? 0;
  const traceCount = traces?.n ?? 0;
  const findingCount = findings?.n ?? 0;
  const hasDescription = summary?.has_description ?? false;

  const blockers: ReadinessCheck[] = [
    {
      code: "open_critical_alerts",
      label: "No unresolved critical or high alerts",
      ok: openCritical === 0,
      detail:
        openCritical === 0
          ? openAlerts > 0
            ? `${openAlerts} open alert(s) of lower severity remain; they do not block closure.`
            : "No open alerts on this case."
          : `${openCritical} critical or high alert(s) are still open. Acknowledge or resolve them first.`
    }
  ];

  const advisories: ReadinessCheck[] = [
    {
      code: "entities",
      label: "Entities attached",
      ok: entityCount > 0,
      detail: entityCount > 0 ? `${entityCount} entity/entities recorded.` : "No entities are attached to this case."
    },
    {
      code: "evidence",
      label: "Evidence sealed",
      ok: evidenceCount > 0,
      detail:
        evidenceCount > 0
          ? `${evidenceCount} evidence item(s) hashed and stored.`
          : "No evidence has been collected. A closed case with no sealed evidence cannot be corroborated later."
    },
    {
      code: "traces",
      label: "Fund flow traced",
      ok: traceCount > 0,
      detail:
        traceCount > 0
          ? `${traceCount} trace(s) recorded, with their hop and node limits.`
          : "No fund-flow trace has been run, so no movement of funds is recorded."
    },
    {
      code: "findings",
      label: "Findings written up",
      ok: findingCount > 0,
      detail:
        findingCount > 0
          ? `${findingCount} finding note(s) recorded.`
          : "No note is labelled as a finding. The outcome will rest on the closure note alone."
    },
    {
      code: "summary",
      label: "Case summary written",
      ok: hasDescription,
      detail: hasDescription ? "The case carries a written summary." : "The case has no description."
    }
  ];

  return {
    blockers,
    advisories,
    counts: {
      openCriticalAlerts: openCritical,
      openAlerts,
      entities: entityCount,
      evidence: evidenceCount,
      traces: traceCount,
      findings: findingCount
    }
  };
}

export interface ApplyStatusChangeArgs {
  db: Db;
  id: string;
  /** The full pre-change case row, read by the caller. */
  before: Record<string, unknown>;
  next: CaseStatus;
  actor: StatusActor;
  /**
   * Why this transition is happening. Shown on the case timeline so an
   * automatic move is never unexplained.
   */
  reason?: string;
  /** Required to close. Recorded on the case and in the audit log. */
  closureNote?: string;
  /**
   * Close over a blocker that the caller has explicitly accepted. Never set
   * from a plain status patch: only the close endpoint may set it, and the
   * codes it overrode are written into the audit entry either way.
   */
  acknowledgeBlockers?: boolean;
  /** Present when a human triggered the change, so the audit entry can attribute it. */
  req?: Request;
}

/**
 * Apply a status change, or explain why it is not allowed.
 *
 * Returns the updated row, or the unchanged row when `from === next` so callers
 * can treat a no-op as success. Throws `HttpError` for a refused transition.
 */
export async function applyStatusChange(args: ApplyStatusChangeArgs): Promise<CaseStatusRow> {
  const { db, id, before, actor } = args;
  const from = before.status as CaseStatus;
  const next = args.next;
  const caseRef = String(before.case_ref);

  const closing = next === "Closed" && from !== "Closed";
  const reopening = from === "Closed" && next !== "Closed";

  // Closing is a separate grant from editing: an analyst can work a case but
  // cannot end it. Reopening is the same decision in reverse. The pipeline never
  // holds the grant, so automation can never end or revive a case on its own.
  if ((closing || reopening) && !holdsCloseGrant(actor)) {
    throw new HttpError(403, "forbidden", "Only investigators and administrators can close or reopen a case");
  }
  if (!isValidCaseTransition(from, next)) {
    throw conflict(caseTransitionError(from, next));
  }
  if (from === next) {
    const unchanged = await one<CaseStatusRow>(
      db,
      `SELECT id, case_ref, status, closed_at, closed_by, closure_note FROM cases WHERE id = $1`,
      [id]
    );
    if (!unchanged) throw notFound("Case not found");
    return unchanged;
  }

  if (closing) {
    const note = (args.closureNote ?? "").trim();
    if (note.length < 10) {
      throw badRequest("A closure note of at least 10 characters is required to close a case");
    }
    const readiness = await closureReadiness(db, id);
    const blocking = readiness.blockers.filter((c) => !c.ok);
    if (blocking.length && !args.acknowledgeBlockers) {
      throw conflict(blocking.map((c) => c.detail).join(" "));
    }

    // `closed_by` is a foreign key onto `users`, so a machine-driven closure
    // could not be recorded. This is not a limitation to work around: the close
    // grant above already refuses a non-human actor.
    const updated = await one<CaseStatusRow>(
      db,
      `UPDATE cases
          SET status = 'Closed', closed_at = now(), closed_by = $2, closure_note = $3
        WHERE id = $1
        RETURNING id, case_ref, status, closed_at, closed_by, closure_note`,
      [id, actor.id, note]
    );
    if (!updated) throw notFound("Case not found");

    // The rationale is duplicated onto the case timeline as a pinned note so
    // it is visible where the investigation is worked, not only in the log.
    await db.query(
      `INSERT INTO case_notes (case_id, author_id, body, kind, pinned) VALUES ($1,$2,$3,'status',TRUE)`,
      [id, actor.id, `Case closed by ${actor.displayName}: ${note}`]
    );

    await audit(db, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "case.close",
      entityType: "case",
      entityId: id,
      caseRef,
      before: { status: from, closed_at: before.closed_at ?? null, closed_by: before.closed_by ?? null },
      after: {
        status: next,
        closed_at: updated.closed_at,
        closed_by: updated.closed_by,
        closureNote: note,
        openAlertsOutstanding: readiness.counts.openAlerts,
        evidenceOnFile: readiness.counts.evidence,
        tracesOnFile: readiness.counts.traces,
        // Present only when a closer closed over a blocker. An override that
        // is not visible in the log is indistinguishable from a mistake.
        ...(blocking.length ? { overriddenBlockers: blocking.map((c) => c.code) } : {})
      },
      req: args.req
    });
    return updated;
  }

  const updated = await one<CaseStatusRow>(
    db,
    `UPDATE cases
        SET status = $2, closed_at = NULL, closed_by = NULL, closure_note = NULL
      WHERE id = $1
      RETURNING id, case_ref, status, closed_at, closed_by, closure_note`,
    [id, next]
  );
  if (!updated) throw notFound("Case not found");

  const why = args.reason ? ` — ${args.reason}` : "";
  await db.query(`INSERT INTO case_notes (case_id, author_id, body, kind) VALUES ($1,$2,$3,'status')`, [
    id,
    actor.id,
    `Status changed by ${actor.displayName}: ${from} → ${next}${reopening ? " (case reopened)" : ""}${why}`
  ]);

  await audit(db, {
    actorId: actor.id,
    actorEmail: actor.email,
    action: reopening ? "case.reopen" : "case.status_change",
    entityType: "case",
    entityId: id,
    caseRef,
    before: { status: from, closed_at: before.closed_at ?? null, closed_by: before.closed_by ?? null },
    after: { status: next, ...(args.reason ? { reason: args.reason } : {}) },
    req: args.req
  });

  return updated;
}

function holdsCloseGrant(actor: StatusActor): boolean {
  return actor.role !== "system" && can(actor.role, "case:close");
}
