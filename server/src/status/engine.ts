import type { Request } from "express";
import type { Db } from "../db/index.js";
import { one } from "../db/index.js";
import { applyStatusChange, SYSTEM_ACTOR, actorFromRequest, type CaseStatusRow, type StatusActor } from "../caseStatus.js";
import { isValidCaseTransition, type CaseStatus } from "../types.js";
import { logger } from "../logger.js";

/**
 * The automated half of the case lifecycle.
 *
 * Subsystems emit events — a document lands, the extractor starts, a trace
 * finishes, an alert fires — and this decides what the case status should
 * become. It never decides anything on its own: `determineStatus` is a pure
 * function of (current status, event), and the only code that writes to
 * `cases.status` is the shared `applyStatusChange`, so an automatic transition
 * is subject to exactly the same workflow, permission and audit rules as a
 * manual one.
 *
 * The client never sets a status directly. It triggers work, and the work
 * reports back here.
 */

/** The events the pipeline reports. */
export type CaseEvent =
  | { type: "DOCUMENT_UPLOADED"; caseId: string; actorId: string | null; documentId?: string; filename?: string }
  | { type: "TEXT_EXTRACTED"; caseId: string; actorId: string | null; documentId?: string; charCount?: number }
  | { type: "AI_ANALYSIS_STARTED"; caseId: string; actorId: string | null; documentId?: string }
  | { type: "AI_ANALYSIS_COMPLETED"; caseId: string; actorId: string | null; proposalId: string; indicatorCount?: number }
  | { type: "AI_APPLY_STARTED"; caseId: string; actorId: string | null; proposalId: string }
  | { type: "AI_APPLY_COMPLETED"; caseId: string; actorId: string | null; proposalId: string }
  | { type: "TRACE_STARTED"; caseId: string; actorId: string | null; traceJobId: string }
  | { type: "TRACE_COMPLETED"; caseId: string; actorId: string | null; traceJobId: string; traceId: string; nodeCount?: number; edgeCount?: number }
  | { type: "RISK_ANALYSIS_COMPLETED"; caseId: string; actorId: string | null; alertCount?: number }
  | { type: "ALERT_CREATED"; caseId: string; actorId: string | null; alertId: string; severity: string }
  | { type: "CRITICAL_ALERT_CREATED"; caseId: string; actorId: string | null; alertId: string; reason?: string }
  | { type: "REVIEW_STARTED"; caseId: string; actorId: string | null }
  | { type: "ESCALATION_REQUIRED"; caseId: string; actorId: string | null; reason: string }
  | { type: "ESCALATION_RESOLVED"; caseId: string; actorId: string | null; reason: string }
  | { type: "ANALYST_APPROVED"; caseId: string; actorId: string | null; note?: string }
  | { type: "CASE_APPROVED"; caseId: string; actorId: string | null; closureNote: string }
  | { type: "CASE_REOPENED"; caseId: string; actorId: string | null; reason: string }
  | {
      type: "MANUAL_STATUS_CHANGE";
      caseId: string;
      actorId: string | null;
      from: string;
      to: string;
      closureNote?: string;
    };

export type CaseEventType = CaseEvent["type"];

export type StatusTransition = "none" | "advance" | "escalate" | "deescalate" | "close" | "reopen";

export interface StatusDecision {
  status: CaseStatus;
  transition: StatusTransition;
  /** Why. Shown on the case timeline and stored with the pipeline event. */
  reason: string;
}

/**
 * Which events mean "the automated work is done and a human needs to look".
 *
 * The case is only handed to an investigator once nothing further is going to
 * move on its own, so a case that has a trace running must not be parked in
 * Under Review just because its risk pass finished. `ALERT_CREATED` is
 * therefore the last step of a completed pass, not a completion signal by
 * itself, and `TRACE_COMPLETED` only promotes a case whose tracing is finished
 * rather than merely started.
 */
export const COMPLETION_EVENTS = new Set<CaseEventType>([
  "AI_ANALYSIS_COMPLETED",
  "AI_APPLY_COMPLETED",
  "TRACE_COMPLETED",
  "RISK_ANALYSIS_COMPLETED",
  "ALERT_CREATED",
  "REVIEW_STARTED"
]);

/** Events that mean "processing has begun". */
export const START_EVENTS = new Set<CaseEventType>([
  "AI_ANALYSIS_STARTED",
  "AI_APPLY_STARTED",
  "TRACE_STARTED",
  "DOCUMENT_UPLOADED"
]);

