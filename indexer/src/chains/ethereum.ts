import axios from "axios";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { getIndexerState, setIndexerState, storeTransactions, storeBlock } from "../db.js";
import { formatUnits } from "../units.js";
import type { Chain, IndexedTransaction, IndexedTransfer, EthBlock, EthTx, EthLog, RpcRequest, RpcResponse } from "../types.js";

interface EthClient {
  rpcUrl: string;
  chain: Chain;
  symbol: string;
  decimals: number;
}

const ETHEREUM_CLIENT: EthClient = {
  rpcUrl: env.ETH_RPC_URL,
  chain: "ethereum",
  symbol: "ETH",
  decimals: 18
};

const POLYGON_CLIENT: EthClient = {
  rpcUrl: env.POLYGON_RPC_URL,
  chain: "polygon",
  symbol: "MATIC",
  decimals: 18
};

const http = axios.create({
  timeout: 30000,
  headers: { "Content-Type": "application/json", "User-Agent": "CryptoTrace-Indexer/1.0" }
});

let rpcId = 0;

async function rpcCall<T>(client: EthClient, method: string, params: unknown[]): Promise<T> {
  const id = ++rpcId;
  const payload: RpcRequest = { jsonrpc: "2.0", id, method, params };
  const res = await http.post<RpcResponse<T>>(client.rpcUrl, payload);
  if (res.data.error) throw new Error(`RPC error: ${res.data.error.message}`);
  return res.data.result as T;
}

async function getBlockNumber(client: EthClient): Promise<number> {
  const result = await rpcCall<string>(client, "eth_blockNumber", []);
  return parseInt(result, 16);
}

async function getBlockByNumber(client: EthClient, blockNumber: number, fullTxs = true): Promise<EthBlock | null> {
  const hex = "0x" + blockNumber.toString(16);
  const result = await rpcCall<EthBlock | null>(client, "eth_getBlockByNumber", [hex, fullTxs]);
  return result;
}

async function getTransactionReceipt(client: EthClient, txHash: string): Promise<{ status: string; logs: EthLog[] } | null> {
  const result = await rpcCall<{ status: string; logs: EthLog[] } | null>(client, "eth_getTransactionReceipt", [txHash]);
  return result;
}

function parseEthValue(value: string, decimals: number): string {
  return formatUnits(BigInt(value), decimals);
}

function parseEthTx(tx: EthTx, receipt: { status: string; logs: EthLog[] } | null, client: EthClient): IndexedTransaction {
  const transfers: IndexedTransfer[] = [];
  const value = parseEthValue(tx.value, client.decimals);

  // Native transfer
  if (BigInt(tx.value) > 0n) {
    transfers.push({
      kind: "native",
      asset: client.symbol,
      from: tx.from.toLowerCase(),
      to: tx.to?.toLowerCase() ?? null,
      amount: value,
      decimals: client.decimals
    });
  }

  // ERC-20 transfers from logs
  if (receipt?.logs) {
    for (const log of receipt.logs) {
      if (log.topics.length >= 3 && log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
        // Transfer(address,address,uint256)
        const from = "0x" + log.topics[1].slice(26);
        const to = "0x" + log.topics[2].slice(26);
        const amount = formatUnits(BigInt(log.data), 18);
        transfers.push({
          kind: "token",
          asset: log.address.toLowerCase(),
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          amount,
          decimals: 18, // Would need to query token contract for actual decimals
          contract: log.address.toLowerCase(),
          logIndex: parseInt(log.logIndex, 16)
        });
      }
    }
  }

  const status = receipt?.status === "0x1" ? "confirmed" : "failed";

  return {
    chain: client.chain,
    txHash: tx.hash,
    blockHeight: parseInt(tx.blockNumber, 16),
    blockTime: 0, // Will be filled by block timestamp
    from: tx.from.toLowerCase(),
    to: tx.to?.toLowerCase() ?? null,
    value: value,
    valueUsd: null,
    status,
    fee: null, // Would need gasUsed * effectiveGasPrice
    transfers,
    raw: { tx, receipt }
  };
}

export async function indexEthereum(): Promise<void> {
  await indexEvmChain(ETHEREUM_CLIENT);
}

export async function indexPolygon(): Promise<void> {
  await indexEvmChain(POLYGON_CLIENT);
}

async function indexEvmChain(client: EthClient): Promise<void> {
  const chain = client.chain;
  const state = await getIndexerState(chain);

  if (state.isIndexing) {
    logger.debug(`${chain} indexer already running`);
    return;
  }

  await setIndexerState(chain, { isIndexing: true });

  try {
    const latestBlock = await getBlockNumber(client);
    const targetBlock = latestBlock - env.REORG_DEPTH;

    if (state.lastIndexedBlock >= targetBlock) {
      logger.debug(`${chain} indexer caught up`, { current: state.lastIndexedBlock, target: targetBlock });
      return;
    }

    const startBlock = state.lastIndexedBlock + 1;
    const endBlock = Math.min(startBlock + env.INDEX_BATCH_SIZE - 1, targetBlock);

    logger.info(`Indexing ${chain} blocks`, { start: startBlock, end: endBlock });

    for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
      await indexEvmBlock(client, blockNum);
    }

    await setIndexerState(chain, { lastIndexedBlock: endBlock, lastIndexedTime: Date.now() });
  } catch (err) {
    logger.error(`${chain} indexing failed`, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    await setIndexerState(chain, { isIndexing: false });
  }
}

async function indexEvmBlock(client: EthClient, blockNumber: number): Promise<void> {
  try {
    const block = await getBlockByNumber(client, blockNumber, true);
    if (!block) throw new Error(`Block ${blockNumber} not found`);

    const blockTime = parseInt(block.timestamp, 16);
    const txs: IndexedTransaction[] = [];

    for (const tx of block.transactions) {
      try {
        const receipt = await getTransactionReceipt(client, tx.hash);
        const indexed = parseEthTx(tx, receipt, client);
        indexed.blockTime = blockTime;
        txs.push(indexed);
      } catch (err) {
        logger.warn("Failed to index transaction", { txHash: tx.hash, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (txs.length > 0) {
      await storeTransactions(txs);
    }

    await storeBlock(client.chain, blockNumber, block.hash, blockTime, block.transactions.length);
  } catch (err) {
    logger.error(`Failed to index ${client.chain} block`, { blockNumber, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// Export for direct use
export { http as ethHttp, rpcCall };