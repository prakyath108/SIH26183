import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode, TraceGraph } from "../types";
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph, type LayoutNode } from "../lib/normalize";
import { RISK_TONE, chainSymbol, shortId, usd } from "../lib/format";
import {
  SPEEDS,
  assignAnchors,
  bezierAt,
  edgeGeometry,
  edgeReveal,
  nodeReveal,
  particleCount,
  particleOffsets,
  useTracePlayback,
  type Speed
} from "../lib/tracePlayback";
import { Badge, Notice } from "./ui";

/**
 * Fund-flow graph.
 *
 * Drawn as plain SVG rather than a graph library: the tracer emits a bounded,
 * hop-layered DAG, so a full force simulation would only add jitter and a
 * dependency. The layering is deterministic, which means a re-render never
 * reshuffles a graph an analyst is mid-way through describing.
 *
 * Zoom and pan are a single `translate`+`scale` on one wrapper `<g>`, with the
 * viewBox pinned to the measured pixel size of the container. Scaling the
 * viewBox instead would make the zoom factor depend on the container width and
 * would shrink the graph rather than magnifying it.
 *
 * The reveal is driven by one scalar clock (`useTracePlayback`) rather than per
 * element CSS animations. A CSS keyframe per hop cannot be paused halfway,
 * scrubbed backwards, or made to agree with the travelling funds on the edges.
 */

const TONE_FILL: Record<string, string> = {
  critical: "var(--risk-critical-bg)",
  high: "var(--risk-high-bg)",
  medium: "var(--risk-medium-bg)",
  low: "var(--risk-low-bg)",
  unrated: "var(--surface-2)"
};

/** Saturated accent per risk level, for the bar down the side of each node. */
const RISK_COLOR: Record<string, string> = {
  critical: "var(--risk-critical)",
  high: "var(--risk-high)",
  medium: "var(--risk-medium)",
  low: "var(--risk-low)",
  unrated: "var(--muted-2)"
};

/**
 * What the graph is colouring.
 *
 * The modes exist because a single picture cannot honestly answer both "where
 * did the money go" and "how much of this is actually observed". Forcing one
 * view to do both is how a derived pairing ends up looking like a payment.
 */
export type GraphMode = "flow" | "evidence" | "forensic";

const MODES: { value: GraphMode; label: string; hint: string }[] = [
  {
    value: "flow",
    label: "Traced funds",
    hint: "Edge width and label show the portion of the nominated quantity each transfer carried."
  },
  {
    value: "evidence",
    label: "Evidence",
    hint: "Edge colour shows how strong the evidence is. Only green is directly observed."
  },
  {
    value: "forensic",
    label: "Forensic",
    hint: "Edge colour shows what kind of movement it is: transfer, token, bridge, change, fee or contract call."
  }
];

/** Stroke colour per evidence status. Only `confirmed` is fully saturated. */
const EVIDENCE_STROKE: Record<string, string> = {
  confirmed: "var(--evidence-confirmed)",
  derived: "var(--evidence-derived)",
  attributed: "var(--evidence-attributed)",
  inferred: "var(--evidence-inferred)",
  uncertain: "var(--evidence-uncertain)",
  excluded: "var(--evidence-excluded)"
};

/** Stroke colour per relationship, for the forensic view. */
const RELATIONSHIP_STROKE: Record<string, string> = {
  direct_transfer: "var(--evidence-confirmed)",
  token_transfer: "var(--evidence-derived)",
  bridge_crossing: "var(--evidence-attributed)",
  cross_chain_link: "var(--evidence-inferred)",
  contract_interaction: "var(--evidence-uncertain)",
  change_output: "var(--evidence-excluded)",
  fee: "var(--evidence-excluded)"
};

/** Short, honest wording for an evidence status. */
export const EVIDENCE_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  derived: "Derived",
  attributed: "Attributed",
  inferred: "Inferred",
  uncertain: "Uncertain",
  excluded: "Excluded"
};

