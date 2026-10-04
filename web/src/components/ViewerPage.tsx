import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "../lib/hooks";
import { GraphTable, GraphView, EVIDENCE_LABEL } from "./GraphView";
import { EdgeEvidence } from "./EvidencePanel";
import { Badge, CaseStatusBadge, Copyable, EmptyState, ErrorState, RiskBadge, Tabs } from "./ui";
import { dateTime, num, shortId, usd } from "../lib/format";
import type { CaseGraphResponse, GraphEdge, GraphNode } from "../types";

/**
 * Graph workspace for one case.
 *
 * The graph is a persisted trace, not a live crawl: the tracer writes a trace
 * row and this page renders that snapshot, so two people looking at the same
 * case always see the same graph even if a new trace is running. Switching
 * between previous runs is an explicit choice rather than an automatic jump.
 *
 * Selection drives the detail panel and the AI context, so the two can never
 * disagree about what is being examined.
 */

type Mode = "graph" | "hops";

interface Selection {
  type: "node" | "edge";
  id: string;
}

/**
 * `caseId` is optional so the same component works both as a route (where it
 * comes from the URL) and embedded in the case workspace, rather than
 * duplicating the panel. `refreshKey` re-reads the graph after a proposal is
 * applied, since applying findings can add a new trace.
 */
