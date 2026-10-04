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

const WEI = 10n ** 18n;
const http = new HttpClient({ timeoutMs: 20000, retries: 1 });

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface EthTx {
  hash: string;
  blockNumber: string | null;
  timeStamp?: string;
  from: string;
  to: string | null;
  value: string;
  gas: string;
  gasPrice: string;
  isError: string;
  txreceipt_status: string;
  nonce: string;
  input: string;
}

interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  timeStamp: string;
  transactionHash: string;
  logIndex: string;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Etherscan V2 is multi-chain; the chain id is what selects the network. */
const CHAIN_ID: Record<string, number> = { ethereum: 1, polygon: 137 };

/** The two EVM chains this adapter serves, and where each one lives. */
const EVM: Record<string, { native: string; urls: string[] }> = {
  ethereum: { native: "ETH", urls: env.ethRpcUrls },
  polygon: { native: "POL", urls: env.polygonRpcUrls }
};

interface EtherscanResult {
  status: string;
  message: string;
  result: unknown;
}

interface EtherscanTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  gasUsed?: string;
  gasPrice?: string;
  isError: string;
  tokenValue?: string;
  tokenSymbol?: string;
  contractAddress?: string;
}

export class EthereumAdapter implements ChainAdapter {
  readonly chain: Chain;
  private native: string;
  private rpcUrls: string[];
  private rpcId = 0;
  /**
   * Index of the endpoint that answered last. Public nodes flap, so sticking to
   * whichever one just worked keeps a healthy call from paying another node's
   * timeout on every request.
   */
  private preferred = 0;

  constructor(chain: "ethereum" | "polygon" = "ethereum") {
    this.chain = chain;
    this.native = EVM[chain]?.native ?? "ETH";
    this.rpcUrls = EVM[chain]?.urls ?? env.ethRpcUrls;
  }

  get activeRpcUrl(): string {
    return this.rpcUrls[this.preferred] ?? this.rpcUrls[0] ?? "";
  }

  async getTransaction(txHash: string): Promise<NormalizedTransaction> {
    const receipt = await this.rpc<{ status: string | null; blockNumber: string; gasUsed: string; effectiveGasPrice?: string } | null>(
      "eth_getTransactionReceipt",
      [txHash]
    );
    const [tx, blockTag] = await Promise.all([
      this.rpc<EthTx | null>("eth_getTransactionByHash", [txHash]),
      this.rpc<string>("eth_blockNumber", [])
    ]);

    if (!tx) throw new ChainUnavailableError(this.chain, `Transaction ${txHash} not found on Ethereum`);

    const blockNumber = receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
    const timestamp = await this.blockTimestamp(blockNumber);

    const transfers: NormalizedTransfer[] = [
      {
        kind: "native",
        asset: this.native,
        from: tx.from,
        to: tx.to,
        amount: weiToEther(tx.value),
        decimals: 18
      }
    ];

    // Token transfers via ERC-20 Transfer logs emitted by this tx.
    if (blockNumber != null) {
      const logs = await this.rpc<EthLog[]>("eth_getLogs", [
        {
          fromBlock: `0x${blockNumber.toString(16)}`,
          toBlock: `0x${blockNumber.toString(16)}`,
          topics: [TRANSFER_TOPIC],
          address: undefined
        }
      ]).catch(() => [] as EthLog[]);

      for (const log of logs.filter((l) => l.transactionHash?.toLowerCase() === txHash.toLowerCase())) {
        transfers.push(...this.decodeTransfer(log));
      }
    }

    const gasPrice = receipt?.effectiveGasPrice ?? tx.gasPrice ?? "0";
    const gasUsed = receipt?.gasUsed ?? "0";

    return {
      chain: this.chain,
      txHash: tx.hash,
      blockHeight: blockNumber,
      timestamp,
      from: tx.from,
      to: tx.to,
      valueNative: weiToEther(tx.value),
      valueUsd: null,
      status: receipt?.status === "0x1" ? "confirmed" : receipt ? "failed" : "pending",
      feeNative: weiToEther((BigInt(gasUsed) * BigInt(gasPrice)).toString()),
      transfers,
      raw: { tx, receipt, latestBlock: Number(BigInt(blockTag)) }
    };
  }

