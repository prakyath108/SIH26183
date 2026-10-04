import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useDebounce, useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { AuditListResponse, AuditVerifyResponse } from "../types";
import {
  Badge,
  Card,
  DataTable,
  Details,
  ErrorState,
  Kpi,
  KpiRow,
  Notice,
  PageHeader,
  Pagination,
  SearchInput
} from "../components/ui";
import { dateTime, num, prettyJson, relative } from "../lib/format";

export default function Audit(): JSX.Element {
  const toast = useToast();
  const { can } = useAuth();

  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [outcome, setOutcome] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  const debouncedActor = useDebounce(actor);
  const debouncedCase = useDebounce(caseRef);

  const params = {
    actor: debouncedActor,
    action,
    caseRef: debouncedCase,
    outcome,
    from: from ? new Date(from).toISOString() : "",
    to: to ? new Date(to).toISOString() : "",
    limit: 100,
    offset
  };

  const { data, error, loading, reload } = useQuery<AuditListResponse>(`/api/audit${qs(params)}`, [
    debouncedActor,
    action,
    debouncedCase,
    outcome,
    from,
    to,
    offset
  ]);
  const verify = useQuery<AuditVerifyResponse>("/api/audit/verify");

  const failures = data?.entries.filter((e) => e.outcome === "failure").length ?? 0;
  const activeFilters = [debouncedActor, action, debouncedCase, outcome, from, to].filter(Boolean).length;

  function clearFilters(): void {
    setActor("");
    setAction("");
    setCaseRef("");
    setOutcome("");
    setFrom("");
    setTo("");
    setOffset(0);
  }

  return (
    <>
      <PageHeader
        title="System Append-Only Audit Engine"
        subtitle="Every action taken in the system, in the order it happened."
        actions={
          <>
            <button className="btn" onClick={reload}>
              Refresh
            </button>
            {can("audit:read") ? (
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    await api.download(`/api/audit/export${qs({ ...params, limit: undefined, offset: undefined })}`, "cryptotrace-audit.csv");
                    toast.success("CSV export downloaded and logged");
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : "Export failed");
                  }
                }}
              >
                Export CSV
              </button>
            ) : null}
          </>
        }
      />

      <Notice tone={verify.data?.appendOnly ? "ok" : "warn"} title="Append-only guarantee">
        <p>
          {verify.data?.note ??
            "Update and delete on audit_log are rejected by a database trigger."}
        </p>
        {verify.data ? (
          <p className="field-hint">
            {verify.data.appendOnly ? (
              <>
                Verified {dateTime(verify.data.verifiedAt)}: trigger <code>{verify.data.trigger}</code> is present, guarding{" "}
                {num(verify.data.entries)} entries.
              </>
            ) : (
              <>
                No append-only trigger was detected. Do not rely on this log for tamper evidence until it is restored.
              </>
            )}
          </p>
        ) : null}
      </Notice>

      <KpiRow cols={3}>
        <Kpi label="Entries on this page" value={num(data?.entries.length ?? 0)} />
        <Kpi label="Failures on this page" value={num(failures)} tone={failures ? "high" : undefined} />
        <Kpi label="Total in log" value={num(verify.data?.entries)} sub={verify.data ? `${activeFilters} filters active` : undefined} />
      </KpiRow>

      <Card
        title="Filters"
        actions={
          activeFilters ? (
            <button className="btn ghost sm" onClick={clearFilters}>
              Clear all
            </button>
          ) : null
        }
      >
        <div className="filter-grid">
          <div className="field">
            <span className="field-label">Actor</span>
            <SearchInput value={actor} onChange={setActor} placeholder="Email or display name…" />
          </div>
          <div className="field">
            <span className="field-label">Action</span>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">Any action</option>
              {(data?.actions ?? []).map((a) => (
                <option key={a.action} value={a.action}>
                  {a.action} ({a.n})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">Case reference</span>
            <input value={caseRef} onChange={(e) => setCaseRef(e.target.value)} placeholder="CT-2026-…" className="mono" />
          </div>
          <div className="field">
            <span className="field-label">Outcome</span>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">Any</option>
              <option value="success">success</option>
              <option value="failure">failure</option>
            </select>
          </div>
          <div className="field">
            <span className="field-label">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </Card>

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      <Card title="Secure Audit Trail Records" flush>
        <DataTable
          rows={data?.entries ?? []}
          loading={loading}
          empty="No audit entries match these filters."
          columns={[
            {
              key: "at",
              header: "When",
              render: (e) => (
                <span title={dateTime(e.at)}>
                  {relative(e.at)}
                  <div className="sub mono small">{e.at}</div>
                </span>
              )
            },
            {
              key: "actor",
              header: "Actor",
              render: (e) => (
                <div>
                  <span>{e.actor_name ?? e.actor_email ?? "anonymous"}</span>
                  {e.actor_role ? <div className="sub">{e.actor_role}</div> : null}
                </div>
              )
            },
            { key: "action", header: "Action", render: (e) => <span className="mono small">{e.action}</span> },
            {
              key: "target",
              header: "Target",
              render: (e) => (
                <div>
                  {e.case_ref ? (
                    <Link to="/investigations" className="mono small">
                      {e.case_ref}
                    </Link>
                  ) : (
                    <span className="small">{e.entity_type}</span>
                  )}
                  {e.entity_id && !e.case_ref ? <div className="sub mono small">{String(e.entity_id).slice(0, 14)}…</div> : null}
                </div>
              )
            },
            {
              key: "outcome",
              header: "Outcome",
              render: (e) => <Badge tone={e.outcome === "success" ? "ok" : "critical"}>{e.outcome}</Badge>
            },
            {
              key: "diff",
              header: "Change",
              align: "right",
              render: (e) =>
                e.before || e.after ? (
                  <Details summary="before / after">
                    <div className="diff">
                      <div>
                        <h5>Before</h5>
                        <pre className="json">{e.before ? prettyJson(e.before) : "—"}</pre>
                      </div>
                      <div>
                        <h5>After</h5>
                        <pre className="json">{e.after ? prettyJson(e.after) : "—"}</pre>
                      </div>
                    </div>
                  </Details>
                ) : (
                  <span className="muted">—</span>
                )
            },
            {
              key: "ip",
              header: "Origin",
              render: (e) =>
                e.ip ? (
                  <span className="mono small" title={e.user_agent ?? undefined}>
                    {e.ip}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )
            }
          ]}
        />
        <div className="card-foot">
          <Pagination limit={100} offset={offset} total={verify.data?.entries ?? 0} onChange={setOffset} />
        </div>
      </Card>

      <Card title="What gets recorded">
        <ul className="tight small">
          <li>Authentication: logins, refreshes, logouts, password changes — including failures.</li>
          <li>Case lifecycle: creation, edits, status and priority changes, assignment, notes, entity links.</li>
          <li>Chain activity: lookups, traces and their limits, and evidence collection with the resulting digest.</li>
          <li>Governance: label creation and challenge, alert triage, user and role changes, risk-weight changes.</li>
          <li>Exports: CSV and PDF exports are themselves logged, so a disclosure of the log cannot go unrecorded.</li>
        </ul>
      </Card>
    </>
  );
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
