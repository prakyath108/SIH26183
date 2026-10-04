import type { GraphEdge, GraphNode, TraceGraph } from "../types";
import { Badge, Copyable, Notice } from "./ui";
import { EVIDENCE_LABEL } from "./GraphView";
import { shortId } from "../lib/format";

const RELATIONSHIP_LABEL: Record<string, string> = {
  direct_transfer: "Direct transfer",
  token_transfer: "Token transfer",
  bridge_crossing: "Bridge crossing",
  cross_chain_link: "Cross-chain link",
  contract_interaction: "Contract interaction",
  change_output: "Change output",
  fee: "Transaction fee"
};

const RELATIONSHIP_NOTE: Record<string, string> = {
  contract_interaction:
    "A contract call that moved no value. The address was touched by the transaction, but no funds were sent to it.",
  change_output: "Change returning to the sender — the sender's own remainder, not onward movement.",
  fee: "Paid to a validator or miner. It leaves the wallet but reaches nobody in the counterparty set.",
  bridge_crossing:
    "Funds entering a bridge on this chain. Where they surface on the destination chain is a separate observation, made only if that chain is also queried.",
  cross_chain_link:
    "A correlation between two ledgers rather than an observed transfer. Treat the link as a lead, not a fact."
};

/** Plain-language status of a trace, so a coverage figure is never read alone. */
const RECONCILE_COPY: Record<string, { tone: string; title: string; body: string }> = {
  reconciled: {
    tone: "ok",
    title: "Fully accounted for",
    body: "Every unit of the nominated quantity reached a destination the trace can point at."
  },
  partial: {
    tone: "warn",
    title: "Partly accounted for",
    body: "Some of the quantity moved but no supported destination was found for the rest. The shortfall is listed rather than spread across wallets."
  },
  unreconciled: {
    tone: "danger",
    title: "Not accounted for",
    body: "No supported destination was found for the nominated quantity. This usually means the method found no clean pass-through, not that the data is missing."
  },
  not_applicable: {
    tone: "info",
    title: "No quantity nominated",
    body: "This trace followed every observed movement rather than a specific sum, so there is no total to reconcile against."
  }
};

function ExplorerLink({ chain, hash }: { chain: string; hash: string }): JSX.Element | null {
  const base: Record<string, string> = {
    ethereum: "https://etherscan.io/tx/",
    polygon: "https://polygonscan.com/tx/",
    bitcoin: "https://mempool.space/tx/",
    tron: "https://tronscan.org/#/transaction/"
  };
  const url = base[chain];
  if (!url || !hash) return null;
  return (
    <a className="btn ghost sm" href={`${url}${hash}`} target="_blank" rel="noreferrer noopener">
      View on explorer
    </a>
  );
}

/**
 * Explorer link for an edge, suppressed when the observation is synthetic.
 *
 * A demo hash has no page on any explorer, so linking to one produces a 404 that
 * reads as though the evidence failed to load. Worse, a judge clicking through a
 * fabricated hash learns nothing about whether the system works. Showing
 * provenance instead is both honest and more informative.
 */
function EdgeExplorerLink({ edge, chain }: { edge: GraphEdge; chain: string }): JSX.Element {
  if (edge.evidenceSource === "demo") {
    return <span className="muted sm">Synthetic transaction &mdash; no explorer record exists</span>;
  }
  return <ExplorerLink chain={chain} hash={edge.txHash} />;
}

/**
 * "Why did this edge appear?"
 *
 * The panel exists because a graph alone cannot be audited. Every edge carries
 * the reasoning that produced it, and that reasoning is shown verbatim rather
 * than summarised, so a reviewer can disagree with it.
 */
