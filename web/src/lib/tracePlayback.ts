import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "../types";
import { NODE_HEIGHT, NODE_WIDTH, type LayoutNode } from "../lib/normalize";

/**
 * Trace playback clock.
 *
 * The tracer emits a hop-layered DAG, so playback is a single scalar `t` that
 * walks from 0 to `total` rather than a set of independent per-element timers.
 * One clock means the picture can never disagree with itself: a node cannot
 * light up after the funds that reached it have already arrived, and scrubbing
 * backwards is exactly the inverse of playing forwards.
 *
 * `t` is a float on purpose. Integer `t` would force every hop to change in a
 * single frame, which is what makes a graph "pop" rather than trace. All times
 * below are in units of hops, so one unit is one hop's travel.
 */

/** Wall-clock duration of one hop at 1x speed. */
const HOP_MS = 2400;

/**
 * How long a node takes to materialise, in hops.
 *
 * Deliberately less than 1: a node starts appearing while its inbound funds are
 * still in flight, so it reads as "this is where the money is arriving" rather
 * than popping in after the edge it depends on has already been drawn.
 */
const NODE_ENTER = 0.3;

/** How far behind the drawing head the trailing particles sit, in hops. */
const PARTICLE_GAP = 0.11;

export const SPEEDS = [0.5, 1, 2] as const;
export type Speed = (typeof SPEEDS)[number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Ease-out cubic: fast start, soft landing. Reads as deceleration, not a step. */
const easeOut = (v: number): number => 1 - (1 - clamp01(v)) ** 3;

export interface Playback {
  /** Position along the whole trace, in hops. `0` = root only, `total` = complete. */
  t: number;
  /** `total` is the position at which the graph is fully revealed. */
  total: number;
  /** Deepest hop in the graph. 0 for a single-address trace. */
  maxHop: number;
  /** Integer hop currently filling; edges leaving this hop are being drawn. */
  phase: number;
  /** Progress through the current hop, 0-1. */
  frac: number;
  /** True once the whole graph is drawn. */
  settled: boolean;
  playing: boolean;
  speed: Speed;
  setSpeed: (s: Speed) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  replay: () => void;
  /** Scrub to an absolute position. Pauses, so a dragged graph stays put. */
  seek: (t: number) => void;
}

/**
 * Owns the playback clock and exposes the derived reveal state.
 *
 * `t` is mirrored into a ref because the animation frame callback must read the
 * latest value without restarting the effect on every tick; re-running the
 * effect per frame would cancel and re-request the frame it is already running.
 */
export function useTracePlayback(graph: {
  nodes: GraphNode[];
  maxHops: number;
}): Playback {
  const maxHop = useMemo(
    () => graph.nodes.reduce((m, n) => Math.max(m, n.hopDistance), 0),
    [graph.nodes]
  );

  // At least one unit of travel, so a single-address graph still reaches the
  // settled state rather than dividing by zero in the frame loop.
  const total = Math.max(1, maxHop);

  const reduced = usePrefersReducedMotion();

  const [t, setTState] = useState(() => (reduced ? total : 0));
  const [playing, setPlaying] = useState(() => !reduced && total > 0);
  const [speed, setSpeed] = useState<Speed>(1);

  const tRef = useRef(t);
  const setT = useCallback((v: number) => {
    tRef.current = v;
    setTState(v);
  }, []);

  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);

  // A new graph restarts the trace. Keyed on the node list so a re-render with
  // the same data does not yank the viewer back to the root.
  const lastKey = useRef<string>("");
  useEffect(() => {
    const key = `${graph.nodes.length}:${maxHop}:${graph.nodes.map((n) => n.id).join(",")}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    setT(reduced ? total : 0);
    setPlaying(!reduced && total > 0);
  }, [setT, reduced, total, maxHop, graph.nodes]);

  useEffect(() => {
    if (!playing) return;
    lastRef.current = performance.now();

    const step = (now: number) => {
      const dt = now - lastRef.current;
      lastRef.current = now;
      const next = tRef.current + (dt * speed) / HOP_MS;
      if (next >= total) {
        setT(total);
        setPlaying(false);
        return;
      }
      setT(next);
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, speed, total, setT]);

  const play = useCallback(() => {
    if (tRef.current >= total) setT(0);
    setPlaying(true);
  }, [total, setT]);

  const pause = useCallback(() => setPlaying(false), []);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, play, pause]);

  const replay = useCallback(() => {
    setT(0);
    setPlaying(true);
  }, [setT]);

  // Scrubbing pauses. An analyst dragging the position is inspecting a specific
  // moment, and a graph that keeps moving out from under the drag is unusable.
  const seek = useCallback(
    (v: number) => {
      setPlaying(false);
      setT(Math.min(total, Math.max(0, v)));
    },
    [total, setT]
  );

  const settled = t >= total;
  const phase = Math.min(maxHop, Math.floor(t));
  const frac = clamp01(t - Math.floor(t));

  return {
    t,
    total,
    maxHop,
    phase,
    frac,
    settled,
    playing,
    speed,
    setSpeed,
    play,
    pause,
    toggle,
    replay,
    seek
  };
}

/**
 * How far an edge has been drawn, 0-1.
 *
 * An edge is drawn out of its source node, so it belongs to the hop of that
 * source. Once the clock passes into the next hop every edge of the previous
 * hop is complete, which is what makes each hop resolve as one legible beat.
 */
export function edgeReveal(e: GraphEdge, phase: number, frac: number, settled: boolean): number {
  if (settled) return 1;
  if (e.hop < phase) return 1;
  if (e.hop === phase) return frac;
  return 0;
}

/**
 * How far a node is materialised, 0-1.
 */
export function nodeReveal(n: GraphNode, t: number, settled: boolean): number {
  if (settled) return 1;
  const start = n.hopDistance - NODE_ENTER;
  return easeOut((t - start) / NODE_ENTER);
}

/**
 * Fractional positions of the travelling funds on an edge.
 *
 * They trail the drawing head rather than sitting on it, so the eye reads
 * direction: the dots are behind the leading edge of the stroke and move away
 * from the source. Returns an empty array for an undrawn edge.
 */
export function particleOffsets(p: number, count: number): number[] {
  if (p <= 0 || p >= 1) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const q = p - i * PARTICLE_GAP;
    if (q <= 0) break;
    out.push(q);
  }
  return out;
}

/**
 * How many funds markers an edge carries.
 *
 * More markers on a thicker edge so a large transfer reads as a larger one, and
 * a single dim marker on an edge that carries nothing, so "context only" edges
 * do not look like they are moving money.
 */
export function particleCount(
  traced: string | number | null | undefined,
  observed: number,
  strokeWidth: number
): number {
  const carried = traced !== null && traced !== undefined && traced !== "" ? Number(traced) : observed;
  if (!Number.isFinite(carried) || carried <= 0) return 1;
  if (strokeWidth >= 3) return 3;
  return 2;
}

/* -------------------------------------------------------------------------- */
/* Edge geometry                                                              */
/* -------------------------------------------------------------------------- */

export interface EdgeGeometry {
  d: string;
  /** Midpoint of the cubic, for the amount label. */
  lx: number;
  ly: number;
  /** Cubic control points, kept so a particle can be placed without measuring. */
  x1: number;
  y1: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  x2: number;
  y2: number;
}

/**
 * Spreads the edges meeting at one node along that node's face.
 *
 * Without this every outbound edge leaves from the exact same point on the
 * source and every inbound edge arrives at the exact same point on the target,
 * so a hub like a co-mingled wallet with three outputs draws as one thick
 * stripe that is impossible to follow. Each edge gets its own slot, ordered by
 * where it is going so the bundle does not cross itself.
 *
 * Returns a map of edge id to a vertical offset in pixels.
 */
export function assignAnchors(
  edges: GraphEdge[],
  byId: Map<string, LayoutNode>,
  groupBy: (e: GraphEdge) => string,
  otherEnd: (e: GraphEdge) => string
): Map<string, number> {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const key = groupBy(e);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const offsets = new Map<string, number>();
  for (const list of groups.values()) {
    const n = list.length;
    // Single edge on a face sits dead centre; a bundle fans across the middle
    // half of the node so it never reaches the rounded corners.
    const step = n > 1 ? (NODE_HEIGHT * 0.5) / (n - 1) : 0;
    const ordered = list.slice().sort((p, q) => {
      const a = byId.get(otherEnd(p))?.y ?? 0;
      const b = byId.get(otherEnd(q))?.y ?? 0;
      return a - b || p.id.localeCompare(q.id);
    });
    ordered.forEach((e, i) => offsets.set(e.id, (i - (n - 1) / 2) * step));
  }
  return offsets;
}

export function edgeGeometry(a: LayoutNode, b: LayoutNode, outDy = 0, inDy = 0): EdgeGeometry {
  const x1 = a.x + NODE_WIDTH;
  const y1 = a.y + NODE_HEIGHT / 2 + outDy;
  const x2 = b.x;
  const y2 = b.y + NODE_HEIGHT / 2 + inDy;
  const dx = Math.max(24, (x2 - x1) / 2);
  const cx1 = x1 + dx;
  const cx2 = x2 - dx;
  return {
    d: `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`,
    lx: (x1 + 3 * cx1 + 3 * cx2 + x2) / 8,
    ly: (y1 + 3 * y1 + 3 * y2 + y2) / 8,
    x1,
    y1,
    cx1,
    cy1: y1,
    cx2,
    cy2: y2,
    x2,
    y2
  };
}

/** Point at `u` along the cubic, matching the `d` string above exactly. */
export function bezierAt(g: EdgeGeometry, u: number): { x: number; y: number } {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: a * g.x1 + b * g.cx1 + c * g.cx2 + d * g.x2,
    y: a * g.y1 + b * g.cy1 + c * g.cy2 + d * g.y2
  };
}

/* -------------------------------------------------------------------------- */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}