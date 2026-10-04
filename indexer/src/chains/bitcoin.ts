import axios from "axios";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { getIndexerState, setIndexerState, storeTransactions, storeBlock } from "../db.js";
import { formatUnits } from "../units.js";
import type { Chain, IndexedTransaction, IndexedTransfer, MempoolTx } from "../types.js";

const http = axios.create({
  baseURL: env.MEMPOOL_API,
  timeout: 30000,
  headers: { "User-Agent": "CryptoTrace-Indexer/1.0" }
});

interface TipResponse {
  height: number;
  hash: string;
  timestamp: number;
}

export async function indexBitcoin(): Promise<void> {
  const chain: Chain = "bitcoin";
  const state = await getIndexerState(chain);

  if (state.isIndexing) {
    logger.debug("Bitcoin indexer already running");
    return;
  }

  await setIndexerState(chain, { isIndexing: true });

  try {
    // Get current tip
    const tipRes = await http.get<TipResponse>("/blocks/tip");
    const tipHeight = tipRes.data.height;

    // Respect reorg depth
    const targetHeight = tipHeight - env.REORG_DEPTH;
    if (state.lastIndexedBlock >= targetHeight) {
      logger.debug("Bitcoin indexer caught up", { current: state.lastIndexedBlock, target: targetHeight });
      return;
    }

    const startHeight = state.lastIndexedBlock + 1;
    const endHeight = Math.min(startHeight + env.INDEX_BATCH_SIZE - 1, targetHeight);

    logger.info("Indexing Bitcoin blocks", { start: startHeight, end: endHeight });

    for (let height = startHeight; height <= endHeight; height++) {
      await indexBlock(height);
    }

    await setIndexerState(chain, { lastIndexedBlock: endHeight, lastIndexedTime: Date.now() });
  } catch (err) {
    logger.error("Bitcoin indexing failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    await setIndexerState(chain, { isIndexing: false });
  }
}

async function indexBlock(height: number): Promise<void> {
  try {
    const blockHashRes = await http.get<string>(`/block-height/${height}`);
    const blockHash = blockHashRes.data;

    const blockRes = await http.get<{
      id: string;
      height: number;
      timestamp: number;
      tx_count: number;
      tx: string[];
    }>(`/block/${blockHash}`);

    const block = blockRes.data;
    const txs: IndexedTransaction[] = [];

    for (const txid of block.tx) {
      try {
        const tx = await indexTransaction(txid, block.height, block.timestamp);
        if (tx) txs.push(tx);
      } catch (err) {
        logger.warn("Failed to index transaction", { txid, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (txs.length > 0) {
      await storeTransactions(txs);
    }

    await storeBlock("bitcoin", block.height, block.id, block.timestamp, block.tx_count);
  } catch (err) {
    logger.error("Failed to index block", { height, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

async function indexTransaction(txid: string, blockHeight: number, blockTime: number): Promise<IndexedTransaction | null> {
  try {
    const res = await http.get<MempoolTx>(`/tx/${txid}`);
    const tx = res.data;

    if (!tx.status.confirmed) return null;

    const transfers: IndexedTransfer[] = [];
    let from: string | null = null;
    let to: string | null = null;
    let totalOut = 0n;

    for (const vin of tx.vin) {
      if (vin.prevout?.scriptpubkey_address) {
        transfers.push({
          kind: "utxo",
          asset: "BTC",
          from: vin.prevout.scriptpubkey_address,
          to: null,
          amount: formatUnits(BigInt(vin.prevout.value ?? 0), 8),
          decimals: 8
        });
        if (!from) from = vin.prevout.scriptpubkey_address;
      }
    }

    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address) {
        transfers.push({
          kind: "utxo",
          asset: "BTC",
          from: null,
          to: vout.scriptpubkey_address,
          amount: formatUnits(BigInt(vout.value ?? 0), 8),
          decimals: 8
        });
        totalOut += BigInt(vout.value ?? 0);
        if (!to) to = vout.scriptpubkey_address;
      }
    }

    return {
      chain: "bitcoin",
      txHash: tx.txid,
      blockHeight,
      blockTime,
      from,
      to,
      value: formatUnits(totalOut, 8),
      valueUsd: null,
      status: "confirmed",
      fee: tx.fee != null ? formatUnits(BigInt(tx.fee), 8) : null,
      transfers,
      raw: tx
    };
  } catch (err) {
    logger.warn("Failed to get transaction", { txid, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Export for direct use
export { http as bitcoinHttp };