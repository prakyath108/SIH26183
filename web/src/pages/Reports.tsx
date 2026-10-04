import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useToast } from "../lib/toast";
import type { CaseReport, CaseRow, EvidenceListResponse, EvidenceVerifyResponse } from "../types";
import {
  Badge,
  Card,
  ChainBadge,
  Copyable,
  DataTable,
  Details,
  ErrorState,
  Grid,
  Modal,
  Notice,
  PageHeader,
  RiskBadge,
  SearchInput,
  Tabs
} from "../components/ui";
import { dateTime, num, prettyJson, relative, usd } from "../lib/format";

type Tab = "register" | "report";

export default function Reports(): JSX.Element {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("register");
  const [caseQuery, setCaseQuery] = useState("");
  const [viewing, setViewing] = useState<EvidenceListResponse["evidence"][number] | null>(null);
  const [previewCase, setPreviewCase] = useState<CaseRow | null>(null);

  const evidence = useQuery<EvidenceListResponse>("/api/evidence?limit=200");
  const cases = useQuery<{ cases: CaseRow[] }>(
    caseQuery.length > 1 ? `/api/cases${caseQuery.length > 1 ? `?q=${encodeURIComponent(caseQuery)}&limit=8` : ""}` : null,
    [caseQuery]
  );

  return (
    <>
      <PageHeader
        title="Reports & Evidence Management"
        subtitle="The evidence register and the generated case reports built from it."
        actions={
          <button className="btn" onClick={evidence.reload}>
            Refresh
          </button>
        }
      />

      <Tabs active={tab} onChange={setTab} tabs={[{ id: "register", label: "Evidence register" }, { id: "report", label: "Generate report" }]} />

      {tab === "register" ? (
        <>
          <Notice tone="info" title="What makes evidence hold up">
            <p>
              Each item is hashed with SHA-256 over canonically ordered JSON, and the digest is stored beside it. A
              verifier recomputes the hash and compares. That proves the artifact has not changed since collection — it
              does not prove the collection was honest, which is why the provenance recorded at capture time matters.
            </p>
          </Notice>

          <Card title={`Evidence (${num(evidence.data?.evidence.length ?? 0)})`} flush>
            {evidence.error ? <ErrorState error={evidence.error} onRetry={evidence.reload} /> : null}
            <DataTable
              rows={evidence.data?.evidence ?? []}
              loading={evidence.loading}
              empty="No evidence collected. Evidence is added from within a case."
              onRowClick={(e) => setViewing(e)}
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
                  key: "case",
                  header: "Case",
                  render: (e) => (
                    <Link to={`/investigations/${e.case_id}`} className="mono small" onClick={(ev) => ev.stopPropagation()}>
                      {e.case_ref}
                    </Link>
                  )
                },
                { key: "chain", header: "Chain", render: (e) => <ChainBadge chain={e.chain} /> },
                {
                  key: "digest",
                  header: "SHA-256",
                  render: (e) => <Copyable value={e.content_sha256} display={`${e.content_sha256.slice(0, 12)}…`} />
                },
                {
                  key: "collector",
                  header: "Collected by",
                  render: (e) => e.collected_by_name ?? <span className="muted">unknown</span>
                },
                {
                  key: "when",
                  header: "Collected",
                  align: "right",
                  render: (e) => <span title={dateTime(e.collected_at)}>{relative(e.collected_at)}</span>
                },
                {
                  key: "verify",
                  header: "",
                  align: "right",
                  render: (e) => (
                    <VerifyButton
                      id={e.id}
                      onDone={(r) =>
                        !r.valid
                          ? toast.error("Digest mismatch — artifact has changed")
                          : r.sealVersion === "canonical-v2"
                            ? toast.success("Digest matches — artifact unmodified")
                            : toast.notify("Digest matches — sealed under the previous rule")
                      }
                    />
                  )
                }
              ]}
            />
          </Card>
        </>
      ) : null}

      {tab === "report" ? (
        <Grid cols={1}>
          <Card title="Choose a case" hint="Reports separate chain facts from attributions and analyst judgement.">
            <SearchInput value={caseQuery} onChange={setCaseQuery} placeholder="Search cases by reference or title…" />
            {cases.data ? (
              <DataTable
                rows={cases.data.cases}
                empty="No matching cases."
                columns={[
                  { key: "ref", header: "Reference", render: (c) => <span className="mono">{c.case_ref}</span> },
                  { key: "title", header: "Title", render: (c) => c.title },
                  {
                    key: "open",
                    header: "",
                    align: "right",
                    render: (c) => (
                      <div className="row-actions">
                        <Link className="btn ghost sm" to={`/investigations/${c.id}`}>
                          Open
                        </Link>
                        <button
                          className="btn sm"
                          onClick={async () => {
                            try {
                              await api.download(`/api/reports/cases/${c.id}/export.pdf`, `${c.case_ref}-report.pdf`);
                              toast.success("PDF downloaded");
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : "Export failed");
                            }
                          }}
                        >
                          PDF
                        </button>
                        <button className="btn ghost sm" onClick={() => setPreviewCase(c)}>
                          Preview
                        </button>
                      </div>
                    )
                  }
                ]}
              />
            ) : null}
            {caseQuery.length <= 1 ? <p className="field-hint">Start typing to search.</p> : null}
          </Card>

          {previewCase ? (
            <Card
              title={`Report — ${previewCase.case_ref}`}
              hint="Same content as the PDF, rendered in the browser."
              actions={
                <button className="btn ghost sm" onClick={() => setPreviewCase(null)}>
                  Close
                </button>
              }
            >
              <ReportPreview caseId={previewCase.id} />
            </Card>
          ) : null}
        </Grid>
      ) : null}

      <EvidenceModal item={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

function VerifyButton({ id, onDone }: { id: string; onDone: (r: EvidenceVerifyResponse) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn ghost sm"
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          onDone(await api.get<EvidenceVerifyResponse>(`/api/evidence/${id}/verify`));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : "Verify"}
    </button>
  );
}

