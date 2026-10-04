import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type {
  CaseDetailResponse,
  CaseNoteRow,
  CaseStatus,
  Chain,
  ClosureReadinessResponse,
  EvidenceVerifyResponse,
  GraphEdge,
  GraphNode,
  RiskFactor,
  RiskLevel,
  TraceResponse
} from "../types";
import {
  Badge,
  Card,
  CaseStatusBadge,
  ChainBadge,
  Copyable,
  DataTable,
  ErrorState,
  Field,
  Grid,
  Kpi,
  KpiRow,
  Modal,
  Notice,
  PageHeader,
  RiskBadge,
  SeverityBadge,
  StateBadge,
  Tabs
} from "../components/ui";
import { advanceCase, CaseFlow, lifecycleError, reopenCase } from "../components/CaseFlow";
import { CloseCaseModal } from "../components/CloseCaseModal";
import { AddEntityModal } from "../components/AddEntityModal";
import { AddEvidenceModal } from "../components/AddEvidenceModal";
import { RunTraceModal } from "../components/RunTraceModal";
import { CASE_APPLIED_EVENT } from "../components/AiPanel";
import { GraphView } from "../components/GraphView";
import { EdgeEvidence } from "../components/EvidencePanel";
import { RiskPanel, GraphRiskAdvisory } from "../components/RiskPanel";
import { dateTime, num, relative, usd } from "../lib/format";
import { deriveRisk } from "../lib/risk";

type Tab = "overview" | "entities" | "graph" | "evidence" | "notes" | "traces";