/** Persisting a document is not processing; a case stays Open until work starts. */
export const NON_TRANSITIONING = new Set<CaseEventType>(["TEXT_EXTRACTED"]);

/**
 * Decide the status a case should hold after an event. Pure — no I/O, no clock.
 *
 * Open → In Progress → Under Review is the automatic spine. Escalated is a
 * branch: reachable from Under Review by a configured condition, and leaving it
 * returns the case to Under Review rather than advancing past it, so a case can
 * be escalated and reviewed more than once. Closed is never reached
 * automatically — it takes a human approval, because closing is a decision with
 * a written outcome attached, not a consequence of a job finishing.
 */
export function determineStatus(current: CaseStatus, event: CaseEvent): StatusDecision {
  const no = (reason: string): StatusDecision => ({ status: current, transition: "none", reason });

  // A closed case is a record. It reopens only by explicit decision, so that a
  // late-arriving background job cannot silently revive finished work. Note this
  // is a deliberate narrowing of "new evidence moves a closed case back to
  // In Progress": reopening carries the `case:close` grant, an audit entry and a
  // reason, and a queued trace completing overnight is not that.
  if (current === "Closed") {
    return event.type === "CASE_REOPENED"
      ? { status: "Open", transition: "reopen", reason: `Case reopened: ${event.reason}` }
      : no("Case is closed; reopen it before new work can change its status");
  }

  // Escalation is reachable from any open stage, because the condition that
  // triggers it — a critical alert, a provider conflict, a trace branch that
  // could not be resolved — can arise at any point in the investigation.
  if (event.type === "CRITICAL_ALERT_CREATED") {
    return current === "Escalated"
      ? no("Already escalated")
      : {
          status: "Escalated",
          transition: "escalate",
          reason: event.reason ?? `Critical alert ${event.alertId} requires investigator review`
        };
  }
  if (event.type === "ESCALATION_REQUIRED") {
    return current === "Escalated" ? no("Already escalated") : { status: "Escalated", transition: "escalate", reason: event.reason };
  }
  if (event.type === "ESCALATION_RESOLVED") {
    return current !== "Escalated" ? no("Case is not escalated") : { status: "Under Review", transition: "deescalate", reason: event.reason };
  }

  if (event.type === "CASE_APPROVED") {
    return { status: "Closed", transition: "close", reason: event.closureNote };
  }

  if (event.type === "ANALYST_APPROVED") {
    // Analyst approval auto-closes the case — no further admin action needed.
    // Only valid from Under Review (analyst has reviewed and approved).
    if (current !== "Under Review") {
      return no(`Analyst approval only valid from Under Review, not ${current}`);
    }
    return {
      status: "Closed",
      transition: "close",
      reason: event.note ?? "Analyst approved — case closed automatically"
    };
  }

  if (event.type === "MANUAL_STATUS_CHANGE") {
    const to = event.to as CaseStatus;
    if (!isValidCaseTransition(current, to)) {
      return no(`“${to}” is not a permitted transition from “${current}”`);
    }
    // `current` cannot be Closed here: the closed case returned above.
    return {
      status: to,
      transition: to === "Closed" ? "close" : "advance",
      reason: `Set to ${to} by ${event.actorId ?? "an administrator"}`
    };
  }

  if (NON_TRANSITIONING.has(event.type)) return no(`${event.type} does not move the case; the case stays Open until processing starts`);

  if (current === "Escalated") {
    // While escalated, only the escalation events above can move the case. New
    // pipeline output must not quietly walk it back to Under Review.
    return no("Case is escalated and awaits investigation review");
  }

  if (START_EVENTS.has(event.type) && (current === "Open" || current === "In Progress")) {
    return { status: "In Progress", transition: "advance", reason: label(event.type) };
  }

  if (COMPLETION_EVENTS.has(event.type) && (current === "In Progress" || current === "Under Review")) {
    return {
      status: "Under Review",
      transition: "advance",
      reason: `${label(event.type)} — automated processing complete, awaiting investigator validation`
    };
  }

  return no(`${event.type} does not change a case in “${current}”`);
}

function label(type: CaseEventType): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export interface EventOutcome {
  caseId: string;
  eventType: CaseEventType;
  from: CaseStatus;
  to: CaseStatus;
  changed: boolean;
  transition: StatusTransition;
  reason: string;
  /** Set when the event asked for a move and the shared transition logic refused it. */
  refused?: string;
}

