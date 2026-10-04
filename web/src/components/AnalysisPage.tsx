import { useMemo } from "react";
import { useQuery } from "../lib/hooks";
import { Badge, CaseStatusBadge, EmptyState, ErrorState, Notice, type BadgeProps } from "./ui";
import { dateTime, num } from "../lib/format";
import type { CaseDocument, CaseEventRow, CaseEventType, CaseStatusResponse } from "../types";

/**
 * Analysis view for one case: what has actually been done to it, and what is
 * outstanding.
 *
 * The pipeline is reconstructed from the persisted event log, not from the
 * case's current status. Status is a single field that only holds the latest
 * value, so inferring history from it would invent a sequence that never
 * happened - a case that was escalated and then resolved, or one where the
 * trace ran twice, would both collapse into a single linear story. The event
 * log is append-only and records what each step actually reported, so it can
 * be shown as it happened, including the steps that failed or were skipped.
 *
 * A step with no event is shown as "not run" rather than hidden, because the
 * gap between "the model was asked" and "the model answered" is exactly what
 * an investigator needs to see.
 */

interface Props {
  caseId: string;
  /**
   * Bumped by the workspace after an AI proposal is applied, so the recorded
   * pipeline history is re-read rather than showing pre-apply state.
   */
  refreshKey?: number;
  onClose?: () => void;
}

const STEP_LABELS: Record<CaseEventType, string> = {
  DOCUMENT_UPLOADED: "Documents received",
  AI_ANALYSIS_STARTED: "AI extraction started",
  AI_ANALYSIS_COMPLETED: "AI extraction finished",
  AI_APPLY_STARTED: "Applying findings",
  AI_APPLY_COMPLETED: "Findings applied",
  TRACE_STARTED: "Trace started",
  TRACE_COMPLETED: "Trace finished",
  RISK_ANALYSIS_COMPLETED: "Risk analysis finished",
  ALERT_CREATED: "Alerts raised",
  CRITICAL_ALERT_CREATED: "Critical alert raised",
  REVIEW_STARTED: "Investigation review",
  ESCALATION_REQUIRED: "Escalated",
  ESCALATION_RESOLVED: "Escalation resolved",
  CASE_APPROVED: "Case closed",
  CASE_REOPENED: "Case reopened",
  MANUAL_STATUS_CHANGE: "Status changed"
};

/**
 * Which pipeline stage each event belongs to. Several event types collapse onto
 * one stage: an alert and a critical alert are both "alerting", and the two
 * apply events are the two halves of a single apply.
 */
const STEP_OF: Partial<Record<CaseEventType, PipelineStage>> = {
  DOCUMENT_UPLOADED: "documents",
  AI_ANALYSIS_STARTED: "extraction",
  AI_ANALYSIS_COMPLETED: "extraction",
  AI_APPLY_STARTED: "apply",
  AI_APPLY_COMPLETED: "apply",
  TRACE_STARTED: "trace",
  TRACE_COMPLETED: "trace",
  RISK_ANALYSIS_COMPLETED: "risk",
  ALERT_CREATED: "alerts",
  CRITICAL_ALERT_CREATED: "alerts"
};

type PipelineStage = "documents" | "extraction" | "apply" | "trace" | "risk" | "alerts" | "review";

const STAGES: { id: PipelineStage; label: string; blurb: string }[] = [
  { id: "documents", label: "Documents", blurb: "Evidence attached to the case" },
  { id: "extraction", label: "Extraction", blurb: "Structured indicators read from the documents" },
  { id: "apply", label: "Apply", blurb: "Indicators written to entities, addresses and transactions" },
  { id: "trace", label: "Trace", blurb: "On-chain fund flow collected" },
  { id: "risk", label: "Risk", blurb: "Deterministic rule engine scored the result" },
  { id: "alerts", label: "Alerts", blurb: "Thresholds evaluated against the scores" },
  { id: "review", label: "Review", blurb: "Human decisions on the case" }
];

interface StageState {
  stage: PipelineStage;
  status: "pending" | "running" | "completed" | "failed";
  events: CaseEventRow[];
  at?: string;
  error?: string;
}