  async getAddress(address: string): Promise<NormalizedAddress> {
    const addr = address.toLowerCase();
    const [balanceHex, nonceHex, txs] = await Promise.all([
      this.rpc<string>("eth_getBalance", [addr, "latest"]),
      this.rpc<string>("eth_getTransactionCount", [addr, "latest"]),
      this.getTransactionsForAddress(address, { limit: 25 }).catch(() => ({ transactions: [], cursor: null }))
    ]);

    const times = txs.transactions.map((t) => t.timestamp).filter((t): t is string => Boolean(t));
    const observed = txs.transactions.length;
    const outgoing = toNumber(nonceHex);

    return {
      chain: this.chain,
      address: addr,
      firstSeen: times.length ? times.sort()[0]! : null,
      lastSeen: times.length ? times.sort()[times.length - 1]! : null,
      // Nonce counts what this address has *sent*; for a contract or a
      // never-used address it is 0 despite real activity. Prefer the number we
      // actually observed and fall back to nonce only when we observed nothing.
      txCount: observed || outgoing,
      receivedTotal: txs.transactions.reduce((s, t) => (t.to?.toLowerCase() === addr ? s + toNumber(t.valueNative) : s), 0),
      sentTotal: txs.transactions.reduce((s, t) => (t.from?.toLowerCase() === addr ? s + toNumber(t.valueNative) : s), 0),
      balance: weiToEther(balanceHex),
      raw: {
        nonce: outgoing,
        observedTransactions: observed,
        ...(env.hasEtherscanKey ? {} : { historyCoverage: "none" }),
        note: env.hasEtherscanKey
          ? "Transaction history from Etherscan V2; value figures are limited to the returned page."
          : "Balance and nonce come from JSON-RPC. Full address history needs an indexer: set ETHERSCAN_API_KEY or configure one under Integrations.",
        recentTxHashes: txs.transactions.map((t) => t.txHash).slice(0, 25)
      }
    };
  }