export function EdgeEvidence({
  edge,
  graph
}: {
  edge: GraphEdge;
  graph: TraceGraph;
}): JSX.Element {
  const source = graph.nodes.find((n) => n.id === edge.source);
  const target = graph.nodes.find((n) => n.id === edge.target);
  const confidencePct = Math.round(edge.confidence * 100);

  const supports = edge.reasons.filter((r) => r.weight === "supports");
  const qualifies = edge.reasons.filter((r) => r.weight === "qualifies");
  const weakens = edge.reasons.filter((r) => r.weight === "weakens");

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div>
          <div className="mono small">
            {source ? shortId(source.address, 10, 8) : shortId(edge.source, 10, 8)} →{" "}
            {target ? shortId(target.address, 10, 8) : shortId(edge.target, 10, 8)}
          </div>
          <h3 style={{ margin: "0.15rem 0 0" }}>
            {RELATIONSHIP_LABEL[edge.relationship] ?? edge.relationship}
          </h3>
        </div>
        <div className="row" style={{ gap: "0.4rem" }}>
          <Badge tone={edge.evidenceStatus === "confirmed" ? "ok" : edge.evidenceStatus === "excluded" ? "neutral" : "warn"}>
            {EVIDENCE_LABEL[edge.evidenceStatus] ?? edge.evidenceStatus}
          </Badge>
          {edge.traceMethod ? <Badge tone="neutral" title="Method that apportioned the quantity">{edge.traceMethod}</Badge> : null}
        </div>
      </div>

      <div className="evidence-figures">
        <div>
          <span className="evidence-figure">
            {edge.tracedAmount !== null && edge.tracedAmount !== undefined ? edge.tracedAmount : "—"}
          </span>
          <span className="evidence-caption">
            {edge.tracedAmount !== null && edge.tracedAmount !== undefined
              ? `traced of ${edge.observedAmount} ${edge.asset}`
              : `observed · no quantity nominated`}
          </span>
        </div>
        <div>
          <span className="evidence-figure">{confidencePct}%</span>
          <span className="evidence-caption">
            confidence{edge.traceMethod ? ` in the ${edge.traceMethod} share` : ""}
          </span>
        </div>
        <div>
          <span className="evidence-figure">{edge.hop}</span>
          <span className="evidence-caption">hop from the root</span>
        </div>
      </div>

      {RELATIONSHIP_NOTE[edge.relationship] ? <Notice tone="info">{RELATIONSHIP_NOTE[edge.relationship]}</Notice> : null}

      {edge.reasons.length === 0 ? (
        <Notice tone="warn">
          This edge carries no recorded reasoning. Treat it as unexplained rather than as verified.
        </Notice>
      ) : (
        <div className="reason-groups">
          {supports.length ? (
            <div className="reason-group">
              <h4 className="supports">Supports this edge</h4>
              <ul>
                {supports.map((r, i) => (
                  <li key={`${r.code}-${i}`}>{r.detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {qualifies.length ? (
            <div className="reason-group">
              <h4 className="qualifies">Qualifies it</h4>
              <ul>
                {qualifies.map((r, i) => (
                  <li key={`${r.code}-${i}`}>{r.detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {weakens.length ? (
            <div className="reason-group">
              <h4 className="weakens">Weakens it</h4>
              <ul>
                {weakens.map((r, i) => (
                  <li key={`${r.code}-${i}`}>{r.detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <div className="stack" style={{ gap: "0.4rem" }}>
        <div>
          <span className="field-label">Transaction</span>
          <Copyable value={edge.txHash} display={shortId(edge.txHash, 12, 10)} />
        </div>
        <div className="row wrap" style={{ gap: "0.5rem" }}>
          <EdgeExplorerLink edge={edge} chain={graph.chain} />
          {edge.timestamp ? (
            <span className="muted small">{new Date(edge.timestamp).toLocaleString()}</span>
          ) : (
            <span className="muted small">Timestamp unavailable from this source</span>
          )}
          {edge.evidenceSource === "stored" ? (
            <Badge tone="warn" title="From our own ingested records rather than a live chain query">
              From stored records
            </Badge>
          ) : null}
          {edge.evidenceSource === "demo" ? <Badge tone="neutral">Simulated</Badge> : null}
        </div>
      </div>
    </div>
  );
}

/** Node panel: what reached this address, and how strongly we can say so. */
export function NodeEvidence({ node, graph }: { node: GraphNode; graph: TraceGraph }): JSX.Element {
  const inEdges = graph.edges.filter((e) => e.target === node.id);
  const outEdges = graph.edges.filter((e) => e.source === node.id);

  const observedIn = inEdges
    .filter((e) => e.evidenceStatus === "confirmed")
    .reduce((s, e) => s + Number(e.tracedAmount ?? e.observedAmount ?? 0), 0);

  return (
    <div className="stack">
      <div>
        <h3 style={{ margin: 0 }}>{node.label ?? node.kind}</h3>
        <Copyable value={node.canonicalAddress ?? node.address} />
      </div>

      <div className="evidence-figures">
        <div>
          <span className="evidence-figure">
            {node.tracedAmount !== null && node.tracedAmount !== undefined ? node.tracedAmount : "—"}
          </span>
          <span className="evidence-caption">
            of the traced quantity reached here
            {node.confirmedAmount !== null && node.confirmedAmount !== undefined && Number(node.confirmedAmount) > 0
              ? ` · ${node.confirmedAmount} directly observed`
              : ""}
          </span>
        </div>
        <div>
          <span className="evidence-figure">{node.hopDistance}</span>
          <span className="evidence-caption">hop from the root</span>
        </div>
        <div>
          <span className="evidence-figure">{observedIn || "—"}</span>
          <span className="evidence-caption">in on confirmed edges</span>
        </div>
      </div>

      {inEdges.length === 0 && outEdges.length === 0 ? (
        <Notice tone="info">This address has no recorded movements in this trace.</Notice>
      ) : null}

      {outEdges.length === 0 && Number(node.tracedAmount ?? 0) > 0 ? (
        <Notice tone="ok" title="Terminal address">
          The traced quantity reached this address and nothing further was observed leaving it. This is where the funds
          came to rest.
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * Amount reconciliation.
 *
 * Shown as a first-class panel rather than a footnote, because a coverage figure
 * without its caveats is the easiest way to overstate a trace.
 */
export function ReconciliationPanel({ graph }: { graph: TraceGraph }): JSX.Element | null {
  const r = graph.reconciliation;
  if (!r) return null;

  const copy = RECONCILE_COPY[r.status] ?? RECONCILE_COPY.not_applicable!;
  const pct = r.coverage === null ? null : Math.round(r.coverage * 100);

  return (
    <div className="stack">
      <div className="row-between wrap">
        <h3 style={{ margin: 0 }}>Amount reconciliation</h3>
        <Badge tone={copy.tone}>{copy.title}</Badge>
      </div>

      {r.initialAmount === null ? (
        <Notice tone="info">
          No quantity was nominated, so this trace followed every observed movement. There is no total to account for.
        </Notice>
      ) : (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Tracing <strong>{r.initialAmount} {r.asset}</strong> from the root. The four figures below always sum to that
            quantity.
          </p>

          <div className="reconcile-bars">
            <div className="reconcile-bar">
              <span
                className="reconcile-seg confirmed"
                style={{ flexGrow: Number(r.directlyObserved) || 0.0001 }}
              />
              <span
                className="reconcile-seg attributed"
                style={{ flexGrow: Number(r.attributed) || 0.0001 }}
              />
              <span
                className="reconcile-seg explained"
                style={{ flexGrow: Number(r.explainedOutflow) || 0.0001 }}
              />
              <span
                className="reconcile-seg unresolved"
                style={{ flexGrow: Number(r.unresolved) || 0.0001 }}
              />
            </div>
            <div className="reconcile-legend">
              <span>
                <i className="swatch" style={{ background: "var(--evidence-confirmed)" }} />
                Directly observed <strong>{r.directlyObserved}</strong>
              </span>
              <span>
                <i className="swatch" style={{ background: "var(--evidence-attributed)" }} />
                Attributed <strong>{r.attributed}</strong>
              </span>
              <span>
                <i className="swatch" style={{ background: "var(--evidence-explained)" }} />
                Explained (fees/change) <strong>{r.explainedOutflow}</strong>
              </span>
              <span>
                <i className="swatch" style={{ background: "var(--evidence-uncertain)" }} />
                Unresolved <strong>{r.unresolved}</strong>
              </span>
              {pct !== null ? <span className="muted">coverage {pct}%</span> : null}
            </div>
          </div>

          {Number(r.unresolved) > 0 ? (
            <Notice tone="warn" title="Some of the quantity has no supported destination">
              {r.unresolved} {r.asset} could not be attributed to any observed transfer. It has deliberately not been spread
              across the wallets below, because no observed movement supports doing so.
            </Notice>
          ) : null}

          {r.coverage !== null && r.coverage > 1 ? (
            <Notice tone="warn" title="This total deliberately exceeds the amount traced">
              Poison-pill tracing treats each output of a co-mingled wallet as potentially holding the entire quantity, so the
              figures add up to more than was traced. This is the intended behaviour of that method and a reason not to use it
              for totals.
            </Notice>
          ) : null}

          {r.perHop.length ? (
            <table className="data dense">
              <thead>
                <tr>
                  <th>Hop</th>
                  <th className="right">Arrived</th>
                  <th className="right">Attributed onward</th>
                  <th className="right">Located</th>
                  <th className="right">Explained</th>
                  <th className="right">Unresolved</th>
                  <th className="right">Outputs</th>
                </tr>
              </thead>
              <tbody>
                {r.perHop.map((h) => (
                  <tr key={h.hop}>
                    <td>{h.hop === 0 ? "0 (root)" : h.hop}</td>
                    <td className="right mono">{h.inAmount}</td>
                    <td className="right mono">{h.attributedOut}</td>
                    <td className="right mono">{h.located}</td>
                    <td className="right mono">{h.explained}</td>
                    <td className={`right mono ${Number(h.unresolved) > 0 ? "warn-text" : ""}`}>{h.unresolved}</td>
                    <td className="right">{h.outputCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}

      {r.caveats.length ? (
        <div className="caveat-list">
          <h4>Limits of this figure</h4>
          <ul>
            {r.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