/**
 * Apply one event: record it, then move the case if it calls for a move.
 *
 * The event is written to `case_events` whether or not it changed the status, so
 * the Analysis view can show real pipeline history — including work that
 * happened and changed nothing, which is otherwise indistinguishable from work
 * that never ran.
 */
export async function handleCaseEvent(
  db: Db,
  event: CaseEvent,
  opts: { actor?: StatusActor; req?: Request } = {}
): Promise<EventOutcome | null> {
  const before = await one<Record<string, unknown>>(db, `SELECT * FROM cases WHERE id = $1`, [event.caseId]);
  if (!before) {
    // A deleted case must not take the pipeline down with it.
    logger.warn("Case event for a case that no longer exists", { caseId: event.caseId, eventType: event.type });
    return null;
  }

  const from = before.status as CaseStatus;
  const decision = determineStatus(from, event);
  const detail = eventDetail(event);

  // A human-triggered event is attributed to them; everything else to the
  // pipeline. `actor_id` is a real user id or NULL — never a placeholder.
  const actor: StatusActor = opts.actor ?? (event.actorId ? { ...SYSTEM_ACTOR, id: event.actorId } : SYSTEM_ACTOR);

  let caseRow: CaseStatusRow | null = null;
  let refusal: string | null = null;
  if (decision.status !== from) {
    try {
      caseRow = await applyStatusChange({
        db,
        id: event.caseId,
        before,
        next: decision.status,
        actor,
        reason: decision.reason,
        closureNote: event.type === "CASE_APPROVED" || event.type === "MANUAL_STATUS_CHANGE" ? event.closureNote : undefined,
        acknowledgeBlockers: false,
        req: opts.req
      });
    } catch (err) {
      // A refused transition is not a crash, but it is not a no-op either: the
      // event asked for a move and did not get one. The reason is recorded on
      // the event so a reader of the pipeline log can tell the difference
      // between "this changed nothing" and "this was refused".
      refusal = err instanceof Error ? err.message : String(err);
      logger.warn("Status transition refused for case event", {
        caseId: event.caseId,
        eventType: event.type,
        from,
        to: decision.status,
        reason: refusal
      });
    }
  }

  await db.query(
    `INSERT INTO case_events (case_id, event_type, actor_id, from_status, to_status, reason, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      event.caseId,
      event.type,
      event.actorId,
      from,
      caseRow ? caseRow.status : null,
      refusal ? `${decision.reason} — refused: ${refusal}` : decision.reason,
      refusal ? { ...detail, refused: refusal, requestedStatus: decision.status } : detail
    ]
  );

  const to = (caseRow?.status ?? from) as CaseStatus;
  return {
    caseId: event.caseId,
    eventType: event.type,
    from,
    to,
    changed: to !== from,
    transition: caseRow ? decision.transition : "none",
    reason: decision.reason,
    refused: refusal ?? undefined
  };
}

/** Event-specific payload stored alongside the pipeline record. */
function eventDetail(event: CaseEvent): Record<string, unknown> {
  switch (event.type) {
    case "DOCUMENT_UPLOADED":
      return { documentId: event.documentId ?? null, filename: event.filename ?? null };
    case "TEXT_EXTRACTED":
      return { documentId: event.documentId ?? null, charCount: event.charCount ?? null };
    case "AI_ANALYSIS_COMPLETED":
      return { proposalId: event.proposalId, indicatorCount: event.indicatorCount ?? null };
    case "AI_APPLY_STARTED":
    case "AI_APPLY_COMPLETED":
      return { proposalId: event.proposalId };
    case "TRACE_STARTED":
      return { traceJobId: event.traceJobId };
    case "TRACE_COMPLETED":
      return {
        traceJobId: event.traceJobId,
        traceId: event.traceId,
        nodeCount: event.nodeCount ?? null,
        edgeCount: event.edgeCount ?? null
      };
    case "RISK_ANALYSIS_COMPLETED":
      return { alertCount: event.alertCount ?? null };
    case "ALERT_CREATED":
      return { alertId: event.alertId, severity: event.severity };
    case "CRITICAL_ALERT_CREATED":
      return { alertId: event.alertId, severity: "critical", ...(event.reason ? { reason: event.reason } : {}) };
    case "ESCALATION_REQUIRED":
    case "ESCALATION_RESOLVED":
    case "CASE_REOPENED":
      return { reason: event.reason };
    case "CASE_APPROVED":
      return { closureNote: event.closureNote };
    case "MANUAL_STATUS_CHANGE":
      return { from: event.from, to: event.to };
    default:
      return {};
  }
}

export { actorFromRequest };
