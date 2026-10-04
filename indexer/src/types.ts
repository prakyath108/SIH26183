export type Chain = "bitcoin" | "ethereum" | "polygon" | "tron";

export type ChainMeta = {
  id: Chain;
  name: string;
  symbol: string;
  decimals: number;
  explorer: string;
};

export const CHAINS: Chain[] = ["bitcoin", "ethereum", "polygon", "tron"];

export const CHAIN_META: Record<Chain, ChainMeta> = {
  bitcoin: {
    id: "bitcoin",
    name: "Bitcoin",
    symbol: "BTC",
    decimals: 8,
    explorer: "https://mempool.space/tx/"
  },
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    explorer: "https://etherscan.io/tx/"
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    symbol: "MATIC",
    decimals: 18,
    explorer: "https://polygonscan.com/tx/"
  },
  tron: {
    id: "tron",
    name: "Tron",
    symbol: "TRX",
    decimals: 6,
    explorer: "https://tronscan.org/#/transaction/"
  }
};

export interface IndexedTransaction {
  chain: Chain;
  txHash: string;
  blockHeight: number;
  blockTime: number;
  from: string | null;
  to: string | null;
  value: string;
  valueUsd: number | null;
  fee: string | null;
  status: "confirmed" | "failed" | "pending";
  transfers: IndexedTransfer[];
  raw: unknown;
}

export interface IndexedTransfer {
  kind: "native" | "token" | "utxo";
  asset: string;
  from: string | null;
  to: string | null;
  amount: string;
  decimals: number;
  contract?: string | null;
  logIndex?: number | null;
}

export interface IndexedAddress {
  chain: Chain;
  address: string;
  firstSeen: number;
  lastSeen: number;
  txCount: number;
  receivedTotal: string;
  sentTotal: string;
  balance: string | null;
}

export interface IndexerState {
  chain: Chain;
  lastIndexedBlock: number;
  lastIndexedTime: number;
  isIndexing: boolean;
}

export interface RpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: T;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface EthBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  transactions: EthTx[];
}

export interface EthTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  gas: string;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce: string;
  blockNumber: string;
  transactionIndex: string;
  status?: string;
  input: string;
  logs?: EthLog[];
}

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
}

export interface TronBlock {
  blockID: string;
  block_header: {
    raw_data: {
      number: number;
      timestamp: number;
      witness_address: string;
      parentHash: string;
    };
  };
  transactions: TronTx[];
}

export interface TronTx {
  txID: string;
  raw_data: {
    contract: Array<{
      type: string;
      parameter: {
        value: {
          owner_address: string;
          to_address?: string;
          amount?: number;
          contract_address?: string;
          data?: string;
        };
        type_url: string;
      };
    }>;
    timestamp: number;
  };
  ret: Array<{ contractRet: string }>;
}

export interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  fee?: number;
  vin: Array<{
    txid?: string;
    vout?: number;
    is_coinbase?: boolean;
    prevout?: { scriptpubkey_address?: string; value?: number };
  }>;
  vout: Array<{
    scriptpubkey_type?: string;
    scriptpubkey_address?: string;
    value?: number;
  }>;
}