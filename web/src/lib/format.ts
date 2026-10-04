/** Display formatters. All of them degrade to a neutral marker, never to "0". */

export function num(value: string | number | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return fallback;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Compact money. Deliberately refuses to render a null as 0: an unpriced
 * value is an absence of information, not an amount.
 */
export function usd(value: string | number | null | undefined, opts: { fallback?: string } = {}): string {
  const fallback = opts.fallback ?? "not priced";
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || n === 0) return fallback;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function native(value: string | number | null | undefined, symbol?: string, max = 6): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  let out: string;
  if (abs >= 1_000_000) out = `${(n / 1_000_000).toFixed(2)}M`;
  else if (abs >= 1_000) out = `${(n / 1_000).toFixed(2)}K`;
  else if (abs > 0 && abs < 0.000001) out = n.toExponential(2);
  else out = n.toLocaleString(undefined, { maximumFractionDigits: max });
  return symbol ? `${out} ${symbol}` : out;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (abs < min) return future ? "in a moment" : "just now";
  if (abs < hour) {
    const n = Math.round(abs / min);
    return future ? `in ${n}m` : `${n}m ago`;
  }
  if (abs < day) {
    const n = Math.round(abs / hour);
    return future ? `in ${n}h` : `${n}h ago`;
  }
  if (abs < 30 * day) {
    const n = Math.round(abs / day);
    return future ? `in ${n}d` : `${n}d ago`;
  }
  return dateOnly(iso);
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function pct(n: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

/** Middle-elide a long identifier for table cells. */
export function shortId(value: string | null | undefined, head = 10, tail = 6): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
}

export const CHAIN_META: Record<string, { name: string; symbol: string; explorer: string; tint: string }> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC", explorer: "https://mempool.space", tint: "bitcoin" },
  ethereum: { name: "Ethereum", symbol: "ETH", explorer: "https://etherscan.io", tint: "ethereum" },
  tron: { name: "Tron", symbol: "TRX", explorer: "https://tronscan.org", tint: "tron" },
  polygon: { name: "Polygon", symbol: "POL", explorer: "https://polygonscan.com", tint: "polygon" },
  unknown: { name: "Unknown", symbol: "?", explorer: "", tint: "" }
};

export function chainName(chain: string | null | undefined): string {
  return CHAIN_META[chain ?? "unknown"]?.name ?? chain ?? "Unknown";
}

export function chainSymbol(chain: string | null | undefined): string {
  return CHAIN_META[chain ?? "unknown"]?.symbol ?? "—";
}

export function explorerUrl(chain: string | null | undefined, id: string): string | null {
  const base = CHAIN_META[chain ?? "unknown"]?.explorer;
  if (!base) return null;
  const isTx = id.length >= 62;
  if (chain === "bitcoin") return `${base}/tx/${id}`;
  if (chain === "tron") return isTx ? `${base}/transaction/${id}` : `${base}/address/${id}`;
  return isTx ? `${base}/tx/${id}` : `${base}/address/${id}`;
}

export const RISK_TONE: Record<string, string> = {
  Critical: "critical",
  High: "high",
  Medium: "medium",
  Low: "low",
  Unrated: "unrated"
};

export const SEVERITY_TONE: Record<string, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  info: "info"
};

export const STATE_TONE: Record<string, string> = {
  open: "critical",
  acknowledged: "high",
  resolved: "ok",
  dismissed: "neutral"
};

export const STATUS_TONE: Record<string, string> = {
  Open: "info",
  "In Progress": "medium",
  "Under Review": "high",
  Escalated: "critical",
  Closed: "ok"
};

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
