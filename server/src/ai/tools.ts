import { z } from "zod";

/**
 * Controlled backend tools for the AI Investigator.
 * Each tool is a typed function the AI can call with structured input/output.
 * The server executes these and returns results to the AI.
 */

export const toolSchemas = {
  /**
   * Look up a blockchain address across all supported chains.
   * Returns normalized address, chain, balance, transaction count, and risk score if available.
   */
  lookup_address: {
    name: "lookup_address",
    description: "Look up a blockchain address. Returns address info, chain, balance, tx count, risk score, and any labels.",
    inputSchema: z.object({
      address: z.string().max(200).describe("The blockchain address to look up."),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]).optional().describe("Optional chain hint. If omitted, all chains are checked.")
    }),
    outputSchema: z.object({
      address: z.string(),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
      normalized: z.string(),
      balance: z.string().nullable(),
      txCount: z.number().nullable(),
      firstSeen: z.string().nullable(),
      lastSeen: z.string().nullable(),
      riskScore: z.number().nullable(),
      riskLevel: z.enum(["Critical", "High", "Medium", "Low", "Unrated"]).nullable(),
      labels: z.array(z.object({
        name: z.string(),
        kind: z.string(),
        source: z.string(),
        confidence: z.enum(["low", "medium", "high"])
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Look up a transaction by hash.
   * Returns transaction details including transfers, value, status, and timestamp.
   */
  lookup_transaction: {
    name: "lookup_transaction",
    description: "Look up a transaction by hash. Returns transaction details, transfers, and value.",
    inputSchema: z.object({
      txHash: z.string().max(200).describe("The transaction hash to look up."),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]).optional().describe("Optional chain hint. If omitted, all chains are checked.")
    }),
    outputSchema: z.object({
      txHash: z.string(),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
      blockHeight: z.number().nullable(),
      timestamp: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      valueNative: z.string(),
      valueUsd: z.number().nullable(),
      status: z.enum(["confirmed", "failed", "pending", "unknown"]),
      feeNative: z.string().nullable(),
      transfers: z.array(z.object({
        kind: z.enum(["native", "token", "utxo"]),
        asset: z.string(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        amount: z.string(),
        decimals: z.number(),
        contract: z.string().nullable()
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Trace an address forward/backward/both directions.
   * Returns a graph with nodes, edges, and risk assessment.
   */
  trace_address: {
    name: "trace_address",
    description:
      "Trace where funds went from an address. Optionally follow one specific quantity, which produces an attributed graph with amount reconciliation. Returns nodes, edges, per-edge evidence status, risk scores, and truncation info.",
    inputSchema: z.object({
      address: z.string().max(200).describe("The root address to trace from."),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]).describe("The blockchain network."),
      direction: z.enum(["forward", "backward", "both"]).default("forward").describe("Trace direction: forward = outbound, backward = inbound, both = both."),
      amountToTrace: z
        .string()
        .regex(/^\d+(\.\d+)?$/, "Must be a plain positive decimal string, e.g. \"12.5\"")
        .optional()
        .describe(
          "Quantity to follow, as a decimal string. Omit to trace every observed movement instead. When set, the result is attributed against this quantity and reconciled against it."
        ),
      asset: z.string().max(16).optional().describe("Asset the quantity is denominated in, e.g. ETH. Defaults to the chain's native asset."),
      method: z
        .enum(["direct", "fifo", "pro_rata", "haircut", "poison"])
        .optional()
        .describe(
          "How to apportion the quantity when funds split. pro_rata conserves the total. direct refuses to guess. poison deliberately over-attributes and must not be used for totals."
        ),
      maxHops: z.number().int().min(1).max(6).default(3).describe("Maximum hop depth (1-6)."),
      maxNodes: z.number().int().min(5).max(300).default(120).describe("Maximum nodes in the graph."),
      maxEdges: z.number().int().min(10).max(500).default(150).describe("Maximum edges in the graph."),
      offline: z.boolean().default(false).describe("If true, use only stored records (no live chain calls)."),
      maxCounterpartiesPerTx: z.number().int().min(2).max(100).default(20).describe("Max counterparties per transaction per hop.")
    }),
    outputSchema: z.object({
      graph: z.object({
        root: z.string(),
        chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
        maxHops: z.number(),
        direction: z.enum(["forward", "backward", "both"]),
nodes: z.array(z.object({
            id: z.string(),
            address: z.string(),
            chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
            kind: z.string(),
            label: z.string().nullable(),
            riskScore: z.number(),
            riskLevel: z.enum(["Critical", "High", "Medium", "Low", "Unrated"]),
            hopDistance: z.number(),
            status: z.enum(["known", "verified", "unknown", "unresolved", "partial", "truncated", "unsupported", "unavailable"]).optional(),
            statusReason: z.string().optional()
          })),
        edges: z.array(z.object({
          id: z.string(),
          source: z.string(),
          target: z.string(),
          txHash: z.string(),
          timestamp: z.string().nullable(),
          valueNative: z.string(),
          valueUsd: z.number().nullable(),
          hop: z.number()
        })),
        totals: z.object({
          valueInUsd: z.number(),
          valueOutUsd: z.number(),
          nodeCount: z.number(),
          edgeCount: z.number(),
          truncated: z.boolean(),
          truncatedReasons: z.array(z.string())
        }),
        riskScore: z.number(),
        riskLevel: z.enum(["Critical", "High", "Medium", "Low", "Unrated"]),
        traceId: z.string().nullable()
      }),
      error: z.string().nullable()
    })
  },

  /**
   * Get stored entities for a case.
   */
  get_case_entities: {
    name: "get_case_entities",
    description: "Get all entities attached to a case with their risk scores, hop counts, and labels.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID.")
    }),
    outputSchema: z.object({
      entities: z.array(z.object({
        id: z.string(),
        chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
        address: z.string(),
        kind: z.string(),
        label: z.string().nullable(),
        riskScore: z.number(),
        riskLevel: z.enum(["Critical", "High", "Medium", "Low", "Unrated"]),
        hopCount: z.number(),
        amountUsd: z.string().nullable(),
        firstSeen: z.string().nullable(),
        lastSeen: z.string().nullable()
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Get transactions for a case.
   */
  get_case_transactions: {
    name: "get_case_transactions",
    description: "Get transactions linked to a case with value, timestamp, and asset info.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID."),
      limit: z.number().int().min(1).max(500).default(200)
    }),
    outputSchema: z.object({
      transactions: z.array(z.object({
        txHash: z.string(),
        chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
        blockHeight: z.number().nullable(),
        timestamp: z.string().nullable(),
        fromAddress: z.string().nullable(),
        toAddress: z.string().nullable(),
        valueNative: z.string(),
        valueUsd: z.number().nullable(),
        status: z.string().nullable()
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Get alerts for a case.
   */
  get_case_alerts: {
    name: "get_case_alerts",
    description: "Get alerts raised for a case with severity, category, and linked entities.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID.")
    }),
    outputSchema: z.object({
      alerts: z.array(z.object({
        id: z.string(),
        severity: z.enum(["critical", "high", "medium", "low", "info"]),
        category: z.string(),
        title: z.string(),
        detail: z.string().nullable(),
        createdAt: z.string(),
        entityAddress: z.string().nullable(),
        entityChain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]).nullable(),
        riskScore: z.number().nullable()
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Get evidence for a case.
   */
  get_case_evidence: {
    name: "get_case_evidence",
    description: "Get evidence items for a case with SHA-256 seals and metadata.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID.")
    }),
    outputSchema: z.object({
      evidence: z.array(z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        contentSha256: z.string(),
        collectedAt: z.string(),
        address: z.string().nullable(),
        txHash: z.string().nullable()
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Get notes for a case.
   */
  get_case_notes: {
    name: "get_case_notes",
    description: "Get analyst notes for a case, including hypotheses and findings.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID."),
      kind: z.enum(["note", "hypothesis", "finding", "status"]).optional()
    }),
    outputSchema: z.object({
      notes: z.array(z.object({
        id: z.string(),
        body: z.string(),
        kind: z.enum(["note", "hypothesis", "finding", "status"]),
        pinned: z.boolean(),
        createdAt: z.string(),
        author: z.string().nullable()
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Get trace history for a case.
   */
  get_case_traces: {
    name: "get_case_traces",
    description: "Get trace runs for a case with graph stats and risk scores.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID.")
    }),
    outputSchema: z.object({
      traces: z.array(z.object({
        id: z.string(),
        chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
        rootAddress: z.string(),
        maxHops: z.number(),
        direction: z.enum(["forward", "backward", "both"]),
        nodeCount: z.number(),
        edgeCount: z.number(),
        riskScore: z.number(),
        riskLevel: z.enum(["Critical", "High", "Medium", "Low", "Unrated"]),
        createdAt: z.string(),
        traceId: z.string().nullable()
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Search for entities by partial address or label.
   */
  search_entities: {
    name: "search_entities",
    description: "Search the entity register by partial address, label, or chain.",
    inputSchema: z.object({
      query: z.string().min(3).max(200).describe("Partial address, label, or chain to search for."),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]).optional(),
      limit: z.number().int().min(1).max(100).default(20)
    }),
    outputSchema: z.object({
      entities: z.array(z.object({
        id: z.string(),
        chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
        address: z.string(),
        kind: z.string(),
        label: z.string().nullable(),
        riskScore: z.number(),
        riskLevel: z.enum(["Critical", "High", "Medium", "Low", "Unrated"])
      })),
      error: z.string().nullable()
    })
  },

  /**
   * Explain a graph node - why it's in the graph, its risk factors, and evidence.
   */
  explain_node: {
    name: "explain_node",
    description: "Explain why a node is in the graph, its risk factors, source, and evidence.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID."),
      address: z.string().max(200).describe("The address to explain."),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"])
    }),
    outputSchema: z.object({
      address: z.string(),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
      hopDistance: z.number(),
      riskScore: z.number(),
      riskLevel: z.enum(["Critical", "High", "Medium", "Low", "Unrated"]),
      riskFactors: z.array(z.object({
        code: z.string(),
        label: z.string(),
        weight: z.number(),
        confidence: z.number(),
        detail: z.string(),
        source: z.string(),
        limitations: z.string().optional()
      })),
      source: z.enum(["extracted_from_document", "discovered_through_transaction", "discovered_through_token_event", "added_by_trace_expansion", "added_by_cross_chain_relation", "added_by_attribution", "manual"]),
      evidence: z.array(z.object({
        type: z.enum(["document", "transaction", "token_event", "label", "analyst_note"]),
        reference: z.string(),
        description: z.string()
      })),
      status: z.enum(["known", "verified", "unknown", "unresolved", "partial", "truncated", "unsupported", "unavailable"]).optional(),
      statusReason: z.string().optional(),
      error: z.string().nullable()
    })
  },

  /**
   * Explain a path between two addresses.
   */
  explain_path: {
    name: "explain_path",
    description: "Explain the path between two addresses in the trace graph.",
    inputSchema: z.object({
      caseId: z.string().uuid().describe("The case UUID."),
      fromAddress: z.string().max(200).describe("Source address."),
      toAddress: z.string().max(200).describe("Destination address."),
      chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"])
    }),
    outputSchema: z.object({
      path: z.array(z.object({
        from: z.string(),
        to: z.string(),
        txHash: z.string(),
        valueNative: z.string(),
        valueUsd: z.number().nullable(),
        timestamp: z.string().nullable(),
        hop: z.number()
      })),
      totalValueUsd: z.number(),
      hopCount: z.number(),
      evidence: z.array(z.string()),
      error: z.string().nullable()
    })
  }
} as const;

export type ToolName = keyof typeof toolSchemas;
export type ToolInput<T extends ToolName> = z.infer<typeof toolSchemas[T]["inputSchema"]>;
export type ToolOutput<T extends ToolName> = z.infer<typeof toolSchemas[T]["outputSchema"]>;

/**
 * Generate the tool definitions for OpenAI function calling.
 */
export function getToolDefinitions(): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  const defs: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> = [];

  for (const [name, schema] of Object.entries(toolSchemas)) {
    defs.push({
      type: "function",
      function: {
        name,
        description: schema.description,
        parameters: schema.inputSchema as unknown as Record<string, unknown>
      }
    });
  }

  return defs;
}