import { useEffect, useRef, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { RISK_TONE, SEVERITY_TONE, STATE_TONE, STATUS_TONE, chainSymbol, shortId } from "../lib/format";

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}): JSX.Element {
  return (
    <header className="page-header">
      {breadcrumb ? <div className="crumbs">{breadcrumb}</div> : null}
      <div className="page-header-row">
        <div>
          <h1>{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Card({
  title,
  hint,
  actions,
  children,
  className = "",
  flush = false
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="card-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {hint ? <p className="card-hint">{hint}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Grid({ cols = 2, children }: { cols?: number; children: ReactNode }): JSX.Element {
  return <div className="grid" style={{ "--cols": cols } as React.CSSProperties}>{children}</div>;
}

/* ----------------------------------------------------------------- badges */

/**
 * Visual tone for a `Badge`, matching a `.badge.<tone>` class in the stylesheet.
 *
 * Kept as `string` rather than a literal union: the tone names come from the
 * design system in CSS and are used across risk levels, roles, chains, document
 * states and VASP classifications, so enumerating them here would only create a
 * second list that drifts out of sync with the stylesheet.
 */
export interface BadgeProps {
  children: ReactNode;
  tone?: string;
  title?: string;
}

export function Badge({ children, tone = "neutral", title }: BadgeProps): JSX.Element {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function RiskBadge({ level, score }: { level: string; score?: number | null }): JSX.Element {
  return (
    <Badge tone={RISK_TONE[level] ?? "neutral"} title={score != null ? `Risk score ${score}/100` : undefined}>
      {level}
      {score != null ? <span className="badge-score">{score}</span> : null}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }): JSX.Element {
  return <Badge tone={SEVERITY_TONE[severity] ?? "neutral"}>{severity}</Badge>;
}

export function StateBadge({ state }: { state: string }): JSX.Element {
  return <Badge tone={STATE_TONE[state] ?? "neutral"}>{state}</Badge>;
}

export function CaseStatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>;
}

export function ChainBadge({ chain }: { chain: string | null | undefined }): JSX.Element {
  if (!chain) return <span className="muted">—</span>;
  return (
    <Badge tone={chain === "unknown" ? "neutral" : chain}>
      {chainSymbol(chain)}
    </Badge>
  );
}

export function RoleBadge({ role }: { role: string }): JSX.Element {
  return <Badge tone={role === "admin" ? "critical" : role === "investigator" ? "high" : "neutral"}>{role}</Badge>;
}

/* ----------------------------------------------------------------- tables */

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Sort key forwarded to the server; omit for client-only columns. */
  sortKey?: string;
  align?: "left" | "right" | "center";
  width?: string;
  className?: string;
}

/**
 * Row type is unconstrained on purpose: several tables key on non-UUID values
 * (audit entry ids are integers, rule codes are strings, some projections have
 * no id at all). A default key function covers all of them, and `rowKey` is
 * there for the tables that need something else.
 */
export function DataTable<T extends object>({
  rows,
  columns,
  empty = "Nothing to show.",
  loading = false,
  onRowClick,
  rowKey,
  dense = false
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: ReactNode;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  rowKey?: (row: T, i: number) => string;
  dense?: boolean;
}): JSX.Element {
  if (loading) return <TableSkeleton rows={6} columns={columns.length} />;
  // A null `empty` means the caller knows the absence is not a finding — the
  // request was refused or failed — so it withholds the message rather than
  // claiming there is nothing there.
  if (!rows.length) return empty ? <EmptyState>{empty}</EmptyState> : <></>;

  const keyOf = (row: T, i: number): string => {
    if (rowKey) return rowKey(row, i);
    const id = (row as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return String(id);
    return `row-${i}`;
  };

  return (
    <div className="table-wrap">
      <table className={dense ? "data dense" : "data"}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align ?? "left" }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={keyOf(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "clickable" : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? "left" }} className={c.className}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableSkeleton({ rows, columns }: { rows: number; columns: number }): JSX.Element {
  return (
    <div className="table-wrap" aria-busy="true" aria-label="Loading">
      <table className="data">
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: columns }).map((_, c) => (
                <td key={c}>
                  <span className="skeleton" style={{ width: `${45 + ((r * 7 + c * 13) % 45)}%` }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }): JSX.Element {
  const code = error instanceof ApiError ? error.code : "error";
  const forbidden = error instanceof ApiError && error.isForbidden;
  const title = forbidden
    ? "Not available to your role"
    : code === "chain_unavailable"
      ? "Chain data unavailable"
      : "Could not load this data";
  return (
    <div className="error-state" role="alert">
      <strong>{title}</strong>
      <p>{error.message}</p>
      {onRetry ? (
        <button className="btn ghost" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * True when a query has nothing trustworthy to summarise.
 *
 * A failed or refused request leaves `data` null, and a panel that falls back to
 * zeros in that case is asserting a count it never received. On this platform
 * "no accounts exist" and "you may not list accounts" are different findings
 * and only one of them is ever true, so the summary has to be withheld rather
 * than defaulted.
 */
export function isUnloaded<T>(query: { data: T | null; error: ApiError | null; loading: boolean }): boolean {
  // "Unloaded" has to mean exactly one thing to its callers: `data` is absent,
  // so the figure must be withheld. They all read `loaded ? data!.x : NOT_LOADED`,
  // which is only safe when `loaded` implies `data !== null`.
  //
  // The previous test also required `!loading`, so a query that had not resolved
  // yet (loading true, data null) counted as *loaded*. Every page that used this
  // guard therefore dereferenced null on its first render and took the whole
  // route down with a white screen. An error also leaves data null, so the two
  // cases collapse to the same check and the error still surfaces separately
  // through <ErrorState>.
  void query.error;
  void query.loading;
  return query.data === null;
}

/** Placeholder for a figure that was never loaded, as distinct from a real zero. */
export const NOT_LOADED = "—";

/* ----------------------------------------------------------------- inputs */

export function Field({
  label,
  hint,
  error,
  children,
  required
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  required?: boolean;
}): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required ? <em> *</em> : null}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled
}: {
  value: T | "";
  onChange: (v: T) => void;
  options: readonly (T | { value: T; label: string })[];
  placeholder?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) =>
        typeof o === "string" ? (
          <option key={o} value={o}>
            {o}
          </option>
        ) : (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        )
      )}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className={`toggle ${disabled ? "disabled" : ""}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}): JSX.Element {
  return (
    <div className="search">
      <span className="search-ico" aria-hidden="true">
        ⌕
      </span>
      <input
        type="search"
        value={value}
        placeholder={placeholder ?? "Search…"}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
      {value ? (
        <button className="search-clear" onClick={() => onChange("")} aria-label="Clear search">
          ×
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- metrics */

export function Kpi({
  label,
  value,
  sub,
  tone
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}): JSX.Element {
  return (
    <div className={`kpi ${tone ? `tone-${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </div>
  );
}

export function KpiRow({ children, cols = 4 }: { children: ReactNode; cols?: number }): JSX.Element {
  return (
    <div className="kpi-row" style={{ "--cols": cols } as React.CSSProperties}>
      {children}
    </div>
  );
}

export function Meter({ value, max = 100, tone }: { value: number; max?: number; tone?: string }): JSX.Element {
  const width = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="meter" title={`${value} of ${max}`}>
      <span className={`meter-fill ${tone ?? RISK_TONE[levelOf(value)]}`} style={{ width: `${width}%` }} />
    </span>
  );
}

function levelOf(score: number): string {
  if (score >= 75) return "Critical";
  if (score >= 55) return "High";
  if (score >= 35) return "Medium";
  if (score >= 15) return "Low";
  return "Unrated";
}

/* ------------------------------------------------------------- disclosure */

export function Details({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }): JSX.Element {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Copyable({ value, display }: { value: string | null | undefined; display?: string }): JSX.Element {
  const text = display ?? shortId(value, 12, 8);
  if (!value) return <span className="muted">—</span>;
  return (
    <button
      className="copyable mono"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
      }}
      title={`Copy ${value}`}
    >
      {text}
    </button>
  );
}

export function Notice({
  tone = "info",
  title,
  children
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  title?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`notice ${tone}`} role={tone === "danger" ? "alert" : undefined}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={`tab ${active === t.id ? "active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Pagination({
  limit,
  offset,
  total,
  onChange
}: {
  limit: number;
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}): JSX.Element | null {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <div className="pager">
      <button className="btn ghost sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </button>
      <span className="pager-label">
        Page {page} of {pages}
      </span>
      <button
        className="btn ghost sm"
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        Next
      </button>
    </div>
  );
}
