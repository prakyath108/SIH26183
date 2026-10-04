import type { Chain, TraceGraph } from "../types.js";
import { addDecimal, subDecimal } from "./decimal.js";

/**
 * Fund-flow ledger for amount conservation checks.
 * 
 * For every traced address and asset, maintains a ledger of:
 * - Timestamp
 * - Transaction
 * - Asset
 * - Direction (in/out)
 * - Source
 * - Destination
 * - Amount
 * - Balance impact
 * - Evidence reference
 * - Trace path
 * 
 * Supports amount conservation checks where possible.
 * If values do not reconcile, flags as PARTIAL_RECONCILIATION or DATA_LIMITATION.
 */

export interface LedgerEntry {
  timestamp: string | null;
  transactionHash: string;
  asset: string;
  assetIdentifier: string | null;
  direction: "in" | "out";
  source: string;
  destination: string;
  amountNative: string;
  amountUsd: number | null;
  decimals: number;
  balanceImpact: number;
  runningBalanceNative: string;
  runningBalanceUsd: number | null;
  evidenceRef: string;
  tracePath: string[];
  blockNumber: number | null;
  eventIndex: number | null;
}

export interface AddressLedger {
  address: string;
  chain: Chain;
  asset: string;
  assetIdentifier: string | null;
  decimals: number;
  entries: LedgerEntry[];
  totalInNative: string;
  totalOutNative: string;
  totalInUsd: number;
  totalOutUsd: number;
  finalBalanceNative: string;
  finalBalanceUsd: number | null;
  reconciliationStatus: "balanced" | "partial" | "data_limitation" | "unreconciled";
  discrepancyNative: string;
  discrepancyUsd: number | null;
  discrepancyReason: string | null;
}

export interface FundFlowLedger {
  rootAddress: string;
  chain: Chain;
  asset: string;
  assetIdentifier: string | null;
  decimals: number;
  addressLedgers: Map<string, AddressLedger>;
  overallStatus: "balanced" | "partial" | "data_limitation" | "unreconciled";
  totalDiscrepancyUsd: number | null;
  /**
   * `addressLedgers` is a Map, which has no `toJSON`. Without this method
   * `JSON.stringify` on the containing graph or trace snapshot produced
   * `addressLedgers: {}` and the entire reconciliation result was silently lost
   * on the way to the database. Emitting an array keyed by address keeps the
   * data while staying idiomatic JSON.
   */
  toJSON(): SerializedFundFlowLedger;
}

/** JSON-safe projection of {@link FundFlowLedger}. */
export interface SerializedFundFlowLedger
  extends Omit<FundFlowLedger, "addressLedgers" | "toJSON"> {
  addressLedgers: AddressLedger[];
}

/**
 * Fixed-point arithmetic lives in `./decimal.ts` and is shared with the fund
 * attribution engine, so a ledger total and an attributed share of the same
 * quantity cannot disagree.
 */
const addBN = addDecimal;
const subBN = subDecimal;