export default function CaseDetail(): JSX.Element {
  const { caseId = "" } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("overview");
  const [entityRisk, setEntityRisk] = useState<{
    address: string;
    factors: unknown[];
    riskScore: number | null;
    riskLevel: string | null;
  } | null>(null);
  const [addEntityOpen, setAddEntityOpen] = useState(false);
  const [addEvidenceOpen, setAddEvidenceOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const { data, error, loading, reload } = useQuery<CaseDetailResponse>(`/api/cases/${caseId}`);
  // Readiness is readable by every role, so the interface can show why the
  // close control is unavailable rather than hiding it.
  const readiness = useQuery<ClosureReadinessResponse>(`/api/cases/${caseId}/closure-readiness`);

  // `?tab=graph` deep-links from Fund Flow and Reports.
  useEffect(() => {
    const t = params.get("tab");
    if (t && ["overview", "entities", "graph", "evidence", "notes", "traces"].includes(t)) setTab(t as Tab);
  }, [params]);

  // The AI panel applies entity, trace and case-field changes from the layout,
  // behind this page's back. Refetch when it reports a write for this case, so
  // the counts and lists on screen match what was just approved.
  useEffect(() => {
    const onApplied = (e: Event): void => {
      const appliedTo = (e as CustomEvent<{ caseId: string | null }>).detail?.caseId;
      if (appliedTo !== caseId) return;
      reload();
      readiness.reload();
    };
    window.addEventListener(CASE_APPLIED_EVENT, onApplied);
    return () => window.removeEventListener(CASE_APPLIED_EVENT, onApplied);
  }, [caseId, reload, readiness]);

  if (error) {
    return (
      <>
        <PageHeader title="Case" breadcrumb={<Link to="/investigations">← Investigations</Link>} />
        <ErrorState error={error} onRetry={reload} />
      </>
    );
  }

  const c = data?.case;
  if (!c && !loading) {
    return (
      <>
        <PageHeader title="Case not found" breadcrumb={<Link to="/investigations">← Investigations</Link>} />
        <Notice tone="warn">This case does not exist, or it was deleted.</Notice>
      </>
    );
  }

  const openAlerts = data?.alerts.filter((a) => a.state === "open") ?? [];

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Link to="/investigations">Investigations</Link>
            <span>/</span>
            <span className="mono">{c?.case_ref}</span>
          </>
        }
        title={c?.title ?? "Loading…"}
        subtitle={
          c ? (
            <span className="row-gap">
              <CaseStatusBadge status={c.status} />
              <RiskBadge level={c.priority} />
              <ChainBadge chain={c.chain} />
              <span className="muted">Opened {dateTime(c.opened_at)}</span>
              {c.closed_at ? <span className="muted">· Closed {dateTime(c.closed_at)}</span> : null}
            </span>
          ) : null
        }
        actions={
          <>
            {c ? (
              <Link className="btn primary" to={`/investigations/${c.id}/workspace`}>
                Open workspace
              </Link>
            ) : null}
            <button className="btn" onClick={reload}>
              Refresh
            </button>
            {c && c.status !== "Closed" && readiness.data?.nextStatus && can("case:write") ? (
              <button
                className="btn"
                disabled={statusBusy}
                onClick={async () => {
                  const next = readiness.data!.nextStatus as CaseStatus;
                  setStatusBusy(true);
                  try {
                    await advanceCase(caseId, next);
                    toast.success(`Case advanced to ${next}`);
                    reload();
                    readiness.reload();
                  } catch (err) {
                    toast.error(lifecycleError(err));
                  } finally {
                    setStatusBusy(false);
                  }
                }}
              >
                Advance to {readiness.data.nextStatus} →
              </button>
            ) : null}
            {c && c.status === "Closed" ? (
              <button className="btn" disabled={statusBusy || !can("case:close")} onClick={() => setReopenOpen(true)}>
                Reopen case
              </button>
            ) : c ? (
              <button
                className="btn primary"
                disabled={statusBusy || !can("case:close")}
                title={
                  can("case:close")
                    ? "Close this investigation and record the outcome"
                    : "Closing a case is restricted to investigators and administrators"
                }
                onClick={() => setCloseOpen(true)}
              >
                Close case
              </button>
            ) : null}
            {can("evidence:export") ? (
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await api.download(
                      `/api/reports/cases/${caseId}/export.pdf`,
                      `${c?.case_ref ?? "case"}-report.pdf`
                    );
                    toast.success("Report downloaded");
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : "Export failed");
                  }
                }}
              >
                Export PDF
              </button>
            ) : null}
          </>
        }
      />

      {openAlerts.length ? (
        <Notice tone="warn" title={`${openAlerts.length} open alert${openAlerts.length === 1 ? "" : "s"} on this case`}>
          <ul className="tight">
            {openAlerts.slice(0, 3).map((a) => (
              <li key={a.id}>
                <SeverityBadge severity={a.severity} /> {a.title}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <KpiRow cols={4}>
        <Kpi label="Linked entities" value={num(data?.entities.length ?? 0)} />
        <Kpi
          label="Highest entity risk"
          value={data?.entities.length ? Math.max(...data.entities.map((e) => e.risk_score)) : "—"}
          sub={data?.entities.length ? data.entities.find((e) => e.risk_score === Math.max(...data.entities.map((x) => x.risk_score)))?.risk_level : undefined}
        />
        <Kpi label="Evidence items" value={num(data?.evidence.length ?? 0)} sub="SHA-256 sealed" />
        <Kpi label="Recorded traces" value={num(data?.traces.length ?? 0)} />
      </KpiRow>

      <Tabs
        active={tab}
        onChange={(t) => {
          setTab(t);
          setParams(t === "overview" ? {} : { tab: t }, { replace: true });
        }}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "entities", label: "Entities", count: data?.entities.length },
          { id: "graph", label: "Graph", count: data?.traces.length },
          { id: "evidence", label: "Evidence", count: data?.evidence.length },
          { id: "notes", label: "Notes", count: data?.notes.length },
          { id: "traces", label: "Trace history", count: data?.traces.length }
        ]}
      />

      {tab === "overview" ? (
        <Grid cols={2}>
          <Card
            title="Case lifecycle"
            hint="Open → In Progress → Under Review → Escalated → Closed. A case advances one stage at a time; only investigators and administrators may close it."
            actions={<CaseStatusBadge status={c?.status ?? "Open"} />}
          >
            {c ? (
              <>
                <CaseFlow
                  status={c.status}
                  nextStatus={readiness.data?.nextStatus ?? null}
                  canAdvance={can("case:write")}
                  canClose={readiness.data?.canClose ?? false}
                  closeBlockedReason={readiness.data?.closeBlockedReason ?? null}
                  busy={statusBusy}
                  onAdvance={async (next) => {
                    setStatusBusy(true);
                    try {
                      await advanceCase(caseId, next);
                      toast.success(`Case advanced to ${next}`);
                      reload();
                      readiness.reload();
                    } catch (err) {
                      toast.error(lifecycleError(err));
                    } finally {
                      setStatusBusy(false);
                    }
                  }}
                  onCloseClick={() => setCloseOpen(true)}
                />

                {c.status === "Closed" ? (
                  <dl className="kv" style={{ marginTop: 14 }}>
                    <dt>Closed</dt>
                    <dd>
                      {dateTime(c.closed_at)} by {c.closed_by_name ?? "unknown"}
                    </dd>
                    {c.closure_note ? (
                      <>
                        <dt>Closure outcome</dt>
                        <dd className="prose">{c.closure_note}</dd>
                      </>
                    ) : null}
                  </dl>
                ) : readiness.data ? (
                  <p className="field-hint" style={{ marginTop: 10 }}>
                    {readiness.data.ready
                      ? "No blockers outstanding. A closure note is all that is required."
                      : "Not ready to close yet — resolve the outstanding items above first."}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </Card>

          <Card title="Summary">
            {c?.description ? <p className="prose">{c.description}</p> : <p className="muted">No description recorded.</p>}
            <dl className="kv">
              <dt>Reference</dt>
              <dd className="mono">{c?.case_ref}</dd>
              <dt>Lead investigator</dt>
              <dd>
                {c?.lead_name ?? "Unassigned"}{" "}
                {c?.lead_email ? <span className="muted">({c.lead_email})</span> : null}
              </dd>
              <dt>Chain</dt>
              <dd>
                <ChainBadge chain={c?.chain} />
              </dd>
              <dt>Seed</dt>
              <dd>
                {c?.seed_value ? (
                  <>
                    <span className="muted">{c.seed_kind === "tx" ? "Transaction" : c.seed_kind === "address" ? "Address" : "Unparsed"} · </span>
                    <Copyable value={c.seed_value} />
                  </>
                ) : (
                  <span className="muted">No seed recorded</span>
                )}
              </dd>
              <dt>Referral source</dt>
              <dd>{c?.referral_source ?? <span className="muted">Not recorded</span>}</dd>
              <dt>Opened</dt>
              <dd>{dateTime(c?.opened_at)}</dd>
              <dt>Last updated</dt>
              <dd>{relative(c?.updated_at)}</dd>
              <dt>Assigned</dt>
              <dd className="chip-wrap">
                {data?.assignees.length ? (
                  data.assignees.map((a) => <Badge key={a.id}>{a.display_name}</Badge>)
                ) : (
                  <span className="muted">Nobody assigned</span>
                )}
              </dd>
            </dl>
          </Card>

          <Card title="Latest trace" hint="Most recent recorded fund-flow run for this case.">
            {data?.traces.length ? (
              <>
                <dl className="kv">
                  <dt>Root</dt>
                  <dd>
                    <Copyable value={data.traces[0]!.root_address} />
                  </dd>
                  <dt>Run</dt>
                  <dd>
                    {dateTime(data.traces[0]!.created_at)} · {data.traces[0]!.direction} ·{" "}
                    {data.traces[0]!.max_hops} hops
                  </dd>
                  <dt>Graph</dt>
                  <dd>
                    {num(data.traces[0]!.node_count)} nodes, {num(data.traces[0]!.edge_count)} edges
                  </dd>
                  <dt>Root risk</dt>
                  <dd>
                    <RiskBadge level={data.traces[0]!.risk_level} score={data.traces[0]!.risk_score} />
                  </dd>
                </dl>
                <button className="btn" onClick={() => setTab("graph")}>
                  Open graph
                </button>
              </>
            ) : (
              <div>
                <p className="muted">No traces recorded for this case yet.</p>
                {can("trace:run") ? (
                  <button className="btn" onClick={() => setTraceOpen(true)}>
                    Run a trace
                  </button>
                ) : null}
              </div>
            )}
          </Card>

          <Card title="Analyst notes" hint="Latest five. Hypotheses and findings are labelled as such.">
            <NoteList notes={(data?.notes ?? []).slice(0, 5)} />
          </Card>

          <Card title="Alerts" flush>
            <DataTable
              rows={data?.alerts ?? []}
              loading={loading}
              empty="No alerts raised on this case."
              dense
              columns={[
                {
                  key: "title",
                  header: "Alert",
                  render: (a) => (
                    <div>
                      <span>{a.title}</span>
                      <div className="sub">
                        <SeverityBadge severity={a.severity} /> <StateBadge state={a.state} />{" "}
                        <span className="mono">{a.category}</span>
                      </div>
                    </div>
                  )
                },
                { key: "when", header: "When", align: "right", render: (a) => relative(a.created_at) }
              ]}
            />
          </Card>
        </Grid>
      ) : null}

      {tab === "entities" ? (
        <Card
          title={`Entities (${data?.entities.length ?? 0})`}
          hint="Grouped by hop distance from the seed, highest risk first."
          actions={
            can("case:write") ? (
              <button className="btn sm" onClick={() => setAddEntityOpen(true)}>
                Attach entity
              </button>
            ) : null
          }
          flush
        >
          <DataTable
            rows={data?.entities ?? []}
            loading={loading}
            onRowClick={(e) =>
              setEntityRisk({
                address: e.address,
                factors: e.risk_factors ?? [],
                riskScore: e.risk_score ?? null,
                riskLevel: e.risk_level ?? null
              })
            }
            empty="No entities attached. Attach a seed address, or run a trace from this case."
            columns={[
              {
                key: "address",
                header: "Address",
                render: (e) => (
                  <div>
                    <Copyable value={e.address} />
                    <div className="sub">
                      {e.label ?? e.kind} <ChainBadge chain={e.chain} />
                    </div>
                  </div>
                )
              },
              {
                key: "hop",
                header: "Hop",
                align: "center",
                render: (e) => (e.hop_count === 0 ? <Badge tone="info">seed</Badge> : num(e.hop_count))
              },
              {
                key: "risk",
                header: "Risk",
                render: (e) => <RiskBadge level={e.risk_level} score={e.risk_score} />
              },
              {
                key: "factors",
                header: "Factors",
                align: "center",
                render: (e) => <span className="muted">{e.risk_factors?.length ?? 0}</span>
              },
              {
                key: "tx",
                header: "Tx",
                align: "right",
                render: (e) => num(e.tx_count)
              },
              {
                key: "value",
                header: "Traced value",
                align: "right",
                render: (e) => usd(e.amount_usd, { fallback: "not priced" })
              },
              {
                key: "seen",
                header: "Last seen",
                align: "right",
                render: (e) => <span title={dateTime(e.last_seen)}>{relative(e.last_seen)}</span>
              }
            ]}
          />
        </Card>
      ) : null}

      {tab === "graph" ? <CaseGraph traces={data?.traces ?? []} onRunTrace={() => setTraceOpen(true)} /> : null}

      {tab === "evidence" ? (
        <Card
          title={`Evidence (${data?.evidence.length ?? 0})`}
          hint="Each item is sealed with a SHA-256 digest over canonically ordered JSON. Verify to detect modification."
          actions={
            can("evidence:write") ? (
              <button className="btn sm" onClick={() => setAddEvidenceOpen(true)}>
                Collect evidence
              </button>
            ) : null
          }
          flush
        >
          <DataTable
            rows={data?.evidence ?? []}
            loading={loading}
            empty="No evidence collected. Snapshots and live chain captures collected here are what make a case defensible."
            columns={[
              {
                key: "title",
                header: "Item",
                render: (e) => (
                  <div>
                    <span className="strong">{e.title}</span>
                    <div className="sub">
                      <Badge tone="neutral">{e.kind}</Badge> {e.description ?? ""}
                    </div>
                  </div>
                )
              },
              {
                key: "ref",
                header: "Subject",
                render: (e) =>
                  e.tx_hash ? <Copyable value={e.tx_hash} /> : e.address ? <Copyable value={e.address} /> : <span className="muted">—</span>
              },
              {
                key: "hash",
                header: "SHA-256",
                render: (e) => <Copyable value={e.content_sha256} display={`${e.content_sha256.slice(0, 10)}…`} />
              },
              {
                key: "collected",
                header: "Collected",
                align: "right",
                render: (e) => <span title={dateTime(e.collected_at)}>{relative(e.collected_at)}</span>
              },
              {
                key: "verify",
                header: "",
                align: "right",
                render: (e) => <VerifyButton id={e.id} />
              }
            ]}
          />
        </Card>
      ) : null}

      {tab === "notes" ? <NotesTab caseId={caseId} notes={data?.notes ?? []} canWrite={can("case:write")} onAdded={reload} /> : null}

      {tab === "traces" ? (
        <Card title="Trace history" hint="Every run is stored with its limits, so a result can be reproduced or challenged." flush>
          <DataTable
            rows={data?.traces ?? []}
            loading={loading}
            empty="No traces run for this case."
            columns={[
              { key: "root", header: "Root", render: (t) => <Copyable value={t.root_address} /> },
              { key: "chain", header: "Chain", render: (t) => <ChainBadge chain={t.chain} /> },
              {
                key: "limits",
                header: "Limits",
                render: (t) => `${t.max_hops} hops · ${t.direction}`
              },
              {
                key: "size",
                header: "Graph",
                render: (t) => `${num(t.node_count)}n / ${num(t.edge_count)}e`
              },
              { key: "risk", header: "Risk", render: (t) => <RiskBadge level={t.risk_level} score={t.risk_score} /> },
              { key: "when", header: "When", align: "right", render: (t) => dateTime(t.created_at) },
              {
                key: "open",
                header: "",
                align: "right",
                render: (t) => (
                  <button
                    className="btn ghost sm"
                    onClick={() => navigate(`/fund-flow?traceId=${t.id}`)}
                  >
                    View
                  </button>
                )
              }
            ]}
          />
        </Card>
      ) : null}

      <EntityRiskModal entity={entityRisk} onClose={() => setEntityRisk(null)} />
      <CloseCaseModal
        open={closeOpen}
        caseId={caseId}
        caseRef={c?.case_ref ?? ""}
        onClose={() => setCloseOpen(false)}
        onClosed={() => {
          setCloseOpen(false);
          toast.success("Case closed and logged to the audit trail");
          reload();
          readiness.reload();
        }}
      />
      <ReopenCaseModal
        open={reopenOpen}
        caseId={caseId}
        caseRef={c?.case_ref ?? ""}
        onClose={() => setReopenOpen(false)}
        onReopened={() => {
          setReopenOpen(false);
          toast.success("Case reopened");
          reload();
          readiness.reload();
        }}
      />
      <AddEntityModal
        open={addEntityOpen}
        caseId={caseId}
        defaultAddress={c?.seed_value ?? undefined}
        onClose={() => setAddEntityOpen(false)}
        onAdded={() => {
          setAddEntityOpen(false);
          toast.success("Entity attached");
          reload();
        }}
      />
      <AddEvidenceModal
        open={addEvidenceOpen}
        caseId={caseId}
        defaultChain={(c?.chain ?? "bitcoin") as Chain}
        defaultAddress={c?.seed_value ?? undefined}
        onClose={() => setAddEvidenceOpen(false)}
        onAdded={() => {
          setAddEvidenceOpen(false);
          toast.success("Evidence collected and hashed");
          reload();
        }}
      />
      <RunTraceModal
        open={traceOpen}
        caseId={caseId}
        defaultChain={(c?.chain ?? "bitcoin") as Chain}
        defaultAddress={c?.seed_value ?? undefined}
        onClose={() => setTraceOpen(false)}
        onDone={() => {
          setTraceOpen(false);
          toast.success("Trace complete");
          setTab("graph");
          reload();
        }}
      />
    </>
  );
}

/* ---------------------------------------------------------------- graph tab */

function CaseGraph({
  traces,
  onRunTrace
}: {
  traces: CaseDetailResponse["traces"];
  onRunTrace: () => void;
}): JSX.Element {
  const [traceId, setTraceId] = useState<string | null>(traces[0]?.id ?? null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const { data, error, loading } = useQuery<{ graph: TraceResponse["graph"] }>(
    traceId ? `/api/chain/traces/${traceId}` : null,
    [traceId]
  );

  if (!traces.length) {
    // Offer the action here rather than describing it. Telling someone to use
    // a button elsewhere on the page leaves the tab looking broken.
    return (
      <Card title="Fund-flow graph">
        <p className="muted">
          No traces have been run for this case. A graph is built from a recorded trace, so run one to populate
          it.
        </p>
        <button className="btn primary" onClick={onRunTrace}>
          Run trace
        </button>
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Fund-flow graph"
        hint="Stored from the recorded run. Layout is by hop distance; node fill is risk band, edge stroke is evidence status."
        actions={
          <select value={traceId ?? ""} onChange={(e) => setTraceId(e.target.value)} className="sm">
            {traces.map((t) => (
              <option key={t.id} value={t.id}>
                {dateTime(t.created_at)} · {t.max_hops} hops · {num(t.node_count)} nodes
                {/* A stored synthetic run must never be mistakable for a real one. */}
                {t.is_demo ? " · SIMULATED" : ""}
              </option>
            ))}
          </select>
        }
      >
        {error ? <ErrorState error={error} /> : null}
        {loading ? <div className="boot"><span className="spinner" /></div> : null}
        {data?.graph ? (
          <>
            <GraphView
              graph={data.graph}
              onSelect={(n) => {
                setSelected(n);
                setSelectedEdge(null);
              }}
              onSelectEdge={(e) => {
                setSelectedEdge(e);
                setSelected(null);
              }}
              selectedId={selected?.id ?? null}
              selectedEdgeId={selectedEdge?.id ?? null}
            />
            {/* Root only. Never rendered per node: a per-node advisory would both
                mean 200 extra service calls per trace and imply each hop was
                individually assessed. */}
            <GraphRiskAdvisory graph={data.graph} />
          </>
        ) : null}
      </Card>

      {selected ? (
        <Card title="Selected entity">
          <dl className="kv">
            <dt>Address</dt>
            <dd>
              <Copyable value={selected.address} />
            </dd>
            <dt>Label</dt>
            <dd>{selected.label ?? selected.kind}</dd>
            <dt>Risk</dt>
            <dd>
              <RiskBadge level={selected.riskLevel} score={selected.riskScore} />
            </dd>
            <dt>Hop</dt>
            <dd>{selected.hopDistance}</dd>
            <dt>Transactions</dt>
            <dd>{num(selected.txCount)}</dd>
            <dt>Received</dt>
            <dd>{usd(selected.inVolumeUsd)}</dd>
            <dt>Sent</dt>
            <dd>{usd(selected.outVolumeUsd)}</dd>
          </dl>
        </Card>
      ) : null}

      {selectedEdge && data?.graph ? (
        <Card title="Selected transfer" hint="What we observed, what we traced, and how strongly we can say so.">
          <EdgeEvidence edge={selectedEdge} graph={data.graph} />
        </Card>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ notes */

function NoteList({ notes }: { notes: CaseNoteRow[] }): JSX.Element {
  if (!notes.length) return <p className="muted">No notes yet.</p>;
  return (
    <ul className="note-list">
      {notes.map((n) => (
        <li key={n.id} className={`note ${n.kind}`}>
          <div className="note-head">
            <Badge tone={n.kind === "finding" ? "high" : n.kind === "hypothesis" ? "medium" : "neutral"}>{n.kind}</Badge>
            {n.pinned ? <Badge tone="info">pinned</Badge> : null}
            <span className="muted">{n.author ?? "unknown"}</span>
            <span className="muted">{relative(n.created_at)}</span>
          </div>
          <p>{n.body}</p>
        </li>
      ))}
    </ul>
  );
}

function NotesTab({
  caseId,
  notes,
  canWrite,
  onAdded
}: {
  caseId: string;
  notes: CaseNoteRow[];
  canWrite: boolean;
  onAdded: () => void;
}): JSX.Element {
  const toast = useToast();
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<CaseNoteRow["kind"]>("note");
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    setBusy(true);
    try {
      await api.post(`/api/cases/${caseId}/notes`, { body: body.trim(), kind, pinned });
      setBody("");
      setPinned(false);
      toast.success("Note added");
      onAdded();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add the note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Grid cols={2}>
      <Card title={`Notes (${notes.length})`}>
        <NoteList notes={notes} />
      </Card>
      <Card title="Add a note" hint="Label it honestly: a hypothesis is not a finding.">
        {canWrite ? (
          <div className="stack">
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value as CaseNoteRow["kind"])}>
                <option value="note">Note — working observation</option>
                <option value="hypothesis">Hypothesis — untested theory</option>
                <option value="finding">Finding — supported conclusion</option>
                <option value="status">Status — workflow update</option>
              </select>
            </Field>
            <Field label="Body">
              <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <span>Pin to the top of the case</span>
            </label>
            <button className="btn primary" disabled={busy || !body.trim()} onClick={() => void add()}>
              {busy ? "Saving…" : "Add note"}
            </button>
          </div>
        ) : (
          <Notice tone="info">Your role can read notes but not add them.</Notice>
        )}
      </Card>
    </Grid>
  );
}

/* ------------------------------------------------------------- modals etc. */

function VerifyButton({ id }: { id: string }): JSX.Element {
  const [result, setResult] = useState<EvidenceVerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <button
        className="btn ghost sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setResult(await api.get<EvidenceVerifyResponse>(`/api/evidence/${id}/verify`));
          } catch (err) {
            alert(err instanceof ApiError ? err.message : "Verification failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "Verify"}
      </button>
      {result ? (
        <Modal open onClose={() => setResult(null)} title="Evidence integrity">
          <Notice
            tone={result.valid ? (result.sealVersion === "canonical-v2" ? "ok" : "warn") : "danger"}
            title={
              !result.valid
                ? "Digest mismatch"
                : result.sealVersion === "canonical-v2"
                  ? "Digest matches"
                  : "Digest matches (legacy seal)"
            }
          >
            <p>
              {!result.valid
                ? "The stored content does not reproduce the digest recorded at collection. Treat this artifact as unverified and re-collect it from the source."
                : "The stored content has not been modified since collection. Recomputed "}
              {result.valid ? (
                <>
                  <code>{result.recomputed.slice(0, 16)}…</code> against stored{" "}
                  <code>{result.stored.slice(0, 16)}…</code>.
                </>
              ) : (
                <>
                  <code>{result.recomputed.slice(0, 16)}…</code> against stored <code>{result.stored.slice(0, 16)}…</code>.
                </>
              )}
            </p>
            {result.note ? <p className="field-hint">{result.note}</p> : null}
          </Notice>
          <p className="field-hint">
            {result.canonicalisation} Verified {dateTime(result.checkedAt)}.
          </p>
        </Modal>
      ) : null}
    </>
  );
}

function ReopenCaseModal({
  open,
  caseId,
  caseRef,
  onClose,
  onReopened
}: {
  open: boolean;
  caseId: string;
  caseRef: string;
  onClose: () => void;
  onReopened: () => void;
}): JSX.Element {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNote("");
      setError(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Reopen ${caseRef}`}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || note.trim().length < 5}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await reopenCase(caseId, note);
                onReopened();
              } catch (err) {
                setError(lifecycleError(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Reopening…" : "Reopen case"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="warn" title="Reopening is not a quiet edit">
          <p>
            The case returns to <strong>Open</strong> and restarts the flow. The previous closure record, the closure note
            and the original close entry in the audit log are all retained — reopening adds to the record, it never
            erases it.
          </p>
        </Notice>
        <Field label="Why is this being reopened?" required hint="Recorded as a pinned note and in the audit log.">
          <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} autoFocus />
        </Field>
        {note.trim().length > 0 && note.trim().length < 5 ? (
          <span className="field-hint">At least 5 characters.</span>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

function EntityRiskModal({
  entity,
  onClose
}: {
  entity: { address: string; factors: unknown[]; riskScore: number | null; riskLevel: string | null } | null;
  onClose: () => void;
}): JSX.Element {
  if (!entity) return <></>;
  const factors = entity.factors as RiskFactor[];

  // Prefer the score the engine stored on the entity row. It is the
  // authoritative value, it reflects any operator weight overrides applied at
  // the time, and it cannot drift from `risk_level`. The client-side curve is
  // only a fallback for entities scored before those columns were carried here.
  const derived = deriveRisk(factors);
  const score = entity.riskScore ?? derived.score;
  const level = entity.riskLevel ?? derived.level;

  return (
    <Modal open onClose={onClose} title="Entity risk factors" wide>
      <Copyable value={entity.address} display={entity.address} />
      {factors.length || entity.riskScore != null ? (
        <RiskPanel risk={{ score, level: level as RiskLevel, factors }} />
      ) : (
        <Notice tone="info">No stored risk factors for this entity. Look it up in the explorer to score it.</Notice>
      )}
    </Modal>
  );
}