function EvidenceModal({
  item,
  onClose
}: {
  item: EvidenceListResponse["evidence"][number] | null;
  onClose: () => void;
}): JSX.Element {
  const detail = useQuery<{ evidence: Record<string, unknown> }>(item ? `/api/evidence/${item.id}` : null, [item?.id]);
  const provenance = (detail.data?.evidence?.content ?? null) as { provenance?: Record<string, unknown> } | null;

  return (
    <Modal open={Boolean(item)} onClose={onClose} title={item?.title ?? "Evidence"} wide>
      {item ? (
        <>
          <dl className="kv">
            <dt>Kind</dt>
            <dd>
              <Badge tone="neutral">{item.kind}</Badge>
            </dd>
            <dt>Case</dt>
            <dd>
              <Link to={`/investigations/${item.case_id}`}>{item.case_ref}</Link>
            </dd>
            <dt>Chain</dt>
            <dd>
              <ChainBadge chain={item.chain} />
            </dd>
            <dt>Address</dt>
            <dd>{item.address ? <Copyable value={item.address} display={item.address} /> : "—"}</dd>
            <dt>Transaction</dt>
            <dd>{item.tx_hash ? <Copyable value={item.tx_hash} display={item.tx_hash} /> : "—"}</dd>
            <dt>Digest</dt>
            <dd>
              <Copyable value={item.content_sha256} display={item.content_sha256} />
            </dd>
            <dt>Collected</dt>
            <dd>
              {dateTime(item.collected_at)} by {item.collected_by_name ?? "unknown"}
            </dd>
          </dl>

          {provenance?.provenance ? (
            <Details summary="Provenance" defaultOpen>
              <dl className="kv">
                {Object.entries(provenance.provenance).map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>{k}</dt>
                    <dd className="small">{typeof v === "string" ? v : prettyJson(v)}</dd>
                  </div>
                ))}
              </dl>
            </Details>
          ) : null}

          <Details summary="Captured content">
            <pre className="json">{prettyJson(detail.data?.evidence?.content ?? item.content ?? null)}</pre>
          </Details>
        </>
      ) : null}
    </Modal>
  );
}