const RELATIONSHIP_LABEL: Record<string, string> = {
  direct_transfer: "Direct transfer",
  token_transfer: "Token transfer",
  bridge_crossing: "Bridge crossing",
  cross_chain_link: "Cross-chain link",
  contract_interaction: "Contract interaction",
  change_output: "Change output",
  fee: "Transaction fee"
};

/** Explains an evidence status in the investigator's terms, for the legend. */
function evidenceTooltip(status: string): string {
  switch (status) {
    case "confirmed":
      return "Recorded by the chain, and the amount matches exactly.";
    case "derived":
      return "Computed by our own normaliser from transaction inputs and outputs. Not a transfer the chain recorded between these addresses.";
    case "attributed":
      return "The destination was reached by apportioning the nominated quantity across a split.";
    case "inferred":
      return "Reasoned across ledgers rather than observed on either.";
    case "uncertain":
      return "The underlying observation is itself unreliable.";
    case "excluded":
      return "Carries none of the investigated quantity. Drawn as context only.";
    default:
      return "";
  }
}

/** Amount on an edge, preferring the traced quantity when one is in play. */
function edgeAmountLabel(e: GraphEdge): string | null {
  const traced = e.tracedAmount;
  if (traced !== null && traced !== undefined) {
    if (Number(traced) <= 0) return null;
    // Both figures shown whenever they differ, because a 3-unit share of a
    // 60-unit transfer is the distinction the whole trace turns on.
    return Number(traced) === Number(e.observedAmount)
      ? `${traced} ${e.asset}`
      : `${traced} of ${e.observedAmount} ${e.asset}`;
  }
  if (e.valueUsd !== null && e.valueUsd > 0) return usd(e.valueUsd);
  return e.valueNative ? `${e.valueNative} ${e.asset}` : null;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const FIT_PADDING = 24;

export function GraphView({
  graph,
  onSelect,
  onSelectEdge,
  selectedId,
  selectedEdgeId,
  height = 520
}: {
  graph: TraceGraph;
  onSelect?: (node: GraphNode) => void;
  onSelectEdge?: (edge: GraphEdge) => void;
  selectedId?: string | null;
  selectedEdgeId?: string | null;
  height?: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: height });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const dragging = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [mode, setMode] = useState<GraphMode>("flow");

  // Two GraphViews can be mounted at once (case detail plus the fund-flow tab),
  // so SVG defs ids are scoped per instance rather than left global.
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9]/g, "");

  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const playback = useTracePlayback(graph);
  const { t, total, maxHop, phase, frac, settled, playing, speed } = playback;

  // Edge paths are fixed by the layout, so they are computed once per graph
  // rather than rebuilt on every animation frame.
  const geoms = useMemo(() => {
    // Fan the edges out along each node face, otherwise every edge meeting at a
    // hub shares one anchor point and the bundle reads as a single thick stripe.
    const outAnchor = assignAnchors(graph.edges, byId, (e) => e.source, (e) => e.target);
    const inAnchor = assignAnchors(graph.edges, byId, (e) => e.target, (e) => e.source);
    const m = new Map<string, ReturnType<typeof edgeGeometry>>();
    for (const e of graph.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      m.set(e.id, edgeGeometry(a, b, outAnchor.get(e.id) ?? 0, inAnchor.get(e.id) ?? 0));
    }
    return m;
  }, [graph.edges, byId]);

  // Left edge of hop 0, used to place the highlight behind the active column.
  const originX = useMemo(() => Math.min(...layout.nodes.map((n) => n.x)), [layout]);

  // Re-fit only when the graph itself changes, so switching mode cannot yank
  // the view out from under someone who has zoomed in to read an edge.
  useEffect(() => {
    setMode(graph.amountToTrace ? "flow" : "evidence");
  }, [graph.amountToTrace]);

  // Measure the container so the viewBox is 1:1 with CSS pixels. Without this
  // the SVG scales itself to fit and a small graph ends up drawn at an
  // arbitrary size relative to the panel.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Centre the graph and scale it to fill the panel. */
  const fit = useCallback(() => {
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((size.w - FIT_PADDING * 2) / layout.width, (size.h - FIT_PADDING * 2) / layout.height))
    );
    setView({
      zoom,
      x: (size.w - layout.width * zoom) / 2,
      y: (size.h - layout.height * zoom) / 2
    });
  }, [size.w, size.h, layout.width, layout.height]);

  // Re-fit whenever the graph or the panel size changes, but leave a manual
  // zoom/pan alone when only the selection changes.
  const fitKey = `${size.w}x${size.h}:${layout.width}x${layout.height}`;
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;
    fit();
  }, [fitKey, fit]);

  const zoomBy = (factor: number) =>
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(v.zoom * factor).toFixed(3)));
      // Keep the panel centre fixed while zooming.
      const cx = size.w / 2;
      const cy = size.h / 2;
      const k = zoom / v.zoom;
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  const activeColumnX = originX + phase * layout.colWidth;
  const canPlay = maxHop > 0 || graph.edges.length > 0;
  const percent = Math.round((t / total) * 100);

  return (
    <div className="graph-wrap">
      {graph.demo ? (
        <div className="demo-banner" role="status">
          <strong>SIMULATED DATA</strong>
          <span>
            Every address, transaction, amount and score below is synthetic and corresponds to no real blockchain activity.
          </span>
        </div>
      ) : null}

      <div className="graph-toolbar">
        <div className="graph-modes" role="group" aria-label="Graph colouring">
          {MODES.map((m) => (
            <button
              key={m.value}
              className={`mode-btn ${mode === m.value ? "active" : ""}`}
              onClick={() => setMode(m.value)}
              title={m.hint}
              aria-pressed={mode === m.value}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="graph-legend">
          {mode === "evidence"
            ? Object.keys(EVIDENCE_STROKE).map((s) => (
                <span className="legend-item" key={s} title={evidenceTooltip(s)}>
                  <i className="swatch" style={{ background: EVIDENCE_STROKE[s] }} /> {EVIDENCE_LABEL[s]}
                </span>
              ))
            : null}
          {mode === "forensic"
            ? Object.keys(RELATIONSHIP_STROKE).map((r) => (
                <span className="legend-item" key={r}>
                  <i className="swatch" style={{ background: RELATIONSHIP_STROKE[r] }} /> {RELATIONSHIP_LABEL[r]}
                </span>
              ))
            : null}
          {mode === "flow" ? (
            <>
              <span className="legend-item">
                <i className="swatch edge-swatch" style={{ width: "16px", height: "2px", background: "var(--edge)" }} />
                Width ≈ traced quantity
              </span>
              <span className="legend-item">
                <i className="swatch edge-swatch" style={{ width: "16px", height: "0", borderTop: "2px dashed var(--evidence-derived)" }} />
                Dashed = not directly observed
              </span>
            </>
          ) : null}
          <span className="legend-sep" />
          {(["critical", "high", "medium", "low", "unrated"] as const).map((t) => (
            <span className="legend-item" key={t} title="Node fill shows the assessed risk of that address">
              <i className={`swatch ${t}`} /> {t === "unrated" ? "Unrated" : t[0]?.toUpperCase() + t.slice(1)}
            </span>
          ))}
          <span className="legend-sep" />
          <span className="legend-item">Hops left to right; root first</span>
        </div>

        <div className="graph-zoom">
          <button className="icon-btn" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
            −
          </button>
          <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
          <button className="icon-btn" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
            +
          </button>
          <button className="btn ghost sm" onClick={fit}>
            Fit
          </button>
          <label className="check" style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}>
            <input
              type="checkbox"
              checked={showEdgeLabels}
              onChange={(e) => setShowEdgeLabels(e.target.checked)}
            />
            <span>Edge amounts</span>
          </label>
        </div>
      </div>

      <div
        ref={canvasRef}
        className="graph-canvas"
        style={{ height }}
        onMouseDown={(e) => {
          // A drag starting on a node or a selectable edge is a click, not a pan.
          if ((e.target as Element).closest(".node, .edge.selectable")) return;
          dragging.current = { x: e.clientX, y: e.clientY, px: view.x, py: view.y };
        }}
        onMouseMove={(e) => {
          if (!dragging.current) return;
          setView((v) => ({
            ...v,
            x: dragging.current!.px + (e.clientX - dragging.current!.x),
            y: dragging.current!.py + (e.clientY - dragging.current!.y)
          }));
        }}
        onMouseUp={() => {
          dragging.current = null;
        }}
        onMouseLeave={() => {
          dragging.current = null;
        }}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 2) return;
          zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${size.w} ${size.h}`}
          role="img"
          aria-label={`Fund flow graph with ${graph.totals.nodeCount} nodes and ${graph.totals.edgeCount} edges`}
        >
          <defs>
            <marker
              id={`arrow-${uid}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              {/* context-stroke so the head takes the colour of the edge it
                  terminates. A fixed fill left every bright edge capped with a
                  dark teal arrowhead, which read as a break in the line. */}
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
            <filter id={`edge-glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g transform={`translate(${view.x.toFixed(2)},${view.y.toFixed(2)}) scale(${view.zoom})`}>
            {/* Column wash behind the hop currently being traced, so it is
                obvious which column the funds are leaving. */}
            {!settled && phase < maxHop ? (
              <rect
                className="hop-column"
                x={activeColumnX - 18}
                y={0}
                width={layout.colWidth + 18}
                height={layout.height}
              />
            ) : null}

            <g>
              {graph.edges.map((e) => {
                const g = geoms.get(e.id);
                if (!g) return null;

                const p = edgeReveal(e, phase, frac, settled);
                if (p <= 0) return null;

                const dim = selectedId && e.source !== selectedId && e.target !== selectedId;
                const isSelected = selectedEdgeId === e.id;

                // In flow mode the width tracks the traced quantity; with no
                // quantity nominated there is nothing to attribute, so it falls
                // back to the observed value rather than implying a share.
                const widthBasis =
                  mode === "flow" && e.tracedAmount !== null && e.tracedAmount !== undefined
                    ? Number(e.tracedAmount)
                    : Number(e.valueUsd ?? 0) || Number(e.observedAmount ?? 0);
                const strokeWidth = widthBasis > 0 ? Math.min(5, 1 + Math.log10(widthBasis + 1) / 2) : 1;

                const stroke =
                  mode === "evidence"
                    ? EVIDENCE_STROKE[e.evidenceStatus] ?? "var(--edge)"
                    : mode === "forensic"
                      ? RELATIONSHIP_STROKE[e.relationship] ?? "var(--edge)"
                      : EVIDENCE_STROKE[e.evidenceStatus] ?? "var(--edge)";

                // Only a confirmed edge is drawn as a solid line. A dashed line
                // is the visual claim "this was not directly observed", and it
                // survives whichever mode is active.
                const isConfirmed = e.evidenceStatus === "confirmed";
                const dash = isConfirmed ? undefined : mode === "evidence" ? "5 3" : "7 4";

                const edgeValue = edgeAmountLabel(e);
                const carriesNothing =
                  e.tracedAmount !== null && e.tracedAmount !== undefined && Number(e.tracedAmount) <= 0;

                // Funds in flight. Only while the edge is mid-draw: a settled
                // graph should be still, not permanently simmering.
                const dots = particleOffsets(p, particleCount(e.tracedAmount, Number(e.observedAmount ?? 0), strokeWidth));
                const dotR = Math.max(1.8, Math.min(3.4, strokeWidth * 0.8));

                // While funds are in flight the dash pattern encodes the reveal,
                // so the edge-type dashes only apply once it has landed. With
                // pathLength=1 both are expressed in 0-1 units and no DOM
                // measurement is needed to know how far to draw.
                const inFlight = p < 1;

                return (
                  <g
                    key={e.id}
                    className={`edge ${onSelectEdge ? "selectable" : ""} ${isSelected ? "selected" : ""} ${
                      carriesNothing ? "edge-excluded" : ""
                    }`}
                    opacity={dim ? 0.18 : carriesNothing ? 0.45 : 1}
                    onClick={onSelectEdge ? (ev) => { ev.stopPropagation(); onSelectEdge(e); } : undefined}
                    role={onSelectEdge ? "button" : undefined}
                    tabIndex={onSelectEdge ? 0 : undefined}
                    onKeyDown={
                      onSelectEdge
                        ? (ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              onSelectEdge(e);
                            }
                          }
                        : undefined
                    }
                  >
                    {/* Fat transparent stroke: the visible edge is 1-5px, which is
                        well below a comfortable pointer target. */}
                    {onSelectEdge ? (
                      <path d={g.d} className="edge-hit" strokeWidth={Math.max(14, strokeWidth + 10)} fill="none" />
                    ) : null}

                    {/* Undrawn track, so a partially traced edge reads as a route
                        still to be travelled rather than as a shorter edge. */}
                    {inFlight ? (
                      <path
                        d={g.d}
                        className="edge-rail"
                        pathLength={1}
                        strokeDasharray="1 1"
                        strokeDashoffset={1 - p}
                        stroke={stroke}
                      />
                    ) : null}

                    <path
                      d={g.d}
                      className="edge-path"
                      pathLength={1}
                      markerEnd={inFlight ? undefined : `url(#arrow-${uid})`}
                      strokeWidth={strokeWidth}
                      stroke={stroke}
                      strokeDasharray={inFlight ? "1 1" : dash}
                      strokeDashoffset={inFlight ? 1 - p : undefined}
                      filter={isConfirmed && !inFlight ? `url(#edge-glow-${uid})` : undefined}
                    />

                    {dots.map((q, i) => {
                      const pt = bezierAt(g, q);
                      return (
                        <circle
                          key={i}
                          className="fund-dot"
                          cx={pt.x}
                          cy={pt.y}
                          r={dotR}
                          fill={stroke}
                        />
                      );
                    })}

                    {showEdgeLabels && edgeValue && !dim && p > 0.9 ? (
                      <text
                        x={g.lx}
                        y={g.ly - 8}
                        className="edge-label"
                        textAnchor="middle"
                        dominantBaseline="alphabetic"
                        opacity={Math.min(1, (p - 0.9) / 0.1)}
                        style={{ pointerEvents: "none" }}
                      >
                        {edgeValue}
                      </text>
                    ) : null}
                    <title>
                      {[
                        `${e.source} → ${e.target}`,
                        `${edgeValue ?? "no amount recorded"}`,
                        `Evidence: ${EVIDENCE_LABEL[e.evidenceStatus] ?? e.evidenceStatus}${
                          e.traceMethod ? ` (${e.traceMethod})` : ""
                        } · confidence ${Math.round(e.confidence * 100)}%`,
                        `Movement: ${RELATIONSHIP_LABEL[e.relationship] ?? e.relationship}`,
                        `Observed on chain: ${e.observedAmount} ${e.asset}`,
                        e.tracedAmount !== null && e.tracedAmount !== undefined
                          ? `Traced quantity on this leg: ${e.tracedAmount} ${e.asset}`
                          : "No nominated quantity; showing all observed movement",
                        e.txHash,
                        e.timestamp ?? "timestamp unavailable",
                        ...e.reasons.map((r) => `• ${r.detail}`)
                      ].join("\n")}
                    </title>
                  </g>
                );
              })}
            </g>

            <g>
              {layout.nodes.map((n) => {
                const appear = nodeReveal(n, t, settled);
                if (appear <= 0) return null;

                const tone = RISK_TONE[n.riskLevel] ?? "unrated";
                const isRoot = n.hopDistance === 0;
                const isSelected = selectedId === n.id;
                const dim = selectedEdgeId ? !edgeTouches(n.id, selectedEdgeId, byId, graph) : false;
                // Arriving: still fading up, so it is the current destination.
                const arriving = appear < 1;

                const label = n.label ?? n.kind;
                const addr = shortId(n.address, 8, 6);
                const dynamicWidth = Math.max(NODE_WIDTH, 92 + Math.max(addr.length, label.length) * 6.4);

                // Scale from the card's centre so it grows in place instead of
                // sliding away from the funds arriving at its left edge.
                const scale = 0.9 + 0.1 * appear;

                return (
                  <g
                    key={n.id}
                    className={`node ${isSelected ? "selected" : ""} ${arriving ? "arriving" : ""} ${
                      isRoot ? "root" : ""
                    }`}
                    opacity={dim ? 0.3 : appear}
                    transform={`translate(${n.x + dynamicWidth / 2},${n.y + NODE_HEIGHT / 2}) scale(${scale.toFixed(
                      4
                    )}) translate(${-dynamicWidth / 2},${-NODE_HEIGHT / 2})`}
                    onClick={() => onSelect?.(n)}
                    role={onSelect ? "button" : undefined}
                    tabIndex={onSelect ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (onSelect && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        onSelect(n);
                      }
                    }}
                  >
                    <rect
                      className="node-box"
                      width={dynamicWidth}
                      height={NODE_HEIGHT}
                      rx={10}
                      fill={TONE_FILL[tone] ?? "var(--surface-2)"}
                      stroke={isRoot ? "var(--accent)" : isSelected ? "var(--text)" : "var(--border)"}
                      strokeWidth={isRoot || isSelected ? 2 : 1}
                    />
                    <rect
                      className="node-risk"
                      x={7}
                      y={13}
                      width={3}
                      height={NODE_HEIGHT - 26}
                      rx={1.5}
                      fill={RISK_COLOR[tone] ?? "var(--muted-2)"}
                    />
                    <text x={20} y={22} className="node-title">
                      {label}
                    </text>
                    <text x={20} y={38} className="node-sub mono">
                      {addr}
                    </text>
                    <text x={20} y={54} className="node-sub">
                      {chainSymbol(n.chain)} · {n.riskLevel} {n.riskScore}
                    </text>
                    {/* The share of the investigated quantity that reached this
                        address. Without a nominated quantity there is no share,
                        so nothing is shown rather than implying one. */}
                    {n.tracedAmount !== null && n.tracedAmount !== undefined && Number(n.tracedAmount) > 0 ? (
                      <text x={20} y={70} className="node-amount">
                        {n.tracedAmount} {graph.asset ?? "traced"}
                      </text>
                    ) : null}
                    <text x={dynamicWidth - 12} y={22} className="node-hop" textAnchor="end">
                      hop {n.hopDistance}
                    </text>
                    <title>
                      {`${n.address}\n${label} · ${n.riskLevel} (${n.riskScore}/100)\nhop ${n.hopDistance} · ${
                        n.txCount
                      } transactions${n.inVolumeUsd ? `\nin ${usd(n.inVolumeUsd)}` : ""}${
                        n.outVolumeUsd ? `\nout ${usd(n.outVolumeUsd)}` : ""
                      }`}
                    </title>
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </div>

      {canPlay ? (
        <div className="trace-bar">
          <div className="trace-transport">
            <button
              className="icon-btn trace-btn"
              onClick={playback.toggle}
              aria-label={playing ? "Pause trace" : settled ? "Replay trace" : "Play trace"}
              title={playing ? "Pause" : settled ? "Replay from the root" : "Play"}
            >
              {playing ? "❚❚" : settled ? "↻" : "▶"}
            </button>
            <button
              className="icon-btn trace-btn"
              onClick={playback.replay}
              aria-label="Restart trace from the root"
              title="Restart from the root"
              disabled={settled && !playing}
            >
              ↺
            </button>
          </div>

          <input
            className="hop-scrub"
            type="range"
            min={0}
            max={total}
            step={0.01}
            value={t}
            onChange={(e) => playback.seek(Number(e.target.value))}
            aria-label="Trace position by hop"
            aria-valuetext={`${percent} percent, hop ${phase} of ${maxHop}`}
          />

          <div className="trace-progress" aria-hidden="true">
            <div className="trace-progress-fill" style={{ width: `${percent}%` }} />
            <span className="trace-percent">{percent}%</span>
          </div>

          <div className="trace-readout">
            <span className="trace-hop">
              Hop {phase} <span className="muted">/ {maxHop}</span>
            </span>
            <span className="trace-status">
              {playing ? "tracing" : settled ? "complete" : "paused"}
            </span>
          </div>

          <label className="trace-speed">
            <span className="muted">Speed</span>
            <select
              value={speed}
              onChange={(e) => playback.setSpeed(Number(e.target.value) as Speed)}
              aria-label="Playback speed"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {graph.totals.truncated ? (
        <Notice tone="warn" title="This graph is incomplete">
          <p>
            The trace stopped at its configured limits, so what is shown is not the whole movement of funds. Reasons:{" "}
            {graph.totals.truncatedReasons.join("; ")}. Raise the hop or node limit and re-run, or narrow the direction, to
            see more.
          </p>
        </Notice>
      ) : null}
    </div>
  );
}

/** Compact hop-by-hop table; the graph is for structure, this is for values. */
export function GraphTable({ graph, onSelect }: { graph: TraceGraph; onSelect?: (n: GraphNode) => void }): JSX.Element {
  const byHop = useMemo(() => {
    const map = new Map<number, GraphNode[]>();
    for (const n of graph.nodes) {
      const list = map.get(n.hopDistance) ?? [];
      list.push(n);
      map.set(n.hopDistance, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [graph]);

  return (
    <div className="hop-tables">
      {byHop.map(([hop, nodes]) => (
        <div key={hop} className="hop-block">
          <h4>
            Hop {hop}
            {hop === 0 ? " — root" : ""}
            <span className="muted"> · {nodes.length} address{nodes.length === 1 ? "" : "es"}</span>
          </h4>
          <table className="data dense">
            <thead>
              <tr>
                <th>Address</th>
                <th>Label / type</th>
                <th>Risk</th>
                <th className="right">In</th>
                <th className="right">Out</th>
                <th className="right">Tx</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.id} className={onSelect ? "clickable" : undefined} onClick={onSelect ? () => onSelect(n) : undefined}>
                  <td className="mono">{shortId(n.address, 14, 8)}</td>
                  <td>
                    {n.label ?? n.kind} <ChainTag chain={n.chain} />
                  </td>
                  <td>
                    <Badge tone={RISK_TONE[n.riskLevel] ?? "neutral"}>{n.riskScore}</Badge>
                  </td>
                  <td className="right num">{usd(n.inVolumeUsd)}</td>
                  <td className="right num">{usd(n.outVolumeUsd)}</td>
                  <td className="right num">{n.txCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function ChainTag({ chain }: { chain: string }): JSX.Element {
  return <span className={`chain-tag ${chain}`}>{chainSymbol(chain)}</span>;
}

/**
 * True when `nodeId` is an endpoint of the selected edge.
 *
 * Selecting a transfer should light up exactly the two addresses it connects,
 * rather than dimming the rest of the graph or leaving everything at full
 * strength. Edges whose endpoints are not in the layout are ignored so a
 * partially-rendered graph cannot throw during render.
 */
function edgeTouches(
  nodeId: string,
  edgeId: string | null | undefined,
  byId: Map<string, LayoutNode>,
  graph: TraceGraph
): boolean {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return true;
  if (edge.source === nodeId || edge.target === nodeId) return true;
  return !byId.has(edge.source) || !byId.has(edge.target);
}