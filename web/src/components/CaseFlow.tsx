import { api, ApiError } from "../lib/api";
import type { CaseStatus } from "../types";
import { Badge, Notice } from "./ui";

/** Open → In Progress → Under Review → Escalated → Closed. */
export const CASE_FLOW: CaseStatus[] = ["Open", "In Progress", "Under Review", "Escalated", "Closed"];

/**
 * The case lifecycle, drawn where the case is worked.
 *
 * A case advances one stage at a time and the API refuses anything else, so
 * the control offers exactly one next step rather than a free-text status. The
 * close control is rendered for every role: where a role may not use it, the
 * reason is shown instead of the button simply being absent.
 */
export function CaseFlow({
  status,
  nextStatus,
  canAdvance,
  canClose,
  closeBlockedReason,
  onAdvance,
  onCloseClick,
  busy
}: {
  status: CaseStatus;
  nextStatus: CaseStatus | null;
  canAdvance: boolean;
  canClose: boolean;
  closeBlockedReason: string | null;
  onAdvance: (next: CaseStatus) => void;
  onCloseClick: () => void;
  busy: boolean;
}): JSX.Element {
  const current = CASE_FLOW.indexOf(status);
  const closed = status === "Closed";

  return (
    <div className="case-flow">
      <ol className="flow-track" aria-label="Case lifecycle">
        {CASE_FLOW.map((stage, i) => {
          const state = closed || i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={stage} className={`flow-step ${state}`}>
              <span className="flow-dot" aria-hidden="true" />
              <span className="flow-label">{stage}</span>
            </li>
          );
        })}
      </ol>

      <div className="flow-actions">
        {closed ? (
          <Badge tone="ok">Closed</Badge>
        ) : nextStatus && canAdvance ? (
          <button className="btn" disabled={busy} onClick={() => onAdvance(nextStatus)}>
            Advance to {nextStatus} →
          </button>
        ) : nextStatus ? (
          <Badge tone="neutral">Next stage: {nextStatus}</Badge>
        ) : null}

        {!closed ? (
          <button className="btn primary" disabled={busy || !canClose} onClick={onCloseClick} title={closeBlockedReason ?? "Close this investigation"}>
            Close case
          </button>
        ) : null}
      </div>

      {!canClose && !closed && closeBlockedReason ? (
        <Notice tone="info">
          <p>{closeBlockedReason}</p>
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * Advance a case one stage. The server owns the rules; this only reports the
 * refusal it sends back, which is the wording a reviewer will see in the log.
 */
export async function advanceCase(caseId: string, next: CaseStatus): Promise<void> {
  await api.patch(`/api/cases/${caseId}`, { status: next });
}

/** Reopen a closed case, optionally recording why it was reopened. */
export async function reopenCase(caseId: string, note: string): Promise<void> {
  await api.post(`/api/cases/${caseId}/reopen`, { note: note.trim() || undefined });
}

/** Normalised message for a refused transition or a refused closure. */
export function lifecycleError(err: unknown): string {
  return err instanceof ApiError ? err.message : "The case could not be moved";
}
