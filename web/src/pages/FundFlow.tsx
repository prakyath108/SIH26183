import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useToast } from "../lib/toast";
import type { Chain, DemoCaseSummary, GraphEdge, GraphNode, TraceMethod, TraceResponse } from "../types";
import {
  Badge,
  Card,
  ChainBadge,
  Copyable,
  EmptyState,
  ErrorState,
  Field,
  Grid,
  Kpi,
  KpiRow,
  Notice,
  PageHeader,
  RiskBadge,
  Tabs
} from "../components/ui";
import { GraphTable, GraphView, EVIDENCE_LABEL } from "../components/GraphView";
import { EdgeEvidence, NodeEvidence, ReconciliationPanel } from "../components/EvidencePanel";
import { duration, num, shortId, usd } from "../lib/format";

type Tab = "graph" | "table" | "edges" | "timeline";

interface Settings {
  maxHops: number;
  direction: "forward" | "backward" | "both";
  offline: boolean;
  amountToTrace: string;
  asset: string;
  method: TraceMethod | "ai";
  demoCaseId: string;
}

/**
 * Traversal internals — node, edge and edge-per-transaction caps — are
 * deliberately not exposed. They exist to bound the work, not to be tuned: an
 * investigator lowering a cap to "see more" gets a smaller graph, and one
 * raising it gets a slow one. Every cap that does trip is reported on the
 * result, so the shape of the graph is never silently decided here.
 */
const DEFAULTS: Settings = {
  maxHops: 3,
  direction: "forward",
  offline: false,
  amountToTrace: "",
  asset: "",
  method: "pro_rata",
  demoCaseId: ""
};

const NATIVE_ASSET: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  tron: "TRX",
  polygon: "MATIC"
};

const METHODS: { value: TraceMethod | "ai"; label: string; disabled?: boolean }[] = [
  { value: "pro_rata", label: "Pro-rata — split by observed amounts (conserves the total)" },
  { value: "direct", label: "Direct — only clean pass-throughs, never guesses" },
  { value: "fifo", label: "FIFO — oldest funds first" },
  { value: "haircut", label: "Haircut — pro-rata, discounted for co-mingling" },
  { value: "poison", label: "Poison-pill — assume the worst (over-attributes on purpose)" },
  { value: "ai", label: "AI-Assisted Analysis (unavailable)", disabled: true }
];

