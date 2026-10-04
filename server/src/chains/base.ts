import type { Chain } from "../types.js";

/**
 * Normalized on-chain record shapes. Every adapter returns these; nothing
 * downstream knows which provider a value came from.
 */

/** One input or output of a UTXO transaction. */
export interface NormalizedUtxo {
  index: number;
  address: string | null;
  /** Native units, matching `NormalizedTransaction.valueNative`. */
  value: string;
  /** Inputs only: the outpoint being spent. Null for a coinbase input. */
  spends?: { txid: string; vout: number } | null;
  /** A coinbase input has no previous output to point at. */
  coinbase?: boolean;
}

export interface NormalizedTransaction {
  chain: Chain;
  txHash: string;
  blockHeight: number | null;
  timestamp: string | null;
  from: string | null;
  to: string | null;
  valueNative: string;
  valueUsd: number | null;
  status: "confirmed" | "failed" | "pending" | "unknown";
  feeNative: string | null;
  /** Token transfers / UTXO inputs, normalized to the same shape. */
  transfers: NormalizedTransfer[];
  /**
   * UTXO totals and the full input/output sets.
   *
   * `from`/`to` carry only the first address on each side, which is enough for
   * a list row but loses the rest of a multi-input transaction. These carry the
   * whole set. Only UTXO chains (Bitcoin) populate them; an account-model chain
   * such as Ethereum or Tron has no input/output set to enumerate, so the
   * fields stay absent rather than being reported as zero.
   */
  inputTotal?: string;
  outputTotal?: string;
  inputCount?: number;
  outputCount?: number;
  inputs?: NormalizedUtxo[];
  outputs?: NormalizedUtxo[];
  raw: unknown;
}

export interface NormalizedTransfer {
  kind: "native" | "token" | "utxo";
  asset: string;
  from: string | null;
  to: string | null;
  amount: string;
  decimals: number;
  contract?: string | null;
  logIndex?: number | null;
}

export interface NormalizedAddress {
  chain: Chain;
  address: string;
  firstSeen: string | null;
  lastSeen: string | null;
  txCount: number;
  receivedTotal: number;
  sentTotal: number;
  balance: string | null;
  raw: unknown;
}

export interface ChainAdapter {
  chain: Chain;
  getTransaction(txHash: string): Promise<NormalizedTransaction>;
  getAddress(address: string): Promise<NormalizedAddress>;
  getTransactionsForAddress(address: string, opts?: { limit?: number; cursor?: string }): Promise<{
    transactions: NormalizedTransaction[];
    cursor: string | null;
  }>;
  /** Health probe used by the Integrations and Dashboard network panels. */
  health(): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
}

export class ChainUnavailableError extends Error {
  override cause?: unknown;

  constructor(public chain: Chain, message: string, cause?: unknown) {
    super(message);
    this.name = "ChainUnavailableError";
    this.cause = cause;
  }
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000).toISOString();
  if (typeof value === "string") {
    const asNum = Number(value);
    if (value !== "" && Number.isFinite(asNum)) return new Date(asNum > 1e12 ? asNum : asNum * 1000).toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Fetch with timeout, retry and a per-host rate limiter. */
export class HttpClient {
  private inFlight = new Map<string, Promise<void>>();
  private lastCall = new Map<string, number>();

  constructor(
    private opts: {
      minIntervalMs?: number;
      timeoutMs?: number;
      retries?: number;
      userAgent?: string;
    } = {}
  ) {}

  private async throttle(host: string): Promise<void> {
    const min = this.opts.minIntervalMs ?? 0;
    if (min <= 0) return;
    const last = this.lastCall.get(host) ?? 0;
    const wait = last + min - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCall.set(host, Date.now());
  }

  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>("GET", url, undefined, headers);
  }

  async postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>("POST", url, JSON.stringify(body), { "content-type": "application/json", ...headers });
  }

  private async request<T>(method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<T> {
    const host = safeHost(url);
    const retries = this.opts.retries ?? 2;
    const timeoutMs = this.opts.timeoutMs ?? 15000;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const pending = this.inFlight.get(url);
      if (pending) await pending;
      let release: () => void = () => undefined;
      this.inFlight.set(url, new Promise<void>((r) => (release = r)));

      try {
        await this.throttle(host);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method,
            body,
            headers: {
              accept: "application/json",
              "user-agent": this.opts.userAgent ?? "CryptoTraceAI/0.1 (research prototype)",
              ...headers
            },
            signal: ctrl.signal
          });
          if (res.status === 429 || res.status >= 500) {
            throw new RetryableError(`HTTP ${res.status} from ${host}`);
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new NonRetryableError(`HTTP ${res.status} from ${host}: ${text.slice(0, 200)}`, res.status);
          }
          return (await res.json()) as T;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err;
        if (err instanceof NonRetryableError) break;
        if (attempt < retries) await sleep(2 ** attempt * 400 + Math.random() * 250);
      } finally {
        release();
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

class RetryableError extends Error {}

/**
 * A request that failed in a way retrying will not fix (4xx, or a 5xx that
 * exhausted its retries). Carries the HTTP status so callers can distinguish
 * "this source has no data for that key" (404) from a genuine outage, which
 * changes whether they should surface an error or an empty result.
 */
export class NonRetryableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "NonRetryableError";
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
