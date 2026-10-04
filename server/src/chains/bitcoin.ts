import { env } from "../config.js";
import {
  ChainUnavailableError,
  HttpClient,
  toIso,
  toNumber,
  type ChainAdapter,
  type NormalizedAddress,
  type NormalizedTransaction,
  type NormalizedTransfer,
  type NormalizedUtxo
} from "./base.js";
import type { Chain } from "../types.js";

const SAT = 100_000_000;
const http = new HttpClient({ minIntervalMs: 120, timeoutMs: 15000, retries: 2 });

interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  fee?: number;
  vin: { txid?: string; vout?: number; is_coinbase?: boolean; prevout?: { scriptpubkey_address?: string; value?: number } }[];
  vout: { scriptpubkey_type?: string; scriptpubkey_address?: string; value?: number }[];
}

interface MempoolAddressStats {
  address: string;
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  /** Tolerated so an older/partial payload does not throw on access. */
  funded_txo_sum?: number;
  spent_txo_sum?: number;
  tx_count?: number;
}

export class BitcoinAdapter implements ChainAdapter {
  readonly chain: Chain = "bitcoin";
  private base = env.MEMPOOL_API.replace(/\/$/, "");

  async getTransaction(txHash: string): Promise<NormalizedTransaction> {
    const tx = await this.fetchMempool<MempoolTx>(`/tx/${txHash}`);
    if (!tx) throw new ChainUnavailableError(this.chain, `Transaction ${txHash} not found on Bitcoin`);

    const transfers: NormalizedTransfer[] = [];
    for (const vin of tx.vin) {
      if (vin.prevout?.scriptpubkey_address) {
        transfers.push({
          kind: "utxo",
          asset: "BTC",
          from: vin.prevout.scriptpubkey_address,
          to: null,
          amount: String(toNumber(vin.prevout.value) / SAT),
          decimals: 8
        });
      }
    }
    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address) {
        transfers.push({
          kind: "utxo",
          asset: "BTC",
          from: null,
          to: vout.scriptpubkey_address,
          amount: String(toNumber(vout.value) / SAT),
          decimals: 8
        });
      }
    }

    // First non-null input address / first output address, following mempool's
    // ordering. Public explorers disagree here; the raw record keeps the full set.
    const from = tx.vin.find((v) => v.prevout?.scriptpubkey_address)?.prevout?.scriptpubkey_address ?? null;
    const to = tx.vout.find((v) => v.scriptpubkey_address)?.scriptpubkey_address ?? null;
    const totalOut = tx.vout.reduce((sum, v) => sum + toNumber(v.value), 0);

    // A UTXO transaction can spend many previous outputs and create many new
    // ones. `from`/`to` above name only the first of each, so the totals and the
    // full sets are carried separately — an investigator reconciling a
    // transaction needs the input side too, not just the output side.
    const inputs: NormalizedUtxo[] = tx.vin.map((vin, index) => {
      const prevout = vin.prevout;
      return {
        index,
        address: prevout?.scriptpubkey_address ?? null,
        value: String(toNumber(prevout?.value) / SAT),
        // A coinbase input creates value rather than spending it, so there is
        // no outpoint and no address to attribute it to.
        spends: vin.is_coinbase || !vin.txid ? null : { txid: vin.txid, vout: toNumber(vin.vout) },
        coinbase: Boolean(vin.is_coinbase)
      };
    });

    const outputs: NormalizedUtxo[] = tx.vout.map((vout, index) => ({
      index,
      address: vout.scriptpubkey_address ?? null,
      value: String(toNumber(vout.value) / SAT)
    }));

    // Only inputs that actually spend a previous output contribute to the
    // input total; a coinbase input's value is not known from `vin`.
    const totalIn = tx.vin.reduce((sum, v) => (v.prevout ? sum + toNumber(v.prevout.value) : sum), 0);

    return {
      chain: this.chain,
      txHash: tx.txid,
      blockHeight: tx.status.block_height ?? null,
      timestamp: toIso(tx.status.block_time),
      from,
      to,
      valueNative: String(totalOut / SAT),
      valueUsd: null,
      status: tx.status.confirmed ? "confirmed" : "pending",
      feeNative: tx.fee != null ? String(tx.fee / SAT) : null,
      transfers,
      inputTotal: String(totalIn / SAT),
      outputTotal: String(totalOut / SAT),
      inputCount: inputs.length,
      outputCount: outputs.length,
      inputs,
      outputs,
      raw: tx
    };
  }

  async getAddress(address: string): Promise<NormalizedAddress> {
    // mempool.space has no `/address/{addr}/stats` route: it answers 404, which
    // made every Bitcoin address lookup fail and every trace return an empty
    // graph. Aggregate totals live on `/address/{addr}` itself, under
    // chain_stats (confirmed) and mempool_stats (unconfirmed).
    const stats = await this.fetchMempool<MempoolAddressStats>(`/address/${address}`);
    const txs = await this.fetchMempool<MempoolTx[]>(`/address/${address}/txs`);
    const list = txs ?? [];
    const times = list
      .map((t) => t.status.block_time)
      .filter((t): t is number => typeof t === "number");

    return {
      chain: this.chain,
      address,
      firstSeen: times.length ? toIso(Math.min(...times)) : null,
      lastSeen: times.length ? toIso(Math.max(...times)) : null,
      txCount: toNumber(stats?.chain_stats?.tx_count ?? stats?.tx_count ?? list.length),
      receivedTotal: toNumber(stats?.chain_stats?.funded_txo_sum ?? stats?.funded_txo_sum) / SAT,
      sentTotal: toNumber(stats?.chain_stats?.spent_txo_sum ?? stats?.spent_txo_sum) / SAT,
      balance: null,
      raw: { stats, recentTxIds: list.slice(0, 25).map((t) => t.txid) }
    };
  }

  async getTransactionsForAddress(
    address: string,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<{ transactions: NormalizedTransaction[]; cursor: string | null }> {
    const limit = Math.min(opts.limit ?? 25, 50);
    const url = opts.cursor ? `/address/${address}/txs/chain/${opts.cursor}` : `/address/${address}/txs`;
    const list = await this.fetchMempool<MempoolTx[]>(url);
    if (!list) return { transactions: [], cursor: null };

    const page = list.slice(0, limit);
    const out: NormalizedTransaction[] = [];
    for (const tx of page) {
      try {
        out.push(await this.getTransaction(tx.txid));
      } catch {
        // Skip a tx we could not resolve; the partial page is still useful.
      }
    }
    return { transactions: out, cursor: list.length > limit ? list[limit - 1]?.txid ?? null : null };
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const started = Date.now();
    try {
      // /blocks/tip/height returns a bare JSON number, not an object, so the
      // old `{ count }` read always produced "tip block ?" and the probe could
      // never show a real height.
      const tip = await this.fetchMempool<number | { count?: number }>("/blocks/tip/height");
      const height = typeof tip === "number" ? tip : toNumber(tip?.count);
      if (!height) throw new Error("mempool.space returned no tip height");
      return { ok: true, latencyMs: Date.now() - started, detail: `tip block ${height}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : "unreachable" };
    }
  }

  private async fetchMempool<T>(path: string): Promise<T | null> {
    try {
      return await http.getJson<T>(`${this.base}${path}`);
    } catch (err) {
      throw new ChainUnavailableError(this.chain, `mempool.space request failed for ${path}`, err);
    }
  }
}
