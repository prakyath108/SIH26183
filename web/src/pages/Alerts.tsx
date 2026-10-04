import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { AlertsResponse, AlertState, CaseListResponse } from "../types";
import {
  Card,
  ChainBadge,
  Copyable,
  DataTable,
  ErrorState,
  Field,
  Kpi,
  KpiRow,
  Modal,
  Notice,
  PageHeader,
  SeverityBadge,
  StateBadge
} from "../components/ui";
import { dateTime, num, relative } from "../lib/format";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const STATES = ["open", "acknowledged", "resolved", "dismissed"] as const;

export default function Alerts(): JSX.Element {
  const { can } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<AlertState | "">("open");
  const [severity, setSeverity] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [resolving, setResolving] = useState<{ id: string; title: string } | null>(null);
  const [linking, setLinking] = useState<{ id: string; title: string } | null>(null);

  const { data, error, loading, reload } = useQuery<AlertsResponse>(
    `/api/alerts${qs({ state, severity, limit: 50, offset })}`,
    [state, severity, offset]
  );

  useEffect(() => setOffset(0), [state, severity]);

  // `counts` is an unfiltered register-wide tally while `alerts` is the current
  // page. Mixing the two without labelling made the KPI row look wrong: three
  // numbers described the whole system and the fourth described 50 rows.
  const total = (s: AlertState) => data?.counts.find((c) => c.state === s)?.n ?? 0;
  const openBySeverity = (sev: string) => data?.severityCounts.find((c) => c.severity === sev)?.n ?? 0;
  const filtered = Boolean(state || severity);
  const onPage = data?.alerts.length ?? 0;

  async function triage(id: string, action: "acknowledge"): Promise<void> {
    try {
      await api.post(`/api/alerts/${id}/${action}`);
      toast.success("Alert acknowledged");
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not acknowledge");
    }
  }

  async function scan(): Promise<void> {
    setScanning(true);
    try {
      const res = await api.post<{ scanned: number; created: number }>("/api/alerts/scan", { limit: 200 });
      toast.success(`Scanned ${res.scanned} entities, created ${res.created} alerts`);
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Tactical Alerts Triage Command"
        subtitle="Signals requiring human review. An alert is a prompt to look, never a conclusion."
        actions={
          <>
            <button className="btn" onClick={reload}>
              Refresh
            </button>
            {can("alert:triage") ? (
              <button className="btn primary" onClick={() => void scan()} disabled={scanning}>
                {scanning ? "Scanning…" : "Run scan"}
              </button>
            ) : null}
          </>
        }
      />

      <Notice tone="info" title="How alerts are produced">
        <p>
          A scan evaluates the highest-scoring stored entities against the rule set and raises an alert per matching
          indicator, deduplicated per entity and rule. There is no background scheduler: scans are investigator-triggered
          so that they are reproducible and visible in the audit trail.
        </p>
      </Notice>

      <KpiRow cols={4}>
        <Kpi label="Open (all)" value={num(total("open"))} tone={total("open") ? "high" : undefined} sub="register-wide" />
        <Kpi label="Acknowledged (all)" value={num(total("acknowledged"))} sub="register-wide" />
        <Kpi label="Resolved (all)" value={num(total("resolved"))} tone="ok" sub="register-wide" />
        <Kpi
          label="Critical open"
          value={num(openBySeverity("critical"))}
          tone={openBySeverity("critical") ? "critical" : undefined}
          sub="all states, register-wide"
        />
      </KpiRow>

      <Card
        title="Alert register"
        hint={
          filtered
            ? `${onPage} alert${onPage === 1 ? "" : "s"} on this page match the filters below.`
            : "Every alert raised by a scan, most severe first."
        }
        actions={
          <div className="filter-bar inline">
            <select value={state} onChange={(e) => setState(e.target.value as AlertState | "")}>
              <option value="">Any state</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Any severity</option>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        }
        flush
      >
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        <DataTable
          rows={data?.alerts ?? []}
          loading={loading}
          empty={
            state === "open"
              ? "No open alerts. Run a scan to evaluate stored entities against the rule set."
              : "No alerts match these filters."
          }
          columns={[
            {
              key: "title",
              header: "Alert",
              render: (a) => (
                <div>
                  <span className="strong">{a.title}</span>
                  {a.detail ? <div className="sub">{a.detail}</div> : null}
                  <div className="sub">
                    <span className="mono">{a.category}</span>
                    {a.entity_address ? (
                      <>
                        {" · "}
                        <ChainBadge chain={a.entity_chain} /> <Copyable value={a.entity_address} />
                      </>
                    ) : null}
                  </div>
                </div>
              )
            },
            { key: "severity", header: "Severity", render: (a) => <SeverityBadge severity={a.severity} /> },
            {
              key: "risk",
              header: "Entity risk",
              align: "right",
              render: (a) =>
                a.risk_score == null ? (
                  <span className="muted" title="No linked entity, or the score predates this column">
                    —
                  </span>
                ) : (
                  <span className="mono" title="The entity score that produced this alert">
                    {a.risk_score}
                    <span className="muted">/100</span>
                  </span>
                )
            },
            { key: "state", header: "State", render: (a) => <StateBadge state={a.state} /> },
            {
              key: "case",
              header: "Case",
              render: (a) =>
                a.case_ref ? (
                  <Link to={`/investigations/${a.case_id}`} className="mono small">
                    {a.case_ref}
                  </Link>
                ) : (
                  <span className="muted">unlinked</span>
                )
            },
            {
              key: "when",
              header: "Raised",
              align: "right",
              render: (a) => (
                <span title={dateTime(a.created_at)}>
                  {relative(a.created_at)}
                  {a.resolved_at ? <div className="sub">resolved {relative(a.resolved_at)}</div> : null}
                </span>
              )
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (a) =>
                can("alert:triage") ? (
                  <div className="row-actions">
                    {a.state === "open" ? (
                      <button className="btn ghost sm" onClick={() => void triage(a.id, "acknowledge")}>
                        Acknowledge
                      </button>
                    ) : null}
                    {a.state !== "resolved" ? (
                      <button
                        className="btn ghost sm"
                        onClick={() => setResolving({ id: a.id, title: a.title })}
                      >
                        Resolve
                      </button>
                    ) : null}
                    {!a.case_id ? (
                      <button className="btn ghost sm" onClick={() => setLinking({ id: a.id, title: a.title })}>
                        Link case
                      </button>
                    ) : null}
                    {a.entity_address ? (
                      <div className="action-group">
                        <Link className="btn ghost sm" to={`/explorer?entity=${a.entity_address}&chain=${a.entity_chain}`}>
                          View node
                        </Link>
                        <Link className="btn ghost sm" to={`/fund-flow?entity=${a.entity_address}&chain=${a.entity_chain}`}>
                          View graph
                        </Link>
                      </div>
                    ) : null}
                  </div>
                ) : null
            }
          ]}
        />
        <div className="card-foot">
          <Pager offset={offset} limit={50} shown={onPage} hasMore={data?.hasMore ?? false} onChange={setOffset} />
        </div>
      </Card>

      <ResolveModal
        target={resolving}
        onClose={() => setResolving(null)}
        onDone={() => {
          setResolving(null);
          toast.success("Alert resolved");
          reload();
        }}
      />
      <LinkCaseModal
        target={linking}
        onClose={() => setLinking(null)}
        onDone={() => {
          setLinking(null);
          toast.success("Alert linked to case");
          reload();
        }}
      />
    </>
  );
}

function qs(params: Record<string, string | number>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === undefined) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * `hasMore` comes from the server's limit+1 probe rather than being inferred
 * from `shown === limit`, which cannot distinguish "a full page" from "the end".
 */
function Pager({
  offset,
  limit,
  shown,
  hasMore,
  onChange
}: {
  offset: number;
  limit: number;
  shown: number;
  hasMore: boolean;
  onChange: (o: number) => void;
}): JSX.Element | null {
  if (offset === 0 && !hasMore) return null;
  const first = offset + 1;
  const last = offset + shown;
  return (
    <div className="pager">
      <button className="btn ghost sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </button>
      <span className="pager-label">
        {shown === 0 ? "No rows" : `${first}–${last}`}
        {hasMore ? " · more available" : " · end of results"}
      </span>
      <button className="btn ghost sm" disabled={!hasMore} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </div>
  );
}

function ResolveModal({
  target,
  onClose,
  onDone
}: {
  target: { id: string; title: string } | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title="Resolve alert"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              if (!target) return;
              setBusy(true);
              setError(null);
              try {
                await api.post(`/api/alerts/${target.id}/resolve`, { resolution: resolution.trim() || undefined });
                setResolution("");
                onDone();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not resolve");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Mark resolved"}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          <strong>{target?.title}</strong>
        </p>
        <Field label="Resolution note" hint="What you concluded and why. Appended to the alert record.">
          <textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={2000} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

function LinkCaseModal({
  target,
  onClose,
  onDone
}: {
  target: { id: string; title: string } | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [cases, setCases] = useState<CaseListResponse["cases"]>([]);
  const [caseId, setCaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setCaseId("");
    setError(null);
    api
      .get<CaseListResponse>("/api/cases?limit=50&sort=updated")
      .then((r) => setCases(r.cases))
      .catch(() => setCases([]));
  }, [target]);

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title="Link alert to a case"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !caseId}
            onClick={async () => {
              if (!target) return;
              setBusy(true);
              setError(null);
              try {
                await api.post(`/api/alerts/${target.id}/link-case`, { caseId });
                onDone();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not link the alert");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Linking…" : "Link"}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          <strong>{target?.title}</strong>
        </p>
        <Field label="Case" required>
          <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            <option value="">Select a case…</option>
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.case_ref} — {c.title}
              </option>
            ))}
          </select>
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
