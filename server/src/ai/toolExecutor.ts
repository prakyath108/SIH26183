import { z } from "zod";
import { one, many, type Db } from "../db/index.js";
import { adapterFor } from "../chains/index.js";
import { trace } from "../trace/tracer.js";
import { logger } from "../logger.js";
import { toolSchemas, type ToolName } from "./tools.js";

/**
 * Execute an AI tool with the given arguments.
 * This is the server-side implementation that the AI can call.
 */
export async function executeTool(
  db: Db,
  caseId: string,
  userId: string,
  toolName: ToolName,
  args: unknown
): Promise<unknown> {
  const schema = toolSchemas[toolName];
  if (!schema) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Validate input
  const parsed = schema.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${toolName}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
  }
  const validatedArgs = parsed.data;

  try {
    let result: unknown;

    switch (toolName) {
      case "lookup_address": {
        const { address, chain } = validatedArgs as z.infer<typeof toolSchemas.lookup_address.inputSchema>;
        if (chain) {
          const adapter = adapterFor(chain);
          const addrInfo = await adapter.getAddress(address);
          result = {
            address,
            chain,
            normalized: addrInfo.address,
            balance: addrInfo.balance?.toString() ?? null,
            txCount: addrInfo.txCount ?? null,
            firstSeen: addrInfo.firstSeen ?? null,
            lastSeen: addrInfo.lastSeen ?? null,
            riskScore: null,
            riskLevel: null,
            labels: [],
            error: null
          };
        } else {
          const chains: ("bitcoin" | "ethereum" | "tron" | "polygon")[] = ["bitcoin", "ethereum", "tron", "polygon"];
          let found = false;
          for (const c of chains) {
            try {
              const adapter = adapterFor(c);
              const addrInfo = await adapter.getAddress(address);
              if (addrInfo.address) {
                result = {
                  address,
                  chain: c,
                  normalized: addrInfo.address,
                  balance: addrInfo.balance?.toString() ?? null,
                  txCount: addrInfo.txCount ?? null,
                  firstSeen: addrInfo.firstSeen ?? null,
                  lastSeen: addrInfo.lastSeen ?? null,
                  riskScore: null,
                  riskLevel: null,
                  labels: [],
                  error: null
                };
                found = true;
                break;
              }
            } catch {
              // Try next chain
            }
          }
          if (!found) {
            result = {
              address,
              chain: "bitcoin",
              normalized: address,
              balance: null,
              txCount: null,
              firstSeen: null,
              lastSeen: null,
              riskScore: null,
              riskLevel: null,
              labels: [],
              error: "Address not found on any supported chain"
            };
          }
        }
        break;
      }

      case "lookup_transaction": {
        const { txHash, chain } = validatedArgs as z.infer<typeof toolSchemas.lookup_transaction.inputSchema>;
        if (chain) {
          const adapter = adapterFor(chain);
          const tx = await adapter.getTransaction(txHash);
          if (!tx) {
            result = { error: "Transaction not found", chain, txHash, ...emptyTx() };
          } else {
            result = {
              txHash: tx.txHash,
              chain: tx.chain,
              blockHeight: tx.blockHeight,
              timestamp: tx.timestamp,
              from: tx.from,
              to: tx.to,
              valueNative: tx.valueNative,
              valueUsd: tx.valueUsd,
              status: tx.status,
              feeNative: tx.feeNative,
              transfers: tx.transfers?.map(t => ({
                kind: t.kind,
                asset: t.asset,
                from: t.from,
                to: t.to,
                amount: t.amount,
                decimals: t.decimals,
                contract: t.contract
              })) ?? [],
              error: null
            };
          }
        } else {
          const chains: ("bitcoin" | "ethereum" | "tron" | "polygon")[] = ["bitcoin", "ethereum", "tron", "polygon"];
          let found = false;
          for (const c of chains) {
            try {
              const adapter = adapterFor(c);
              const tx = await adapter.getTransaction(txHash);
              if (tx) {
                result = {
                  txHash: tx.txHash,
                  chain: tx.chain,
                  blockHeight: tx.blockHeight,
                  timestamp: tx.timestamp,
                  from: tx.from,
                  to: tx.to,
                  valueNative: tx.valueNative,
                  valueUsd: tx.valueUsd,
                  status: tx.status,
                  feeNative: tx.feeNative,
                  transfers: tx.transfers?.map(t => ({
                    kind: t.kind,
                    asset: t.asset,
                    from: t.from,
                    to: t.to,
                    amount: t.amount,
                    decimals: t.decimals,
                    contract: t.contract
                  })) ?? [],
                  error: null
                };
                found = true;
                break;
              }
            } catch {
              // Try next chain
            }
          }
          if (!found) {
            result = { error: "Transaction not found on any supported chain", chain: "bitcoin", txHash, ...emptyTx() };
          }
        }
        break;
      }

      case "trace_address": {
        const argsTyped = validatedArgs as z.infer<typeof toolSchemas.trace_address.inputSchema>;
        const graph = await trace(db, {
          chain: argsTyped.chain,
          rootAddress: argsTyped.address,
          direction: argsTyped.direction,
          amountToTrace: argsTyped.amountToTrace ?? null,
          asset: argsTyped.asset,
          method: argsTyped.method,
          maxHops: argsTyped.maxHops,
          maxNodes: argsTyped.maxNodes ?? 120,
          maxEdges: argsTyped.maxEdges ?? 150,
          offline: argsTyped.offline,
          maxCounterpartiesPerTx: argsTyped.maxCounterpartiesPerTx,
          persistCaseId: caseId,
          userId
        });
        result = { graph, error: null };
        break;
      }

      case "get_case_entities": {
        const entities = await many(db,
          `SELECT e.id, e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level,
                  e.first_seen, e.last_seen, ce.hop_count, ce.amount_usd
           FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
           WHERE ce.case_id = $1 ORDER BY e.risk_score DESC`,
          [caseId]
        );
        result = { entities, error: null };
        break;
      }

      case "get_case_transactions": {
        const argsTyped = validatedArgs as z.infer<typeof toolSchemas.get_case_transactions.inputSchema>;
        const transactions = await many(db,
          `SELECT t.tx_hash, t.chain, t.block_height, t.timestamp, t.from_address, t.to_address,
                  t.value_native, t.value_usd, t.status
           FROM transactions t
           JOIN case_transactions ct ON ct.transaction_id = t.id
           WHERE ct.case_id = $1 ORDER BY t.timestamp DESC LIMIT $2`,
          [caseId, argsTyped.limit ?? 200]
        );
        result = { transactions, error: null };
        break;
      }

      case "get_case_alerts": {
        const alerts = await many(db,
          `SELECT a.id, a.severity, a.category, a.title, a.detail, a.created_at,
                  e.address AS entity_address, e.chain AS entity_chain, a.risk_score
           FROM alerts a LEFT JOIN entities e ON e.id = a.entity_id
           WHERE a.case_id = $1 ORDER BY a.created_at DESC`,
          [caseId]
        );
        result = { alerts, error: null };
        break;
      }

      case "get_case_evidence": {
        const evidence = await many(db,
          `SELECT id, kind, title, description, content_sha256, collected_at,
                  address, tx_hash
           FROM evidence WHERE case_id = $1 ORDER BY collected_at DESC`,
          [caseId]
        );
        result = { evidence, error: null };
        break;
      }

      case "get_case_notes": {
        const argsTyped = validatedArgs as z.infer<typeof toolSchemas.get_case_notes.inputSchema>;
        let query = `SELECT n.id, n.body, n.kind, n.pinned, n.created_at, u.display_name AS author
                     FROM case_notes n LEFT JOIN users u ON u.id = n.author_id
                     WHERE n.case_id = $1`;
        const params: (string | string[])[] = [caseId];
        if (argsTyped.kind) {
          query += ` AND n.kind = $2`;
          params.push(argsTyped.kind);
        }
        query += ` ORDER BY n.created_at DESC`;
        const notes = await many(db, query, params);
        result = { notes, error: null };
        break;
      }

      case "get_case_traces": {
        const traces = await many(db,
          `SELECT id, chain, root_address, max_hops, direction, node_count, edge_count,
                  risk_score, risk_level, created_at
           FROM traces WHERE case_id = $1 ORDER BY created_at DESC`,
          [caseId]
        );
        result = { traces, error: null };
        break;
      }

      case "search_entities": {
        const argsTyped = validatedArgs as z.infer<typeof toolSchemas.search_entities.inputSchema>;
        const entities = await many(db,
          `SELECT id, chain, address, kind, label, risk_score, risk_level
           FROM entities
           WHERE (address ILIKE $1 OR label ILIKE $1)
             ${argsTyped.chain ? "AND chain = $2" : ""}
           ORDER BY risk_score DESC LIMIT $${argsTyped.chain ? 3 : 2}`,
          argsTyped.chain
            ? [`%${argsTyped.query}%`, argsTyped.chain, argsTyped.limit]
            : [`%${argsTyped.query}%`, argsTyped.limit]
        );
        result = { entities, error: null };
        break;
      }

      case "explain_node": {
        const argsTyped = validatedArgs as z.infer<typeof toolSchemas.explain_node.inputSchema>;
        const entity = await one(db,
          `SELECT e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level,
                  e.risk_factors, e.first_seen, e.last_seen, e.tx_count, ce.hop_count
           FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
           WHERE ce.case_id = $1 AND e.address = $2 AND e.chain = $3`,
          [caseId, argsTyped.address.toLowerCase(), argsTyped.chain]
        );
        if (!entity) {
          result = { error: "Entity not found in this case" };
        } else {
          result = {
            address: entity.address,
            chain: entity.chain,
            hopDistance: entity.hop_count,
            riskScore: entity.risk_score,
            riskLevel: entity.risk_level,
            riskFactors: entity.risk_factors ?? [],
            source: "added_by_trace_expansion",
            evidence: [],
            status: "known",
            error: null
          };
        }
        break;
      }

      case "explain_path": {
        const argsTyped = validatedArgs as z.infer<typeof toolSchemas.explain_path.inputSchema>;
        const pathResult = await explainPath(db, caseId, argsTyped.fromAddress, argsTyped.toAddress, argsTyped.chain);
        result = pathResult;
        break;
      }

      default:
        throw new Error(`Tool ${toolName} not implemented`);
    }

    // Validate output
    const outputParsed = schema.outputSchema.safeParse(result);
    if (!outputParsed.success) {
      logger.warn("Tool output validation failed", { tool: toolName, issues: outputParsed.error.issues });
    }

    return outputParsed.success ? outputParsed.data : result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("Tool execution failed", { tool: toolName, caseId, error });
    return { error };
  }
}

