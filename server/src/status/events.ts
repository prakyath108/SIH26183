import { EventEmitter } from "node:events";
import { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import { actorFromRequest, handleCaseEvent, type CaseEvent, type EventOutcome } from "./engine.js";
import type { Request } from "express";

/**
 * Where the pipeline reports what it did, and where live status subscribers
 * hear about it.
 *
 * Two channels, deliberately separate:
 *
 *  - `status-changed` is a broadcast for anything watching a case (an SSE
 *    connection today). Carries only what a watcher needs, and only fires on a
 *    real transition.
 *  - `event` is a fire-and-forget notification for anything that wants to know
 *    work happened, whether or not it moved the case.
 *
 * `emitCaseEvent` awaits the status write rather than dispatching it through the
 * emitter, so a caller can rely on the database having been updated by the time
 * it returns. Routing it through `emit` would have made the write an unobserved
 * promise — which is why an earlier version of this file computed the next
 * status and then discarded it, leaving every automated transition inert.
 */
class CaseEventBus extends EventEmitter {
  private initialized = false;

  /**
   * Idempotent startup hook. There is no state to set up, but the call exists so
   * startup has a single, explicit place that proves the bus is wired — and so
   * a future subscriber added here is not registered lazily on the first
   * request that happens to need it.
   */
  async initialize(): Promise<void> {
    this.initialized = true;
    logger.info("Case event bus ready");
  }

  /**
   * Record an event and apply any status change it implies.
   *
   * Never throws into the caller. A failed status write is a defect worth
   * shouting about in the log, but the caller is a document upload or a
   * completed trace whose own work succeeded; failing it would lose the real
   * result over a bookkeeping problem.
   */
  async emitCaseEvent(event: CaseEvent, req?: Request): Promise<EventOutcome | null> {
    try {
      const outcome = await handleCaseEvent(await getDb(), event, {
        actor: req?.user ? actorFromRequest(req) : undefined,
        req
      });
      if (outcome) {
        this.emit("event", outcome);
        if (outcome.changed) this.emit("status-changed", outcome);
      }
      return outcome;
    } catch (err) {
      logger.error("Failed to handle case event", { caseId: event.caseId, eventType: event.type, err });
      return null;
    }
  }

  // --- typed emitters for the lifecycle events the pipeline reports ---

  documentUploaded(caseId: string, actorId: string | null, extra: { documentId?: string; filename?: string } = {}): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "DOCUMENT_UPLOADED", caseId, actorId, ...extra });
  }

  textExtracted(caseId: string, actorId: string | null, extra: { documentId?: string; charCount?: number } = {}): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "TEXT_EXTRACTED", caseId, actorId, ...extra });
  }

  aiAnalysisStarted(caseId: string, actorId: string | null, documentId?: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "AI_ANALYSIS_STARTED", caseId, actorId, documentId });
  }

  aiAnalysisCompleted(
    caseId: string,
    actorId: string | null,
    proposalId: string,
    indicatorCount?: number
  ): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "AI_ANALYSIS_COMPLETED", caseId, actorId, proposalId, indicatorCount });
  }

  aiApplyStarted(caseId: string, actorId: string | null, proposalId: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "AI_APPLY_STARTED", caseId, actorId, proposalId });
  }

  aiApplyCompleted(caseId: string, actorId: string | null, proposalId: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "AI_APPLY_COMPLETED", caseId, actorId, proposalId });
  }

  traceStarted(caseId: string, actorId: string | null, traceJobId: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "TRACE_STARTED", caseId, actorId, traceJobId });
  }

  traceCompleted(
    caseId: string,
    actorId: string | null,
    traceJobId: string,
    traceId: string,
    counts: { nodeCount?: number; edgeCount?: number } = {}
  ): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "TRACE_COMPLETED", caseId, actorId, traceJobId, traceId, ...counts });
  }

  riskAnalysisCompleted(caseId: string, actorId: string | null, alertCount?: number): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "RISK_ANALYSIS_COMPLETED", caseId, actorId, alertCount });
  }

  /**
   * Record an alert, and escalate on it only when the severity is critical.
   *
   * High does not escalate: escalating every high alert would park most cases in
   * `Escalated`, which is a branch for the exceptional case rather than a normal
   * stage, and would make the status meaningless as a signal. High alerts still
   * block closure — that is what `closureReadiness` is for.
   */
  async alertCreated(
    caseId: string,
    actorId: string | null,
    alertId: string,
    severity: string
  ): Promise<void> {
    await this.emitCaseEvent({ type: "ALERT_CREATED", caseId, actorId, alertId, severity });
    if (severity === "critical") {
      await this.emitCaseEvent({ type: "CRITICAL_ALERT_CREATED", caseId, actorId, alertId });
    }
  }

  reviewStarted(caseId: string, actorId: string | null): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "REVIEW_STARTED", caseId, actorId });
  }

  escalationRequired(caseId: string, actorId: string | null, reason: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "ESCALATION_REQUIRED", caseId, actorId, reason });
  }

  escalationResolved(caseId: string, actorId: string | null, reason: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "ESCALATION_RESOLVED", caseId, actorId, reason });
  }

  caseApproved(caseId: string, actorId: string | null, closureNote: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "CASE_APPROVED", caseId, actorId, closureNote });
  }

  caseReopened(caseId: string, actorId: string | null, reason: string): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "CASE_REOPENED", caseId, actorId, reason });
  }

  manualStatusChange(
    caseId: string,
    actorId: string | null,
    from: string,
    to: string,
    closureNote?: string
  ): Promise<EventOutcome | null> {
    return this.emitCaseEvent({ type: "MANUAL_STATUS_CHANGE", caseId, actorId, from, to, closureNote });
  }
}

export const caseEventBus = new CaseEventBus();

/** Narrowed handle for consumers that only subscribe. */
export function onStatusChanged(listener: (e: EventOutcome) => void): () => void {
  caseEventBus.on("status-changed", listener);
  return () => caseEventBus.off("status-changed", listener);
}

export function onCaseEvent(listener: (e: EventOutcome) => void): () => void {
  caseEventBus.on("event", listener);
  return () => caseEventBus.off("event", listener);
}

export async function getCaseEventBus(): Promise<CaseEventBus> {
  if (!caseEventBus) throw new Error("Case event bus is not available");
  return caseEventBus;
}