function ReportPreview({ caseId }: { caseId: string }): JSX.Element {
  const { data, error, loading } = useQuery<CaseReport>(`/api/reports/cases/${caseId}`);

  if (error) return <ErrorState error={error} />;
  if (loading || !data) return <div className="boot"><span className="spinner" /></div>;

  return (
    <div className="report">
      <Notice tone="warn" title="Read the section labels">
        <p>
          Chain observations, third-party attributions and analyst conclusions are kept apart on purpose. A reader should
          always be able to tell which is which.
        </p>
      </Notice>

      <h3>{data.case.case_ref} — {data.case.title}</h3>
      <p className="muted">
        Lead: {data.case.lead_name ?? "unassigned"} · Generated {dateTime(data.generatedAt)} by {data.generatedBy.email} (
        {data.generatedBy.role})
      </p>

      <section>
        <h4>1. On-chain observations</h4>
        <p className="field-hint">Facts read from the chain. Establishes what moved, not why.</p>
        {data.sections.chainFacts.entities.length ? (
          <table className="data dense">
            <thead>
              <tr>
                <th>Address</th>
                <th>Chain</th>
                <th>Type</th>
                <th>Hop</th>
                <th className="right">Risk</th>
                <th className="right">Tx</th>
                <th className="right">Value</th>
              </tr>
            </thead>
            <tbody>
              {data.sections.chainFacts.entities.map((e) => (
                <tr key={e.address}>
                  <td className="mono">{e.address.slice(0, 12)}…{e.address.slice(-6)}</td>
                  <td>{e.chain}</td>
                  <td>{e.label ?? e.kind}</td>
                  <td className="right">{num(e.hop_count)}</td>
                  <td className="right">
                    <RiskBadge level={e.risk_level} score={e.risk_score} />
                  </td>
                  <td className="right num">{num(e.tx_count)}</td>
                  <td className="right num">{usd(e.amount_usd, { fallback: "not priced" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No entities linked.</p>
        )}
      </section>

      {data.sections.chainFacts.traces.length ? (
        <section>
          <h4>2. Trace runs</h4>
          <table className="data dense">
            <thead>
              <tr>
                <th>Run</th>
                <th>Root</th>
                <th className="right">Hops</th>
                <th className="right">Nodes</th>
                <th className="right">Edges</th>
                <th className="right">Risk</th>
              </tr>
            </thead>
            <tbody>
              {data.sections.chainFacts.traces.map((t) => (
                <tr key={t.id}>
                  <td>{dateTime(t.created_at)}</td>
                  <td className="mono">{t.root_address.slice(0, 10)}…</td>
                  <td className="right num">{t.max_hops}</td>
                  <td className="right num">{num(t.node_count)}</td>
                  <td className="right num">{num(t.edge_count)}</td>
                  <td className="right">
                    <RiskBadge level={t.risk_level} score={t.risk_score} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section>
        <h4>3. Third-party attributions</h4>
        <p className="field-hint">Claims by others. Not verified, and not evidence of identity or wrongdoing.</p>
        {data.sections.thirdPartyAttribution.labels.length ? (
          <ul className="tight">
            {data.sections.thirdPartyAttribution.labels.map((l) => (
              <li key={`${l.address}-${l.name}`}>
                <strong>{l.name}</strong> — {l.kind} — <span className="mono">{l.address.slice(0, 12)}…</span>{" "}
                <span className="muted">({l.source}, {l.confidence} confidence)</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No third-party labels apply to this case's entities.</p>
        )}
      </section>

      {data.sections.analystHypotheses.notes.length ? (
        <section>
          <h4>4. Analyst hypotheses</h4>
          <p className="field-hint">Unverified theories, retained so they can be tested or discarded.</p>
          <ul className="tight">
            {data.sections.analystHypotheses.notes.map((n, i) => (
              <li key={i}>
                {n.body} <span className="muted">— {n.author ?? "unknown"}, {dateTime(n.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4>5. Evidence register</h4>
        {data.sections.evidence.items.length ? (
          <ul className="tight">
            {data.sections.evidence.items.map((e) => (
              <li key={e.id}>
                <strong>{e.title}</strong> ({e.kind}) — collected {dateTime(e.collected_at)} ·{" "}
                <span className="mono small">{e.content_sha256.slice(0, 16)}…</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No evidence recorded.</p>
        )}
      </section>

      <section>
        <h4>6. Methodology and limitations</h4>
        <p>{data.methodology.riskScoring}</p>
        <p className="muted">{data.methodology.dataSources}</p>
        <ul>
          {data.methodology.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