  /**
   * Address-indexed history.
   *
   * A public JSON-RPC node answers point queries (a receipt, a block) but it
   * cannot enumerate "every transaction touching this address" — there is no
   * state trie keyed by participant. So this needs an indexer. Etherscan V2 is
   * used when a key is configured; without one we return empty rather than
   * guessing, and the caller surfaces the gap instead of showing a false zero.
   */
  async getTransactionsForAddress(
    address: string,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<{ transactions: NormalizedTransaction[]; cursor: string | null }> {
    if (!env.hasEtherscanKey) return { transactions: [], cursor: null };

    const limit = Math.min(opts.limit ?? 25, 50);
    const offset = Math.max(0, Number(opts.cursor ?? 0) || 0);
    const addr = address.toLowerCase();

    const [native, tokens] = await Promise.all([
      this.explorer<EtherscanTx[]>("txlist", { address: addr, offset: String(offset), limit: String(limit), sort: "desc" }).catch(
        () => [] as EtherscanTx[]
      ),
      this.explorer<EtherscanTx[]>("tokentx", { address: addr, offset: "0", limit: String(limit), sort: "desc" }).catch(() => [] as EtherscanTx[])
    ]);

    const transactions: NormalizedTransaction[] = [];

    for (const t of native) {
      const blockNumber = Number(t.blockNumber);
      const transfers: NormalizedTransfer[] = [
        { kind: "native", asset: this.native, from: t.from, to: t.to, amount: weiToEther(t.value), decimals: 18 }
      ];
      transactions.push({
        chain: this.chain,
        txHash: t.hash,
        blockHeight: Number.isFinite(blockNumber) ? blockNumber : null,
        timestamp: toIso(t.timeStamp),
        from: t.from,
        to: t.to,
        valueNative: weiToEther(t.value),
        // No price feed is configured, so USD is left unset rather than guessed.
        valueUsd: null,
        status: t.isError === "1" ? "failed" : "confirmed",
        feeNative: t.gasUsed && t.gasPrice ? weiToEther((BigInt(t.gasUsed) * BigInt(t.gasPrice)).toString()) : null,
        transfers,
        raw: { source: "etherscan", record: t }
      });
    }

    for (const t of tokens) {
      const blockNumber = Number(t.blockNumber);
      transactions.push({
        chain: this.chain,
        txHash: t.hash,
        blockHeight: Number.isFinite(blockNumber) ? blockNumber : null,
        timestamp: toIso(t.timeStamp),
        from: t.from,
        to: t.to,
        valueNative: String(Number(t.tokenValue ?? 0) / 1e18),
        valueUsd: null,
        status: "confirmed",
        feeNative: null,
        transfers: [
          {
            kind: "token",
            asset: t.tokenSymbol ?? "ERC-20",
            from: t.from,
            to: t.to,
            amount: String(Number(t.tokenValue ?? 0) / 1e18),
            decimals: 18,
            contract: t.contractAddress?.toLowerCase() ?? null
          }
        ],
        raw: { source: "etherscan", record: t }
      });
    }

    transactions.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    return { transactions, cursor: native.length >= limit ? String(offset + limit) : null };
  }

  private async explorer<T>(action: string, params: Record<string, string>): Promise<T> {
    const chainId = CHAIN_ID[this.chain] ?? 1;
    const query = new URLSearchParams({ chainid: String(chainId), module: "account", action, ...params });
    const res = await http.getJson<EtherscanResult>(
      `https://api.etherscan.io/v2/api?${query.toString()}`,
      { apikey: env.ETHERSCAN_API_KEY }
    );
    if (res.status !== "1") {
      // "No transactions found" is an empty page, not a failure.
      if (typeof res.result === "string" && res.result.toLowerCase().includes("no ")) return [] as T;
      throw new ChainUnavailableError(this.chain, `Etherscan ${action} failed: ${res.result}`);
    }
    return res.result as T;
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const started = Date.now();
    try {
      const n = await this.rpc<string>("eth_blockNumber", []);
      return { ok: true, latencyMs: Date.now() - started, detail: `head block ${Number(BigInt(n))}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : "unreachable" };
    }
  }

  private async blockTimestamp(blockNumber: number | null): Promise<string | null> {
    if (blockNumber == null) return null;
    const block = await this.rpc<{ timestamp: string }>("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]).catch(() => null);
    return block ? toIso(parseInt(block.timestamp, 16)) : null;
  }

  private decodeTransfer(log: EthLog): NormalizedTransfer[] {
    if (log.topics.length < 3) return [];
    const from = `0x${log.topics[1]!.slice(26)}`;
    const to = `0x${log.topics[2]!.slice(26)}`;
    return [
      {
        kind: "token",
        asset: "ERC-20",
        from,
        to,
        amount: weiToEther(log.data || "0x0"),
        decimals: 18,
        contract: log.address?.toLowerCase() ?? null,
        logIndex: toNumber(log.logIndex)
      }
    ];
  }

  /**
   * Try each configured endpoint in turn, starting from the one that last
   * worked. A node that answers with an RPC error, times out, or returns a
   * missing result is treated as failed so the next node gets a chance.
   */
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (this.rpcUrls.length === 0) {
      throw new ChainUnavailableError(this.chain, `No JSON-RPC endpoint configured for ${this.chain}`);
    }

    const errors: string[] = [];

    for (let i = 0; i < this.rpcUrls.length; i++) {
      const url = this.rpcUrls[(this.preferred + i) % this.rpcUrls.length]!;
      try {
        const res = await http.postJson<RpcResponse<T>>(url, { jsonrpc: "2.0", id: ++this.rpcId, method, params });

        if (res.error) throw new ChainUnavailableError(this.chain, res.error.message);
        // A 200 with no payload is a degraded node, not a success: treat it as
        // failure so we fail over instead of propagating null to the caller.
        if (res.result == null) throw new ChainUnavailableError(this.chain, "endpoint returned no result");

        this.preferred = (this.preferred + i) % this.rpcUrls.length;
        return res.result;
      } catch (err) {
        errors.push(`${hostOf(url)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new ChainUnavailableError(
      this.chain,
      `Ethereum RPC ${method} failed on all ${this.rpcUrls.length} endpoint(s) — ${errors.join("; ")}`
    );
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function weiToEther(wei: string | bigint): string {
  try {
    return (BigInt(wei) / WEI).toString();
  } catch {
    return "0";
  }
}