export function buildFundFlowLedger(graph: TraceGraph, asset: string = "native"): FundFlowLedger {
  const addressLedgers = new Map<string, AddressLedger>();
  
  const root = graph.root;
  const chain = graph.chain;
  
  for (const node of graph.nodes) {
    const addr = node.address.toLowerCase();
    
    const inEdges = graph.edges.filter(e => e.target.toLowerCase() === addr);
    const outEdges = graph.edges.filter(e => e.source.toLowerCase() === addr);
    
    const entries: LedgerEntry[] = [];
    let runningBalanceNative = "0";
    let runningBalanceUsd = 0;
    let totalInNative = "0";
    let totalOutNative = "0";
    let totalInUsd = 0;
    let totalOutUsd = 0;
    
    for (const edge of inEdges) {
      const valueNative = edge.valueNative || "0";
      const valueUsd = edge.valueUsd ?? null;
      
      totalInNative = addBN(totalInNative, valueNative);
      if (valueUsd !== null) totalInUsd += valueUsd;
      
      runningBalanceNative = addBN(runningBalanceNative, valueNative);
      if (valueUsd !== null) runningBalanceUsd += valueUsd;
      
      entries.push({
        timestamp: edge.timestamp,
        transactionHash: edge.txHash,
        asset,
        assetIdentifier: null,
        direction: "in",
        source: edge.source,
        destination: edge.target,
        amountNative: valueNative,
        amountUsd: valueUsd,
        decimals: 18,
        balanceImpact: valueUsd ?? 0,
        runningBalanceNative,
        runningBalanceUsd: valueUsd !== null ? runningBalanceUsd : null,
        evidenceRef: `tx:${edge.txHash}`,
        tracePath: [edge.source, edge.target],
        blockNumber: null,
        eventIndex: null
      });
    }
    
    for (const edge of outEdges) {
      const valueNative = edge.valueNative || "0";
      const valueUsd = edge.valueUsd ?? null;
      
      totalOutNative = addBN(totalOutNative, valueNative);
      if (valueUsd !== null) totalOutUsd += valueUsd;
      
      runningBalanceNative = subBN(runningBalanceNative, valueNative);
      if (valueUsd !== null) runningBalanceUsd -= valueUsd;
      
      entries.push({
        timestamp: edge.timestamp,
        transactionHash: edge.txHash,
        asset,
        assetIdentifier: null,
        direction: "out",
        source: edge.source,
        destination: edge.target,
        amountNative: valueNative,
        amountUsd: valueUsd,
        decimals: 18,
        balanceImpact: valueUsd ? -valueUsd : 0,
        runningBalanceNative,
        runningBalanceUsd: valueUsd !== null ? runningBalanceUsd : null,
        evidenceRef: `tx:${edge.txHash}`,
        tracePath: [edge.source, edge.target],
        blockNumber: null,
        eventIndex: null
      });
    }
    
    const isRoot = addr === root.toLowerCase();
    let reconciliationStatus: AddressLedger["reconciliationStatus"] = "balanced";
    let discrepancyNative = "0";
    let discrepancyUsd: number | null = null;
    let discrepancyReason: string | null = null;
    
    if (!isRoot) {
      const hasLiveData = entries.some(e => e.amountUsd !== null && e.amountUsd > 0);
      const hasLabel = node.factors && node.factors.length > 0;
      
      if (!hasLiveData && !hasLabel) {
        reconciliationStatus = "data_limitation";
        discrepancyReason = "No live transaction data or attribution labels available";
      } else if (hasLiveData && !hasLabel) {
        reconciliationStatus = "partial";
        discrepancyReason = "Transaction data available but no attribution labels";
      }
      
      const inCount = inEdges.length;
      const outCount = outEdges.length;
      if (inCount === 0 && outCount === 0) {
        reconciliationStatus = "unreconciled";
        discrepancyReason = "No transaction edges found for this address in the trace";
      }
    }
    
    if (reconciliationStatus !== "balanced") {
      const netFlow = subBN(totalInNative, totalOutNative);
      discrepancyNative = netFlow;
      discrepancyUsd = totalInUsd - totalOutUsd;
    }
    
    addressLedgers.set(addr, {
      address: node.address,
      chain,
      asset,
      assetIdentifier: null,
      decimals: 18,
      entries,
      totalInNative,
      totalOutNative,
      totalInUsd,
      totalOutUsd,
      finalBalanceNative: runningBalanceNative,
      finalBalanceUsd: runningBalanceUsd,
      reconciliationStatus,
      discrepancyNative,
      discrepancyUsd,
      discrepancyReason
    });
  }
  
  const statuses = [...addressLedgers.values()].map(l => l.reconciliationStatus);
  const hasUnreconciled = statuses.includes("unreconciled");
  const hasDataLimitation = statuses.includes("data_limitation");
  const hasPartial = statuses.includes("partial");
  
  let overallStatus: FundFlowLedger["overallStatus"] = "balanced";
  if (hasUnreconciled) overallStatus = "unreconciled";
  else if (hasDataLimitation) overallStatus = "data_limitation";
  else if (hasPartial) overallStatus = "partial";
  
  const totalDiscrepancyUsd = [...addressLedgers.values()]
    .reduce((sum, l) => sum + (l.discrepancyUsd ?? 0), 0);
  
  return {
    rootAddress: root,
    chain,
    asset,
    assetIdentifier: null,
    decimals: 18,
    addressLedgers,
    overallStatus,
    totalDiscrepancyUsd,
    toJSON(): SerializedFundFlowLedger {
      return {
        rootAddress: root,
        chain,
        asset,
        assetIdentifier: null,
        decimals: 18,
        addressLedgers: [...addressLedgers.values()],
        overallStatus,
        totalDiscrepancyUsd
      };
    }
  };
}

export function formatLedgerForReport(ledger: FundFlowLedger): string[] {
  const lines: string[] = [];
  
  lines.push(`FUND-FLOW LEDGER: ${ledger.rootAddress} (${ledger.chain})`);
  lines.push(`Asset: ${ledger.asset} | Overall Status: ${ledger.overallStatus.toUpperCase()}`);
  if (ledger.totalDiscrepancyUsd !== null && ledger.totalDiscrepancyUsd !== 0) {
    lines.push(`Total Discrepancy: USD ${ledger.totalDiscrepancyUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  lines.push("");
  
  for (const [addr, al] of ledger.addressLedgers) {
    const isRoot = addr === ledger.rootAddress.toLowerCase();
    lines.push(`${isRoot ? "ROOT " : ""}${shortAddr(addr)} (hop ${al.entries[0] ? "0" : "?"})`);
    lines.push(`  In:  ${al.totalInNative} native (${al.totalInUsd > 0 ? `USD ${al.totalInUsd.toLocaleString()}` : "not priced"})`);
    lines.push(`  Out: ${al.totalOutNative} native (${al.totalOutUsd > 0 ? `USD ${al.totalOutUsd.toLocaleString()}` : "not priced"})`);
    lines.push(`  Final Balance: ${al.finalBalanceNative} native (${al.finalBalanceUsd !== null ? `USD ${al.finalBalanceUsd.toLocaleString()}` : "not priced"})`);
    lines.push(`  Reconciliation: ${al.reconciliationStatus.toUpperCase()}${al.discrepancyReason ? ` - ${al.discrepancyReason}` : ""}`);
    if (al.discrepancyNative !== "0") {
      lines.push(`  Discrepancy: ${al.discrepancyNative} native (${al.discrepancyUsd !== null ? `USD ${al.discrepancyUsd.toLocaleString()}` : "not priced"})`);
    }
    lines.push("");
    
    for (const entry of al.entries.slice(0, 20)) {
      const dir = entry.direction === "in" ? "IN" : "OUT";
      const value = entry.amountUsd !== null ? `USD ${entry.amountUsd.toLocaleString()}` : `${entry.amountNative} native`;
      lines.push(`    ${dir} ${value} <- ${shortAddr(entry.source)} -> ${shortAddr(entry.destination)} [${entry.transactionHash.slice(0, 10)}...]`);
    }
    if (al.entries.length > 20) {
      lines.push(`    ... and ${al.entries.length - 20} more entries`);
    }
    lines.push("");
  }
  
  return lines;
}

function shortAddr(address: string): string {
  return address.length <= 20 ? address : `${address.slice(0, 12)}...${address.slice(-8)}`;
}