import axios from "axios";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { getIndexerState, setIndexerState, storeTransactions, storeBlock } from "../db.js";
import type { Chain, IndexedTransaction, IndexedTransfer } from "../types.js";

const http = axios.create({
  baseURL: env.TRONGRID_API,
  timeout: 15000,
  headers: {
    "User-Agent": "CryptoTrace-Indexer/1.0",
    ...(env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": env.TRONGRID_API_KEY } : {})
  }
});

export async function indexTron(): Promise<void> {
  const chain: Chain = "tron";
  const state = await getIndexerState(chain);

  if (state.isIndexing) {
    logger.debug("Tron indexer already running");
    return;
  }

  await setIndexerState(chain, { isIndexing: true });

  try {
    // Get current block via POST
    const tipRes = await http.post(
      "/v1/blocks/latest",
      {},
      { headers: { "Accept": "application/json" } }
    );
    const latestBlock = tipRes.data?.block_header?.raw_data?.number;

    if (!latestBlock) throw new Error("Failed to get latest Tron block");

    const targetBlock = latestBlock - env.REORG_DEPTH;
    if (state.lastIndexedBlock >= targetBlock) {
      logger.debug("Tron indexer caught up", { current: state.lastIndexedBlock, target: targetBlock });
      return;
    }

    const startBlock = state.lastIndexedBlock + 1;
    const endBlock = Math.min(startBlock + env.INDEX_BATCH_SIZE - 1, targetBlock);

    logger.info("Indexing Tron blocks", { start: startBlock, end: endBlock });

    for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
      await indexTronBlock(blockNum);
    }

    await setIndexerState(chain, { lastIndexedBlock: endBlock, lastIndexedTime: Date.now() });
  } catch (err) {
    logger.error("Tron indexing failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    await setIndexerState(chain, { isIndexing: false });
  }
}

async function indexTronBlock(blockNumber: number): Promise<void> {
  try {
    const blockRes = await http.post(
      "/v1/blocks",
      { block_num: blockNumber },
      { headers: { "Accept": "application/json" } }
    );

    const block = blockRes.data;
    if (!block?.transactions?.length) return;

    const txs: IndexedTransaction[] = [];

    for (const tx of block.transactions) {
      try {
        const txData = await http.get(
          `/v1/tx/${tx.txID}`,
          { headers: { "Accept": "application/json" } }
        );

        const transfers: IndexedTransfer[] = [];

        const contracts = txData.data?.raw_data?.contract;
        if (contracts) {
          for (const contract of contracts) {
            if (contract.type && contract.type.includes("Transfer")) {
              const value = contract.parameter?.value?.amount ?? 0;
              transfers.push({
                kind: "native",
                asset: "TRX",
                from: contract.parameter?.value?.owner_address?.toLowerCase() ?? null,
                to: contract.parameter?.value?.to_address?.toLowerCase() ?? null,
                amount: String(value),
                decimals: 6
              });
            }
          }
        }

        txs.push({
          chain: "tron",
          txHash: tx.txID,
          blockHeight: blockNumber,
          blockTime: blockRes.data?.block_header?.raw_data?.timestamp,
          from: null,
          to: null,
          value: "",
          valueUsd: null,
          status: "confirmed",
          fee: null,
          transfers,
          raw: { blockNumber, txData: txData.data }
        });
      } catch (err) {
        logger.warn("Failed to index Tron tx", { txID: tx.txID, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (txs.length > 0) {
      await storeTransactions(txs);
    }

    await storeBlock("tron", blockNumber, block?.blockID ?? "unknown", block?.block_header?.raw_data?.timestamp ?? 0, block.transactions.length);
  } catch (err) {
    logger.error("Failed to index Tron block", { blockNumber, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}