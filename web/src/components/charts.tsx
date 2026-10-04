import { useId, useMemo, useState } from "react";
import { num, shortDate } from "../lib/format";

/** Small, dependency-free visualisations. Numbers stay in the DOM for screen readers. */

export function Sparkline({
  points,
  height = 40,
  tone = "var(--accent)"
}: {
  points: number[];
  height?: number;
  tone?: string;
}): JSX.Element {
  const { d, area } = useMemo(() => {
    if (points.length < 2) return { d: "", area: "" };
    const max = Math.max(...points, 1);
    const min = Math.min(...points, 0);
    const span = max - min || 1;
    const w = 100;
    const step = w / (points.length - 1);
    const coords = points.map((p, i) => [i * step, height - ((p - min) / span) * (height - 4) - 2] as const);
    const line = coords.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
    return { d: line, area: `${line} L 100 ${height} L 0 ${height} Z` };
  }, [points, height]);

  if (!d) return <div style={{ height }} className="chart-empty" />;

  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="sparkline" height={height} role="img" aria-label="Trend">
      <defs>
        <linearGradient id={`grad-${tone.replace(/[^a-z0-9]/gi, "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#grad-${tone.replace(/[^a-z0-9]/gi, "")})`} />
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BarSeries({
  data,
  height = 160,
  colors
}: {
  data: { label: string; value: number; color?: string }[];
  height?: number;
  colors?: Record<string, string>;
}): JSX.Element {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="bars" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="bar-col" title={`${d.label}: ${num(d.value)}`}>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                height: `${(d.value / max) * 100}%`,
                background: d.color ?? colors?.[d.label] ?? "var(--accent)"
              }}
            />
          </div>
          <span className="bar-value">{num(d.value)}</span>
          <span className="bar-label">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Donut({
  segments,
  size = 150
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
}): JSX.Element {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const [hover, setHover] = useState<string | null>(null);
  const titleId = useId();

  let offset = 0;
  const arcs = segments.map((s) => {
    const frac = total ? s.value / total : 0;
    const arc = { ...s, frac, dash: frac * c, offset };
    offset += frac * c;
    return arc;
  });

  return (
    <div className="donut-wrap">
      <svg width={size} height={size} role="img" aria-labelledby={titleId}>
        <title id={titleId}>
          {segments.map((s) => `${s.label}: ${s.value}`).join(", ")}
        </title>
        <g transform={`translate(${size / 2},${size / 2}) rotate(-90)`}>
          <circle r={r} fill="none" stroke="var(--surface-2)" strokeWidth="16" />
          {arcs.map((a) => (
            <circle
              key={a.label}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth={hover === a.label ? 20 : 16}
              strokeDasharray={`${a.dash} ${c - a.dash}`}
              strokeDashoffset={-a.offset}
              opacity={hover && hover !== a.label ? 0.35 : 1}
              onMouseEnter={() => setHover(a.label)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </g>
        <text x="50%" y="47%" textAnchor="middle" className="donut-total">
          {hover ? segments.find((s) => s.label === hover)?.value : total}
        </text>
        <text x="50%" y="62%" textAnchor="middle" className="donut-caption">
          {hover ?? "total"}
        </text>
      </svg>
      <ul className="donut-legend">
        {segments.map((s) => (
          <li key={s.label} onMouseEnter={() => setHover(s.label)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: s.color }} />
            <span>{s.label}</span>
            <b>
              {num(s.value)}
              {total ? ` · ${Math.round((s.value / total) * 100)}%` : ""}
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Cases opened vs closed over the window, as two mirrored series. */
export function ActivityChart({
  data,
  height = 180
}: {
  data: { day: string; opened: number; closed: number }[];
  height?: number;
}): JSX.Element {
  const [mode, setMode] = useState<"opened" | "closed">("opened");
  const max = Math.max(...data.map((d) => Math.max(d.opened, d.closed)), 1);
  const shown = data.map((d) => ({ ...d, value: mode === "opened" ? d.opened : d.closed }));
  const sum = data.reduce((s, d) => s + (mode === "opened" ? d.opened : d.closed), 0);

  return (
    <div className="activity">
      <div className="activity-head">
        <div className="seg">
          <button className={mode === "opened" ? "active" : ""} onClick={() => setMode("opened")}>
            Opened
          </button>
          <button className={mode === "closed" ? "active" : ""} onClick={() => setMode("closed")}>
            Closed
          </button>
        </div>
        <span className="muted">{num(sum)} in window</span>
      </div>
      <div className="activity-plot" style={{ height }}>
        {shown.map((d) => (
          <div key={d.day} className="activity-col" title={`${d.day}: ${d.value}`}>
            <div className="activity-bar" style={{ height: `${(d.value / max) * 100}%` }} />
            <span className="activity-x">{shortDate(d.day)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ThresholdScale({
  thresholds,
  score
}: {
  thresholds: Record<string, number>;
  score?: number | null;
}): JSX.Element {
  const t = {
    low: Number(thresholds.low ?? 15),
    medium: Number(thresholds.medium ?? 35),
    high: Number(thresholds.high ?? 55),
    critical: Number(thresholds.critical ?? 75)
  };
  const marks = [
    { at: t.low, label: "Low" },
    { at: t.medium, label: "Medium" },
    { at: t.high, label: "High" },
    { at: t.critical, label: "Critical" }
  ];
  return (
    <div className="scale">
      <div className="scale-track">
        <span className="scale-band low" style={{ left: 0, width: `${t.low}%` }} />
        <span className="scale-band medium" style={{ left: `${t.low}%`, width: `${t.medium - t.low}%` }} />
        <span className="scale-band high" style={{ left: `${t.medium}%`, width: `${t.high - t.medium}%` }} />
        <span className="scale-band critical" style={{ left: `${t.high}%`, width: `${100 - t.high}%` }} />
        {score != null ? <span className="scale-marker" style={{ left: `${Math.min(100, score)}%` }} /> : null}
      </div>
      <div className="scale-labels">
        {marks.map((m) => (
          <span key={m.label} style={{ left: `${m.at}%` }} className={m.label.toLowerCase()}>
            {m.label} ≥ {m.at}
          </span>
        ))}
      </div>
    </div>
  );
}