function emptyTx() {
  return {
    blockHeight: null,
    timestamp: null,
    from: null,
    to: null,
    valueNative: "0",
    valueUsd: null,
    status: "unknown",
    feeNative: null,
    transfers: []
  };
}

async function explainPath(
  db: Db,
  caseId: string,
  fromAddress: string,
  toAddress: string,
  chain: "bitcoin" | "ethereum" | "tron" | "polygon"
): Promise<{
  path: Array<{ from: string; to: string; txHash: string; valueNative: string; valueUsd: number | null; timestamp: string | null; hop: number }>;
  totalValueUsd: number;
  hopCount: number;
  evidence: string[];
  error: string | null;
}> {
  const traceRecord = await one<{ graph: unknown }>(
    db,
    `SELECT graph FROM traces WHERE case_id = $1 AND chain = $2 ORDER BY created_at DESC LIMIT 1`,
    [caseId, chain]
  );

  if (!traceRecord || !traceRecord.graph) {
    return { path: [], totalValueUsd: 0, hopCount: 0, evidence: [], error: "No trace graph found for this case and chain" };
  }

  const graph = traceRecord.graph as {
    nodes: Array<{ id: string; address: string }>;
    edges: Array<{ source: string; target: string; txHash: string; timestamp: string | null; valueNative: string; valueUsd: number | null; hop: number }>;
  };

  const adj = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const list = adj.get(edge.source) ?? [];
    list.push(edge);
    adj.set(edge.source, list);
  }

  const fromLower = fromAddress.toLowerCase();
  const toLower = toAddress.toLowerCase();

  const queue: Array<{ addr: string; path: typeof graph.edges }> = [{ addr: fromLower, path: [] }];
  const visited = new Set<string>([fromLower]);

  while (queue.length > 0) {
    const { addr, path } = queue.shift()!;

    if (addr === toLower) {
      const totalValueUsd = path.reduce((sum, e) => sum + (e.valueUsd ?? 0), 0);
      return {
        path: path.map((e) => ({
          from: e.source,
          to: e.target,
          txHash: e.txHash,
          valueNative: e.valueNative,
          valueUsd: e.valueUsd,
          timestamp: e.timestamp,
          hop: e.hop
        })),
        totalValueUsd,
        hopCount: path.length,
        evidence: path.map((e) => `Transaction ${e.txHash}: ${e.valueNative} (${e.valueUsd?.toFixed(2) ?? "N/A"} USD)`),
        error: null
      };
    }

    const edges = adj.get(addr) ?? [];
    for (const edge of edges) {
      if (!visited.has(edge.target.toLowerCase())) {
        visited.add(edge.target.toLowerCase());
        queue.push({ addr: edge.target.toLowerCase(), path: [...path, edge] });
      }
    }
  }

  return { path: [], totalValueUsd: 0, hopCount: 0, evidence: [], error: `No path found from ${fromAddress} to ${toAddress} in the trace graph` };
}