export function AnalysisPage({ caseId, refreshKey = 0, onClose }: Props): JSX.Element {
  const info = useQuery<CaseStatusResponse>(`/api/status/${caseId}`, [caseId, refreshKey]);
  const log = useQuery<{ events: CaseEventRow[] }>(`/api/status/${caseId}/events`, [caseId, refreshKey]);
  const docs = useQuery<{ documents: CaseDocument[] }>(`/api/ai/cases/${caseId}/documents`, [caseId, refreshKey]);

  const stages = useMemo(() => buildStages(log.data?.events ?? []), [log.data]);
  const error = info.error ?? log.error ?? docs.error;
  const loading = info.loading || log.loading;

  if (error) {
    return (
      <div className="analysis">
        <ErrorState error={error} onRetry={() => { info.reload(); log.reload(); docs.reload(); }} />
      </div>
    );
  }

  const documents = docs.data?.documents ?? [];
  // `uploaded` means nothing has been read from it yet and `extracted` means the
  // text is there but the model has not produced a proposal; neither is in the
  // case, so both are outstanding work. `analyzed` has findings awaiting apply.
  const openDocs = documents.filter((d) => d.status === "uploaded" || d.status === "extracted");
  const failedDocs = documents.filter((d) => d.status === "failed");

  return (
    <div className="analysis">
      <header className="analysis-head">
        <div>
          <h3>Analysis</h3>
          <p className="muted">
            {info.data?.case.case_ref ?? ""} · recorded pipeline history
          </p>
        </div>
        <div className="analysis-head-actions">
          {info.data ? <CaseStatusBadge status={info.data.case.status} /> : null}
          {onClose ? (
            <button className="icon-btn" onClick={onClose} aria-label="Close analysis" type="button">
              ×
            </button>
          ) : null}
        </div>
      </header>

      {/* Outstanding work is stated first: it is what the panel is for. */}
      {openDocs.length > 0 ? (
        <Notice tone="info" title={`${openDocs.length} document${openDocs.length === 1 ? "" : "s"} not analysed yet`}>
          <p>
            {openDocs
              .slice(0, 3)
              .map((d) => d.filename)
              .join(", ")}
            {openDocs.length > 3 ? ` and ${openDocs.length - 3} more` : ""}. Findings from these are not in the case
            yet.
          </p>
        </Notice>
      ) : null}

      {failedDocs.length > 0 ? (
        <Notice tone="danger" title="Document processing failed">
          <p>
            {failedDocs.map((d) => d.filename).join(", ")} could not be read. The rest of the case is unaffected, but
            nothing was extracted from these.
          </p>
        </Notice>
      ) : null}

      {loading ? (
        <p className="muted">Loading pipeline history…</p>
      ) : (
        <ol className="analysis-stages">
          {stages.map((s) => {
            const meta = STAGES.find((x) => x.id === s.stage)!;
            return (
              <li key={s.stage} className={`analysis-stage ${s.status}`}>
                <div className="analysis-stage-marker" aria-hidden="true" />
                <div className="analysis-stage-body">
                  <div className="analysis-stage-head">
                    <span className="analysis-stage-label">{meta.label}</span>
                    <Badge tone={toneFor(s.status)}>{s.status}</Badge>
                    {s.at ? <span className="muted analysis-stage-at">{dateTime(s.at)}</span> : null}
                  </div>
                  <p className="muted analysis-stage-blurb">{meta.blurb}</p>
                  {s.error ? <p className="analysis-stage-error">{s.error}</p> : null}
                  {s.events.length > 0 ? (
                    <ul className="analysis-stage-events">
                      {s.events.map((e) => (
                        <li key={e.id}>
                          <span className="analysis-event-label">{STEP_LABELS[e.event_type] ?? e.event_type}</span>
                          <span className="muted">{e.reason}</span>
                          {e.to_status ? (
                            <span className="muted">
                              {e.from_status ? `${e.from_status} → ` : ""}
                              {e.to_status}
                            </span>
                          ) : null}
                          {e.actor_name ? <span className="muted">by {e.actor_name}</span> : <span className="muted">by system</span>}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <section className="analysis-docs">
        <h4>
          Documents <span className="muted">· {num(documents.length)}</span>
        </h4>
        {documents.length === 0 ? (
          <EmptyState>
            <p className="muted">No documents attached.</p>
          </EmptyState>
        ) : (
          <ul className="analysis-doc-list">
            {documents.map((d) => (
              <li key={d.id}>
                <span className="analysis-doc-name">{d.filename}</span>
                <Badge tone={DOC_TONE[d.status] ?? "neutral"}>{d.status}</Badge>
                {d.error ? <span className="muted">{d.error}</span> : null}
                {d.charCount !== null ? <span className="muted">{num(d.charCount)} chars</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const DOC_TONE: Record<string, BadgeProps["tone"]> = {
  analyzed: "ok",
  extracted: "pending",
  failed: "danger",
  uploaded: "neutral"
};

function toneFor(status: StageState["status"]): BadgeProps["tone"] {
  switch (status) {
    case "completed":
      return "ok";
    case "running":
      return "pending";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Fold the event log into one row per stage.
 *
 * A stage counts as running when its opening event arrived without a closing
 * one, which is the honest description of a job that was queued and then lost -
 * a worker restart mid-extraction, for instance. A stage is never reported as
 * complete just because a later stage happened to finish.
 */
function buildStages(events: CaseEventRow[]): StageState[] {
  const byStage = new Map<PipelineStage, CaseEventRow[]>();
  for (const e of events) {
    const stage = STEP_OF[e.event_type];
    if (!stage) continue;
    const list = byStage.get(stage) ?? [];
    list.push(e);
    byStage.set(stage, list);
  }

  const at = (rows: CaseEventRow[]): string | undefined => rows[rows.length - 1]?.created_at;
  const refused = (rows: CaseEventRow[]): string | undefined =>
    rows.find((e) => typeof e.detail?.refused === "string")?.detail?.refused as string | undefined;

  const open = new Set<string>(["AI_ANALYSIS_STARTED", "AI_APPLY_STARTED", "TRACE_STARTED"]);

  return STAGES.map(({ id }) => {
    const rows = byStage.get(id) ?? [];
    if (rows.length === 0) return { stage: id, status: "pending", events: [] };

    const last = rows[rows.length - 1];
    // Review is driven by investigator decisions rather than a start/finish
    // pair, so any review event means the stage is done.
    const inFlight = id !== "review" && open.has(last.event_type);
    const refusedHere = refused(rows);

    return {
      stage: id,
      status: refusedHere ? "failed" : inFlight ? "running" : "completed",
      events: rows,
      at: at(rows),
      error: refusedHere
    };
  });
}

export default AnalysisPage;
