import { env } from "../config.js";
import {
  ChainUnavailableError,
  HttpClient,
  toIso,
  toNumber,
  type ChainAdapter,
  type NormalizedAddress,
  type NormalizedTransaction,
  type NormalizedTransfer
} from "./base.js";
import type { Chain } from "../types.js";

const SUN = 1_000_000;
const http = new HttpClient({ minIntervalMs: 250, timeoutMs: 15000, retries: 2 });

interface TronTransaction {
  txID: string;
  blockNumber: number;
  block_timestamp: number;
  ret: { contractRet?: string }[];
  raw_data?: {
    contract?: {
      type?: string;
      parameter?: { value?: Record<string, unknown> };
    }[];
  };
  /** Present on `wallet/gettransactioninfobyid` responses. */
  contractAddress?: string;
  net_usage?: number;
}

interface TronAddressInfo {
  balance?: number;
  create_time?: number;
  active_permission?: unknown[];
}

function header(): Record<string, string> {
  return env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": env.TRONGRID_API_KEY } : {};
}

export class TronAdapter implements ChainAdapter {
  readonly chain: Chain = "tron";
  private base = env.TRONGRID_API.replace(/\/$/, "");

  async getTransaction(txHash: string): Promise<NormalizedTransaction> {
    const raw = await this.get<{ data: TronTransaction[] }>(
      `/wallet/gettransactioninfobyid?value=${encodeURIComponent(txHash)}`
    );
    const tx = raw?.data?.[0];
    if (!tx) throw new ChainUnavailableError(this.chain, `Transaction ${txHash} not found on Tron`);

    const { from, to, amount } = this.parseTransferContract(tx);

    const transfers: NormalizedTransfer[] = [
      { kind: "native", asset: "TRX", from, to, amount: String(amount / SUN), decimals: 6 }
    ];

    return {
      chain: this.chain,
      txHash: tx.txID,
      blockHeight: toNumber(tx.blockNumber),
      timestamp: toIso(tx.block_timestamp),
      from,
      to,
      valueNative: String(amount / SUN),
      valueUsd: null,
      status: tx.ret?.[0]?.contractRet === "SUCCESS" ? "confirmed" : "failed",
      feeNative: tx.net_usage != null ? String((toNumber(tx.net_usage) * 1000) / SUN) : null,
      transfers,
      raw: tx
    };
  }

  async getAddress(address: string): Promise<NormalizedAddress> {
    const [info, txsRaw] = await Promise.all([
      this.get<TronAddressInfo>(`/wallet/getaccount?address=${encodeURIComponent(address)}`),
      this.get<{ data: TronTransaction[] }>(`/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?limit=50`).catch(
        () => ({ data: [] as TronTransaction[] })
      )
    ]);

    const native = await this.get<{ data: TronTransaction[] }>(
      `/v1/accounts/${encodeURIComponent(address)}/transactions?limit=50`
    ).catch(() => ({ data: [] as TronTransaction[] }));

    const times = [...(native?.data ?? []), ...(txsRaw?.data ?? [])]
      .map((t) => t.block_timestamp)
      .filter((t): t is number => typeof t === "number");

    return {
      chain: this.chain,
      address,
      firstSeen: times.length ? toIso(Math.min(...times)) : null,
      lastSeen: times.length ? toIso(Math.max(...times)) : null,
      txCount: (native?.data?.length ?? 0) + (txsRaw?.data?.length ?? 0),
      receivedTotal: 0,
      sentTotal: 0,
      balance: info?.balance != null ? String(info.balance / SUN) : null,
      raw: { account: info, sampledTxs: (native?.data?.length ?? 0) + (txsRaw?.data?.length ?? 0) }
    };
  }

  async getTransactionsForAddress(
    address: string,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<{ transactions: NormalizedTransaction[]; cursor: string | null }> {
    const limit = Math.min(opts.limit ?? 25, 50);
    const params = new URLSearchParams({ limit: String(limit) });
    if (opts.cursor) params.set("fingerprint", opts.cursor);

    const res = await this.get<{ data: TronTransaction[]; meta?: { fingerprint?: string } }>(
      `/v1/accounts/${encodeURIComponent(address)}/transactions?${params.toString()}`
    );
    const list = res?.data ?? [];

    const out: NormalizedTransaction[] = [];
    for (const tx of list.slice(0, limit)) {
      try {
        out.push(await this.getTransaction(tx.txID));
      } catch {
        // Partial page is still worth returning.
      }
    }
    return { transactions: out, cursor: res?.meta?.fingerprint ?? null };
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const started = Date.now();
    try {
      // getnowblock nests the height under block_header.raw_data.number. The
      // sibling `blockID` is a *hash*, not a height, so reading it gave 0.
      const block = await this.get<{ blockID?: string; block_header?: { raw_data?: { number?: number } } }>(
        "/wallet/getnowblock"
      );
      const height = toNumber(block?.block_header?.raw_data?.number);
      if (!height) throw new Error("TronGrid returned no head block height");
      return { ok: true, latencyMs: Date.now() - started, detail: `head block ${height}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : "unreachable" };
    }
  }

  private parseTransferContract(tx: TronTransaction): { from: string | null; to: string | null; amount: number } {
    const contract = tx.raw_data?.contract?.[0];
    const value = contract?.parameter?.value ?? {};
    if (contract?.type === "TransferContract") {
      return {
        from: typeof value.owner_address === "string" ? value.owner_address : null,
        to: typeof value.to_address === "string" ? value.to_address : null,
        amount: toNumber(value.amount)
      };
    }
    return { from: null, to: null, amount: 0 };
  }

  private async get<T>(path: string): Promise<T> {
    try {
      return await http.getJson<T>(`${this.base}${path}`, header());
    } catch (err) {
      throw new ChainUnavailableError(this.chain, `TronGrid request failed for ${path}`, err);
    }
  }
}