export function ViewerPage({ caseId: caseIdProp, refreshKey = 0 }: { caseId?: string; refreshKey?: number } = {}): JSX.Element {
  const params = useParams();
  const caseId = caseIdProp ?? params.caseId ?? "";
  const [search, setSearch] = useSearchParams();
  const [mode, setMode] = useState<Mode>("graph");
  const [selection, setSelection] = useState<Selection | null>(null);

  const traceId = search.get("trace") ?? undefined;
  const url = caseId
    ? `/api/chain/cases/${caseId}/graph${traceId ? `?traceId=${encodeURIComponent(traceId)}` : ""}`
    : null;

  const { data, loading, error, reload } = useQuery<CaseGraphResponse>(url, [caseId, traceId, refreshKey]);

  const graph = data?.graph ?? null;
  const nodesById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const edgesById = useMemo(() => new Map((graph?.edges ?? []).map((e) => [e.id, e])), [graph]);

  const selectRun = useCallback(
    (id: string) => {
      const next = new URLSearchParams(search);
      next.set("trace", id);
      setSearch(next, { replace: true });
      // The selection refers to nodes and edges of the previous run, so it
      // cannot survive the switch.
      setSelection(null);
    },
    [search, setSearch]
  );

  // A selection that no longer exists in the rendered graph would leave the
  // detail panel describing something invisible.
  useEffect(() => {
    if (!selection || !graph) return;
    const present = selection.type === "node" ? nodesById.has(selection.id) : edgesById.has(selection.id);
    if (!present) setSelection(null);
  }, [graph, selection, nodesById, edgesById]);

  const selectNode = useCallback((n: GraphNode) => {
    setSelection({ type: "node", id: n.id });
  }, []);

  const selectEdge = useCallback((e: GraphEdge) => {
    setSelection({ type: "edge", id: e.id });
  }, []);

  const selectedNode = selection?.type === "node" ? nodesById.get(selection.id) ?? null : null;
  const selectedEdge = selection?.type === "edge" ? edgesById.get(selection.id) ?? null : null;
  const run = data?.runs.find((r) => r.id === data.selectedTraceId) ?? null;

  const openTransactions = useMemo(
    () => graph?.edges.filter((e) => (selectedNode ? e.source === selectedNode.id || e.target === selectedNode.id : false)) ?? [],
    [graph, selectedNode]
  );

  return (
    <div className="viewer">
      <header className="viewer-head">
        <div className="viewer-head-main">
          <h2>Fund-flow graph</h2>
          {data ? <CaseStatusBadge status={data.status} /> : null}
        </div>

        {data && data.runs.length > 0 ? (
          <div className="viewer-runs">
            <label className="field sm">
              <span>Trace run</span>
              <select value={data.selectedTraceId ?? ""} onChange={(e) => selectRun(e.target.value)}>
                {data.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {dateTime(r.createdAt)} · {r.chain} · {r.nodeCount} addr / {r.edgeCount} tx
                    {r.id === data.runs[0]?.id ? " (latest)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </header>

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {!error && !loading && (!graph || graph.nodes.length === 0) ? (
        <EmptyState action={<ReloadButton onClick={reload} />}>
          <p>No trace has been run for this case yet.</p>
          <p className="muted">
            The graph is built from a completed trace. Run one from the Analysis panel and it will appear here.
          </p>
        </EmptyState>
      ) : null}

      {graph && graph.nodes.length > 0 ? (
        <div className="viewer-body">
          <div className="viewer-main">
            <Tabs<Mode>
              tabs={[
                { id: "graph", label: "Graph" },
                { id: "hops", label: "By hop" }
              ]}
              active={mode}
              onChange={setMode}
            />

            {mode === "graph" ? (
              <GraphView
                graph={graph}
                onSelect={selectNode}
                onSelectEdge={selectEdge}
                selectedId={selectedNode?.id ?? null}
                selectedEdgeId={selectedEdge?.id ?? null}
                height={560}
              />
            ) : (
              <GraphTable graph={graph} onSelect={selectNode} />
            )}

            {run ? (
              <div className="viewer-foot">
                <span className="muted">
                  Traced from <Copyable value={run.rootAddress} display={shortId(run.rootAddress, 12, 8)} /> by{" "}
                  {run.createdBy ?? "system"} on {dateTime(run.createdAt)}
                </span>
                <span className="muted">
                  {num(run.nodeCount)} addresses · {num(run.edgeCount)} transfers · {usd(run.totalUsd)} moved
                </span>
              </div>
            ) : null}
          </div>

          <aside className="viewer-detail" aria-label="Selection detail">
            {selectedNode ? (
              <NodeDetail node={selectedNode} edges={openTransactions} onPickEdge={selectEdge} />
            ) : selectedEdge && graph ? (
              <EdgeEvidence edge={selectedEdge} graph={graph} />
            ) : (
              <div className="viewer-detail-empty">
                <p className="muted">Select an address or a transfer.</p>
                <p className="muted">
                  An address shows its own risk and the transfers touching it. A transfer shows the transaction behind
                  the arrow, how much of the investigated quantity it carried, and why we think so.
                </p>
              </div>
            )}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function ReloadButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button className="btn ghost" onClick={onClick} type="button">
      Re-check
    </button>
  );
}

/* ------------------------------------------------------------- node detail */

function NodeDetail({
  node,
  edges,
  onPickEdge
}: {
  node: GraphNode;
  edges: GraphEdge[];
  onPickEdge: (e: GraphEdge) => void;
}): JSX.Element {
  const inEdges = edges.filter((e) => e.target === node.id);
  const outEdges = edges.filter((e) => e.source === node.id);

  return (
    <>
      <header className="viewer-detail-head">
        <div className="viewer-detail-title">
          <span className="mono">{shortId(node.address, 10, 8)}</span>
          {node.hopDistance === 0 ? <Badge tone="info">root</Badge> : null}
        </div>
        <div className="viewer-detail-sub">
          {node.label ?? node.kind} · {node.chain} · hop {node.hopDistance}
        </div>
      </header>

      <div className="viewer-detail-metrics">
        <Metric label="Risk" value={<RiskBadge level={node.riskLevel} score={node.riskScore} />} />
        <Metric label="Received" value={usd(node.inVolumeUsd)} />
        <Metric label="Sent" value={usd(node.outVolumeUsd)} />
        <Metric label="Transactions" value={num(node.txCount)} />
      </div>

      <dl className="viewer-kv">
        <dt>Address</dt>
        <dd>
          <Copyable value={node.address} display={node.address} />
        </dd>
        {node.firstSeen ? (
          <>
            <dt>First seen</dt>
            <dd>{dateTime(node.firstSeen)}</dd>
          </>
        ) : null}
        {node.lastSeen ? (
          <>
            <dt>Last seen</dt>
            <dd>{dateTime(node.lastSeen)}</dd>
          </>
        ) : null}
      </dl>

      <EdgeList title="Received from" edges={inEdges} onPickEdge={onPickEdge} />
      <EdgeList title="Sent to" edges={outEdges} onPickEdge={onPickEdge} />
    </>
  );
}

function Metric({ label, value }: { label: string; value: JSX.Element | string }): JSX.Element {
  return (
    <div className="viewer-metric">
      <span className="viewer-metric-label">{label}</span>
      <span className="viewer-metric-value">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------- edge list */

function EdgeList({ title, edges, onPickEdge }: { title: string; edges: GraphEdge[]; onPickEdge: (e: GraphEdge) => void }): JSX.Element | null {
  if (edges.length === 0) return null;
  const total = edges.reduce((sum, e) => sum + (e.valueUsd ?? 0), 0);

  return (
    <section className="viewer-edges">
      <h4>
        {title}
        <span className="muted">
          {" "}
          · {edges.length} · {usd(total)}
        </span>
      </h4>
      <ul>
        {edges.map((e) => (
          <li key={e.id}>
            <button className="viewer-edge-row" type="button" onClick={() => onPickEdge(e)}>
              <span className="mono">{shortId(e.txHash, 10, 6)}</span>
              <span className="num">{e.valueUsd !== null && e.valueUsd > 0 ? usd(e.valueUsd) : "no USD value"}</span>
              <span className="muted">{e.timestamp ? dateTime(e.timestamp) : "no time"}</span>
              {/* Evidence status belongs in the list, not only in the detail pane:
                  otherwise the rows read as equally certain. */}
              <Badge tone={e.evidenceStatus === "confirmed" ? "ok" : e.evidenceStatus === "excluded" ? "neutral" : "warn"}>
                {EVIDENCE_LABEL[e.evidenceStatus] ?? e.evidenceStatus}
              </Badge>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