export default function FundFlow(): JSX.Element {
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [address, setAddress] = useState(params.get("address") ?? "");
  const [chain, setChain] = useState<Chain>((params.get("chain") as Chain) ?? "bitcoin");
  const [caseId, setCaseId] = useState<string | null>(params.get("caseId"));
  const [settings, setSettings] = useState<Settings>({ ...DEFAULTS, method: "pro_rata" });
  const [result, setResult] = useState<TraceResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<Tab>("graph");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [demoCases, setDemoCases] = useState<DemoCaseSummary[]>([]);

  const traceId = params.get("traceId");
  const stored = useQuery<{ graph: TraceResponse["graph"]; createdAt: string }>(
    traceId ? `/api/chain/traces/${traceId}` : null,
    [traceId]
  );

  useEffect(() => {
    if (stored.data?.graph) {
      setResult({ graph: stored.data.graph, meta: { durationMs: 0, truncated: stored.data.graph.totals.truncated } });
    }
  }, [stored.data]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ cases: DemoCaseSummary[] }>("/api/chain/demo-cases")
      .then((r) => {
        if (!cancelled) setDemoCases(r.cases);
      })
      .catch(() => {
        // The demo picker is a convenience; its absence must not block tracing.
        if (!cancelled) setDemoCases([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When a demo case is picked, populate the form with its authored defaults.
  // An explicit user edit after that is preserved because we only write when the
  // demoCaseId actually changes.
  const lastDemoId = useRef<string>("");
  useEffect(() => {
    if (settings.demoCaseId === lastDemoId.current) return;
    lastDemoId.current = settings.demoCaseId;
    if (!settings.demoCaseId) return;
    const c = demoCases.find((d) => d.id === settings.demoCaseId);
    if (!c) return;
    setSettings((s) => ({
      ...s,
      maxHops: c.maxHops,
      amountToTrace: s.amountToTrace || c.amount,
      asset: s.asset || c.asset,
      method: s.method || c.suggestedMethod
    }));
    setChain(c.chain);
    setAddress(c.rootAddress);
  }, [settings.demoCaseId, demoCases]);

  const runningDemo = settings.demoCaseId !== "";
  const effectiveAsset = settings.asset.trim() || NATIVE_ASSET[chain] || "ETH";

  const amountError = useMemo(() => {
    const t = settings.amountToTrace.trim();
    if (!t) return null;
    if (!/^\d+(\.\d+)?$/.test(t)) return "Enter a plain positive number, for example 12.5";
    if (Number(t) <= 0) return "The amount must be greater than zero";
    return null;
  }, [settings.amountToTrace]);

  async function run(): Promise<void> {
    if (settings.method === "ai") {
      toast.error("AI-Assisted Analysis is not available yet.");
      return;
    }
    setBusy(true);
    setError(null);
    setSelected(null);
    setSelectedEdge(null);
    try {
      const res = await api.post<TraceResponse>("/api/chain/trace", {
        caseId: runningDemo ? undefined : caseId ?? undefined,
        demoCaseId: runningDemo ? settings.demoCaseId : undefined,
        address: runningDemo ? undefined : address.trim() || undefined,
        chain,
        maxHops: settings.maxHops,
        direction: settings.direction,
        offline: settings.offline,
        amountToTrace: settings.amountToTrace.trim() || undefined,
        asset: effectiveAsset,
        method: settings.method
      });
      setResult(res);
      setTab("graph");
      const next = new URLSearchParams(params);
      next.delete("traceId");
      setParams(next, { replace: true });

      const n = res.graph.nodes.length;
      const recon = res.graph.reconciliation;
      if (res.graph.demo) {
        toast.notify(
          `Simulated scenario run: ${num(n)} nodes. Every figure is synthetic and is not a finding.`
        );
      } else if (recon && recon.status !== "not_applicable") {
        const pct = recon.coverage === null ? "—" : `${Math.round(recon.coverage * 100)}%`;
        toast.notify(
          `Traced ${recon.initialAmount} ${recon.asset}: ${pct} accounted for, ${recon.unresolved} unresolved.`
        );
      } else if (res.graph.totals.truncated) {
        toast.notify(
          `Traced ${num(n)} nodes before hitting a limit. The graph is partial, so absence of a path is not evidence of one.`
        );
      } else {
        toast.success(`Traced ${num(n)} nodes and ${num(res.graph.edges.length)} transfers.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "unknown", "Trace failed"));
    } finally {
      setBusy(false);
    }
  }

  const graph = result?.graph;

  // Chronological view of every movement, so a laundering chain that loops back
  // in time is visible rather than hidden by the hop layout.
  const timeline = useMemo(() => {
    if (!graph) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.edges
      .map((e) => ({ edge: e, from: byId.get(e.source), to: byId.get(e.target) }))
      .sort((a, b) => {
        const ta = a.edge.timestamp ? Date.parse(a.edge.timestamp) : Number.MAX_SAFE_INTEGER;
        const tb = b.edge.timestamp ? Date.parse(b.edge.timestamp) : Number.MAX_SAFE_INTEGER;
        return ta - tb;
      });
  }, [graph]);

  return (
    <>
      <PageHeader
        title="Fund Flow"
        subtitle="Follow a specific quantity of funds, or every movement when no amount is nominated. Each edge states how strong its evidence is."
        actions={
          result ? (
            <button className="btn" onClick={() => void run()} disabled={busy}>
              {busy ? "Tracing…" : "Re-run"}
            </button>
          ) : null
        }
      />

      <Card title="What to trace">
        <div className="trace-form">
          {demoCases.length > 0 ? (
            <Field
              label="Scenario"
              hint="Optional. A scenario is invented data for learning the tool; it is not evidence about any real wallet."
            >
              <select
                value={settings.demoCaseId}
                onChange={(e) => setSettings({ ...settings, demoCaseId: e.target.value })}
              >
                <option value="">Live investigation — query a real address</option>
                {demoCases.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {!runningDemo ? (
            <>
              <Field label="Root address" hint="Leave blank with a case selected to trace from that case's first seed entity.">
                <input value={address} onChange={(e) => setAddress(e.target.value)} className="mono" placeholder="bc1q… or 0x…" />
              </Field>

              <Field label="Chain">
                <select value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
                  <option value="bitcoin">Bitcoin</option>
                  <option value="ethereum">Ethereum</option>
                  <option value="tron">Tron</option>
                  <option value="polygon">Polygon</option>
                </select>
              </Field>
            </>
          ) : null}

          <Field
            label="Amount to trace"
            hint="Optional. Leave blank to follow every transfer instead of one quantity."
            error={amountError ?? undefined}
          >
            <input
              value={settings.amountToTrace}
              onChange={(e) => setSettings({ ...settings, amountToTrace: e.target.value })}
              className="mono"
              inputMode="decimal"
              placeholder="e.g. 25"
            />
          </Field>

          <Field label="Asset" hint="The unit the quantity is in.">
            <input
              value={settings.asset}
              onChange={(e) => setSettings({ ...settings, asset: e.target.value })}
              placeholder={effectiveAsset}
              maxLength={16}
            />
          </Field>

          <Field label="Attribution method" hint="Only matters once the funds split.">
            <select
              value={settings.method}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "ai") return;
                setSettings({ ...settings, method: v as TraceMethod });
              }}
            >
              {METHODS.map((m) => (
                <option key={m.value} value={m.value} disabled={m.disabled} title={m.disabled ? "This option is not yet available." : undefined}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Direction">
            <select
              value={settings.direction}
              onChange={(e) => setSettings({ ...settings, direction: e.target.value as Settings["direction"] })}
            >
              <option value="forward">Forward — where the funds went</option>
              <option value="backward">Backward — where the funds came from</option>
              <option value="both">Both directions</option>
            </select>
          </Field>

          <Field label="How far to follow" hint="Each extra hop multiplies the work.">
            <select value={settings.maxHops} onChange={(e) => setSettings({ ...settings, maxHops: Number(e.target.value) })}>
              <option value={1}>1 hop</option>
              <option value={2}>2 hops</option>
              <option value={3}>3 hops — recommended</option>
              <option value={4}>4 hops</option>
              <option value={5}>5 hops</option>
              <option value={6}>6 hops — slow</option>
            </select>
          </Field>

          <Field label="Case (optional)" hint="Saves the trace to a case. Scenarios are never saved to one.">
            <input
              value={caseId ?? ""}
              onChange={(e) => setCaseId(e.target.value.trim() || null)}
              placeholder="Case UUID"
              className="mono"
              disabled={runningDemo}
            />
          </Field>

          <div className="field checkbox-field">
            <label className="check">
              <input
                type="checkbox"
                checked={settings.offline}
                onChange={(e) => setSettings({ ...settings, offline: e.target.checked })}
              />
              <span>
                Stored records only
                <span className="field-hint">
                  No live chain calls. Faster, but reflects our own past records rather than the chain.
                </span>
              </span>
            </label>
          </div>
        </div>

        {runningDemo ? (
          <Notice tone="warn" title="Simulated data">
            <p>
              <strong>This run uses invented data.</strong> Every address, transaction, amount and score is synthetic and
              corresponds to no real blockchain activity. Do not cite anything from it as a finding.
            </p>
          </Notice>
        ) : null}

        {!settings.amountToTrace.trim() && !runningDemo ? (
          <Notice tone="info" title="No amount set — this will trace every movement">
            <p>
              With no quantity nominated the graph shows all observed transfers rather than following a specific sum, and the
              reconciliation figures will be marked <em>not applicable</em>.
            </p>
          </Notice>
        ) : null}

        <div className="row-gap">
          <button
            className="btn primary"
            onClick={() => void run()}
            disabled={busy || !!amountError || (runningDemo ? false : !address.trim() && !caseId)}
          >
            {busy ? "Tracing…" : runningDemo ? "Run scenario" : "Run trace"}
          </button>
          {caseId && !runningDemo ? (
            <Link className="btn ghost sm" to={`/investigations/${caseId}?tab=graph`}>
              Open case
            </Link>
          ) : null}
        </div>
      </Card>

      {error ? <ErrorState error={error} /> : null}
      {stored.error ? <ErrorState error={stored.error} onRetry={stored.reload} /> : null}

      {!graph && !busy ? (
        <EmptyState>
          Enter an address, or pick a scenario, to trace where funds went. Naming an amount turns this into a specific
          question — where did <em>this much</em> go — and the answer is reconciled against that amount.
        </EmptyState>
      ) : null}

      {graph ? (
        <>
          {graph.demo ? (
            <Notice tone="warn" title="Simulated data — not a finding">
              <p>
                <strong>Every address, transaction, amount and score in this graph is synthetic.</strong> It exists to
                show a tracing behaviour and corresponds to no real blockchain activity.
              </p>
            </Notice>
          ) : null}

          <Notice
            tone={graph.totals.truncated ? "warn" : "ok"}
            title={graph.totals.truncated ? "Trace stopped early" : "Trace complete"}
          >
            <p>
              {graph.nodes.length} nodes and {graph.edges.length} edges across{" "}
              {new Set(graph.nodes.map((n) => n.hopDistance)).size} hop levels, traced {graph.direction} to {graph.maxHops}{" "}
              hops{result?.meta.durationMs ? ` in ${duration(result.meta.durationMs)}` : ""}.
              {graph.totals.truncated
                ? ` Stopped because: ${graph.totals.truncatedReasons.join("; ")}.`
                : " No configured limit was reached, though upstream data may still be incomplete."}
              {graph.notes?.length ? ` ${graph.notes.join(" ")}` : ""}
            </p>
          </Notice>

          <KpiRow cols={4}>
            {graph.amountToTrace ? (
              <Kpi
                label={`Quantity traced (${graph.asset ?? ""})`}
                value={graph.amountToTrace}
                sub={
                  graph.reconciliation?.coverage !== null && graph.reconciliation?.coverage !== undefined
                    ? `${Math.round(graph.reconciliation.coverage * 100)}% accounted for`
                    : "No reconciliation"
                }
                tone={
                  graph.reconciliation?.status === "reconciled"
                    ? "ok"
                    : graph.reconciliation?.status === "partial"
                      ? "warn"
                      : undefined
                }
              />
            ) : (
              <Kpi label="Mode" value="All movement" sub="No quantity nominated, so there is no total to reconcile" />
            )}
            <Kpi
              label={graph.amountToTrace ? "Unresolved" : "Value out (from root)"}
              value={
                graph.amountToTrace
                  ? `${graph.reconciliation?.unresolved ?? "—"} ${graph.asset ?? ""}`.trim()
                  : usd(graph.totals.valueOutUsd)
              }
              sub={graph.amountToTrace ? "No supported destination found" : "Edges leaving the root"}
              tone={graph.amountToTrace && Number(graph.reconciliation?.unresolved ?? 0) > 0 ? "warn" : undefined}
            />
            <Kpi label="Root risk" value={num(graph.riskScore)} sub={graph.riskLevel} />
            <Kpi label="Graph size" value={`${num(graph.totals.nodeCount)} / ${num(graph.totals.edgeCount)}`} sub="nodes / edges" />
          </KpiRow>

          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: "graph", label: "Graph" },
              { id: "table", label: "By hop" },
              { id: "edges", label: "Edges", count: graph.edges.length },
              { id: "timeline", label: "Timeline", count: graph.edges.length }
            ]}
          />

          {tab === "graph" ? (
            <Grid cols={2}>
              <Card title="Fund-flow graph" hint="Hops left to right. Select a node or an edge to see why it is here.">
                <GraphView
                  graph={graph}
                  onSelect={(n) => {
                    setSelected(n);
                    setSelectedEdge(null);
                  }}
                  onSelectEdge={(e) => {
                    setSelectedEdge(e);
                    setSelected(null);
                  }}
                  selectedId={selected?.id}
                  selectedEdgeId={selectedEdge?.id}
                  height={560}
                />
              </Card>

              <div className="stack">
                <Card title={selectedEdge ? "Why this edge is here" : selected ? "Selected address" : "Inspect"}>
                  {selectedEdge ? (
                    <EdgeEvidence edge={selectedEdge} graph={graph} />
                  ) : selected ? (
                    <NodeEvidence node={selected} graph={graph} />
                  ) : (
                    <p className="muted">
                      Click any node or edge in the graph. Edges that were inferred rather than observed state the reasoning
                      that produced them, so you can disagree with it.
                    </p>
                  )}
                </Card>

                {graph.reconciliation ? (
                  <Card title="Reconciliation">
                    <ReconciliationPanel graph={graph} />
                  </Card>
                ) : null}
              </div>
            </Grid>
          ) : null}

          {tab === "table" ? (
            <Card title="Addresses by hop distance">
              <GraphTable graph={graph} onSelect={setSelected} />
            </Card>
          ) : null}

          {tab === "edges" ? (
            <Card
              title="Edges"
              hint="One row per observed movement. Select a row for the reasoning behind it."
              flush
            >
              <table className="data dense">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Transaction</th>
                    <th>Time</th>
                    <th className="right">Observed</th>
                    <th className="right">Traced</th>
                    <th>Evidence</th>
                    <th>Movement</th>
                  </tr>
                </thead>
                <tbody>
                  {graph.edges.map((e) => {
                    const from = graph.nodes.find((n) => n.id === e.source);
                    const to = graph.nodes.find((n) => n.id === e.target);
                    return (
                      <tr
                        key={e.id}
                        className={selectedEdge?.id === e.id ? "selected" : ""}
                        onClick={() => setSelectedEdge(e)}
                      >
                        <td className="mono">{from ? shortId(from.address, 8, 6) : shortId(e.source, 8, 6)}</td>
                        <td className="mono">{to ? shortId(to.address, 8, 6) : shortId(e.target, 8, 6)}</td>
                        <td>
                          <Copyable value={e.txHash} />
                        </td>
                        <td>
                          {e.timestamp ? (
                            new Date(e.timestamp).toLocaleString()
                          ) : (
                            <span className="muted">unknown</span>
                          )}
                        </td>
                        <td className="right num">
                          {e.observedAmount} {e.asset}
                        </td>
                        <td className="right num">
                          {e.tracedAmount === null || e.tracedAmount === undefined ? (
                            <span className="muted">all</span>
                          ) : (
                            e.tracedAmount
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={
                              e.evidenceStatus === "confirmed"
                                ? "ok"
                                : e.evidenceStatus === "excluded"
                                  ? "neutral"
                                  : "warn"
                            }
                          >
                            {EVIDENCE_LABEL[e.evidenceStatus] ?? e.evidenceStatus}
                          </Badge>
                        </td>
                        <td className="muted small">{e.relationship.replace(/_/g, " ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          ) : null}

          {tab === "timeline" ? (
            <Card
              title="Timeline"
              hint="Every movement in chronological order. Movements with no timestamp are listed last rather than guessed at."
            >
              {timeline.length === 0 ? (
                <p className="muted">No movements to place on a timeline.</p>
              ) : (
                <ol className="timeline">
                  {timeline.map(({ edge, from, to }) => (
                    <li key={edge.id} className={`timeline-item ${selectedEdge?.id === edge.id ? "selected" : ""}`}>
                      <button className="timeline-btn" onClick={() => setSelectedEdge(edge)}>
                        <span className="timeline-time">
                          {edge.timestamp ? new Date(edge.timestamp).toLocaleString() : "timestamp unknown"}
                        </span>
                        <span className="mono">
                          {from ? shortId(from.address, 6, 4) : shortId(edge.source, 6, 4)} →{" "}
                          {to ? shortId(to.address, 6, 4) : shortId(edge.target, 6, 4)}
                        </span>
                        <span className="mono">
                          {edge.tracedAmount !== null && edge.tracedAmount !== undefined
                            ? `${edge.tracedAmount} of ${edge.observedAmount}`
                            : edge.observedAmount}{" "}
                          {edge.asset}
                        </span>
                        <Badge
                          tone={
                            edge.evidenceStatus === "confirmed" ? "ok" : edge.evidenceStatus === "excluded" ? "neutral" : "warn"
                          }
                        >
                          {EVIDENCE_LABEL[edge.evidenceStatus] ?? edge.evidenceStatus}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          ) : null}

          <Grid cols={2}>
            <Card title="Root">
              <dl className="kv">
                <dt>Address</dt>
                <dd>
                  <Copyable value={graph.root} display={graph.root} />
                </dd>
                <dt>Chain</dt>
                <dd>
                  <ChainBadge chain={graph.chain} />
                </dd>
                <dt>Quantity traced</dt>
                <dd>
                  {graph.amountToTrace ? (
                    <>
                      {graph.amountToTrace} {graph.asset}
                      {graph.method ? (
                        <>
                          {" "}
                          <Badge tone="neutral">{graph.method}</Badge>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">None — all observed movement</span>
                  )}
                </dd>
                <dt>Risk</dt>
                <dd>
                  <RiskBadge level={graph.riskLevel} score={graph.riskScore} />
                </dd>
                <dt>Generated</dt>
                <dd>{new Date(graph.generatedAt).toLocaleString()}</dd>
                {graph.demo ? (
                  <>
                    <dt>Data source</dt>
                    <dd>
                      <Badge tone="warn">Simulated — synthetic data</Badge>
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>

            <Card title="Selection">
              {selectedEdge ? (
                <p className="muted">
                  An edge is selected. Its reasoning is shown beside the graph — switch to the Graph tab to read it in full.
                </p>
              ) : selected ? (
                <dl className="kv">
                  <dt>Address</dt>
                  <dd>
                    <Copyable value={selected.canonicalAddress ?? selected.address} />
                  </dd>
                  <dt>Label</dt>
                  <dd>{selected.label ?? selected.kind}</dd>
                  <dt>Risk</dt>
                  <dd>
                    <RiskBadge level={selected.riskLevel} score={selected.riskScore} />
                  </dd>
                  <dt>Hop</dt>
                  <dd>{selected.hopDistance}</dd>
                  <dt>Traced quantity here</dt>
                  <dd>
                    {selected.tracedAmount !== null && selected.tracedAmount !== undefined
                      ? `${selected.tracedAmount} ${graph.asset ?? ""}`
                      : "—"}
                  </dd>
                  <dt>Transactions</dt>
                  <dd>{num(selected.txCount)}</dd>
                </dl>
              ) : (
                <p className="muted">Select a node or an edge in the graph to inspect it.</p>
              )}
            </Card>
          </Grid>
        </>
      ) : null}
    </>
  );
}
