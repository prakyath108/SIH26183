import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import type { ClosureReadinessResponse, ReadinessCheck } from "../types";
import { Field, Modal, Notice } from "./ui";

/**
 * Close a case: the point at which the investigation is declared finished.
 *
 * The modal shows the readiness report before it asks for a decision, because a
 * closure is the one edit on a case that cannot be undone by editing alone. The
 * rationale typed here is written three times on purpose — onto the case row,
 * onto the case timeline as a pinned note, and into the append-only audit log —
 * so a reviewer can reconstruct who ended the case and on what grounds.
 */
export function CloseCaseModal({
  open,
  caseId,
  caseRef,
  onClose,
  onClosed
}: {
  open: boolean;
  caseId: string;
  caseRef: string;
  onClose: () => void;
  onClosed: () => void;
}): JSX.Element {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);

  // Refetched each time the modal opens: readiness is a property of the case
  // right now, and an alert may have been raised since the page loaded.
  const { data, loading } = useQuery<ClosureReadinessResponse>(
    open ? `/api/cases/${caseId}/closure-readiness` : null,
    [open]
  );

  useEffect(() => {
    if (open) {
      setNote("");
      setError(null);
      setOverride(false);
    }
  }, [open]);

  const blockers = (data?.blockers ?? []).filter((c) => !c.ok);
  const advisories = (data?.advisories ?? []).filter((c) => !c.ok);
  const ready = (data?.blockers ?? []).every((c) => c.ok);
  const canClose = data?.canClose ?? false;
  const tooShort = note.trim().length < 10;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Close ${caseRef}`}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || loading || !canClose || tooShort || (!ready && !override)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post(`/api/cases/${caseId}/close`, {
                  closureNote: note.trim(),
                  acknowledgeBlockers: !ready && override
                });
                onClosed();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not close the case");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Closing…" : "Close case"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="warn" title="Closing is a recorded decision">
          <p>
            A written outcome is required. It is stored on the case, pinned to its timeline, and written to the
            append-only audit log naming you as the actor. The status flow is Open → In Progress → Under Review →
            Escalated → Closed, and only investigators and administrators may end a case.
          </p>
        </Notice>

        {!canClose ? (
          <Notice tone="danger" title="You cannot close this case">
            <p>{data?.closeBlockedReason ?? "Closing is restricted to investigators and administrators."}</p>
          </Notice>
        ) : null}

        {loading ? (
          <div className="boot">
            <span className="spinner" />
          </div>
        ) : null}

        {data && canClose ? (
          <>
            <section className="checklist">
              <h4>Readiness</h4>
              <CheckList checks={data.blockers} tone="blocker" />
              {advisories.length ? (
                <>
                  <p className="field-hint">
                    Not required to close, but a closed case is only as strong as what is on it:
                  </p>
                  <CheckList checks={data.advisories} tone="advisory" />
                </>
              ) : null}
            </section>

            {blockers.length ? (
              <Notice tone="danger" title="This case is not ready to close">
                <ul className="tight">
                  {blockers.map((c) => (
                    <li key={c.code}>{c.detail}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
          </>
        ) : null}

        <Field
          label="Closure outcome"
          required
          hint="What was established, what remains outstanding, and any onward referral. Written for a reviewer who was not on the case."
        >
          <textarea rows={5} value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} autoFocus />
        </Field>
        {note.trim().length > 0 && tooShort ? <span className="field-hint">At least 10 characters.</span> : null}

        {blockers.length ? (
          <label className="check">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            <span>
              Close anyway, and record the override
              <span className="field-hint">
                The unresolved items and this override are written to the audit log. Use it when the investigation is
                genuinely finished and the alert is a known false positive — not to get past a blocker.
              </span>
            </span>
          </label>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

function CheckList({ checks, tone }: { checks: ReadinessCheck[]; tone: "blocker" | "advisory" }): JSX.Element {
  return (
    <ul className={`readiness ${tone}`}>
      {checks.map((c) => (
        <li key={c.code} className={c.ok ? "ok" : "not-ok"}>
          <span className="mark" aria-hidden="true">
            {c.ok ? "✓" : tone === "blocker" ? "✕" : "!"}
          </span>
          <span>
            <strong>{c.label}</strong>
            <span className="field-hint">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
