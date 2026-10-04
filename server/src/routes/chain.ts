import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, badRequest, HttpError } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";
import { lookup, chainHealth, adapterFor, CHAIN_META } from "../chains/index.js";
import { ChainUnavailableError } from "../chains/base.js";
import { detect } from "../chains/detect.js";
import { trace, persistTrace } from "../trace/tracer.js";
import { buildDemoGraph, listDemoCases } from "../trace/demoCases.js";
import { labelsForAddresses, assessWithAdvisory } from "../risk/service.js";
import { logger } from "../logger.js";
import { CHAINS, type Chain } from "../types.js";
import { broadcastGlobal } from "../ws/index.js";

export const chainRouter = Router();
chainRouter.use(requireAuth);

const parseSchema = z.object({ input: z.string().min(4).max(200) });

chainRouter.get("/detect", (req: Request, res: Response) => {
  const { input } = parseSchema.parse(req.query);
  const det = detect(input);
  if (!det) {
    res.json({
      recognized: false,
      message:
        "Not recognised. Accepted formats: Bitcoin (base58, 1/3 prefix, or bc1 bech32), EVM (0x + 40 hex address or 0x + 64 hex hash), TRON (T + 33 base58)."
    });
    return;
  }
  res.json({ recognized: true, ...det, chainName: CHAIN_META[det.chain].name, explorer: CHAIN_META[det.chain].explorer });
});

chainRouter.get(
  "/health",
  requirePermission("case:read"),
  asyncRoute(async (_req: Request, res: Response) => {
    const health = await chainHealth();
    res.json({
      chains: health.map((h) => ({ ...h, name: CHAIN_META[h.chain].name, symbol: CHAIN_META[h.chain].symbol })),
      checkedAt: new Date().toISOString()
    });
  })
);

chainRouter.get("/supported", (_req: Request, res: Response) => {
  res.json({
    chains: CHAINS.map((c) => ({ id: c, ...CHAIN_META[c] })),
    note: "Public endpoints are used by default. Their availability and rate limits are outside our control; configure your own providers in Integrations for production use."
  });
});

chainRouter.get(
  "/lookup",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const { input } = parseSchema.parse(req.query);
    const chainHint = req.query.chain ? (z.string().parse(req.query.chain) as Chain) : undefined;
    const db = await getDb();

    try {
      const result = await lookup(input, chainHint);

      if (result.kind === "tx") {
        await persistTransaction(db, result.result, req.user!.id);
        return res.json({ kind: "tx", detection: result.detection, transaction: result.result });
      }

      const addr = result.result;
      const labels = await labelsForAddresses(db, addr.chain, [addr.address]);
      const assessment = await assessWithAdvisory({
        chain: addr.chain,
        address: addr.address,
        hopIntervals: [],
        consolidationRatio: null,
        counterpartyCount: 0,
        totalValueUsd: 0,
        bridgeCrossings: 0,
        labels
      });

      await db.query(
        `INSERT INTO entities (chain, address, kind, label, risk_score, risk_level, risk_factors, first_seen, last_seen, tx_count, volume_native)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (chain, address) DO UPDATE SET
           risk_score = EXCLUDED.risk_score, risk_level = EXCLUDED.risk_level,
           risk_factors = EXCLUDED.risk_factors, first_seen = EXCLUDED.first_seen,
           last_seen = EXCLUDED.last_seen, tx_count = EXCLUDED.tx_count,
           label = COALESCE(EXCLUDED.label, entities.label),
           volume_native = EXCLUDED.volume_native`,
        [
          addr.chain,
          addr.address.toLowerCase(),
          labels[0]?.kind ?? "unknown",
          labels[0]?.name ?? null,
          assessment.score,
          assessment.level,
          JSON.stringify(assessment.factors),
          addr.firstSeen,
          addr.lastSeen,
          addr.txCount,
          addr.balance
        ]
      );

      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "chain.lookup_address",
        entityType: "entity",
        entityId: addr.address.toLowerCase(),
        after: { chain: addr.chain },
        req
      });

      res.json({ kind: "address", detection: result.detection, address: addr, risk: assessment });
    } catch (err) {
      if (err instanceof ChainUnavailableError) {
        await audit(db, {
          actorId: req.user!.id,
          actorEmail: req.user!.email,
          action: "chain.lookup",
          entityType: "chain",
          outcome: "failure",
          after: { input: input.slice(0, 80), error: err.message },
          req
        });
        throw new HttpError(502, "chain_unavailable", err.message);
      }
      throw err;
    }
  })
);

async function persistTransaction(db: Awaited<ReturnType<typeof getDb>>, tx: unknown, userId: string): Promise<void> {
  const t = tx as {
    chain: Chain;
    txHash: string;
    blockHeight: number | null;
    timestamp: string | null;
    from: string | null;
    to: string | null;
    valueNative: string;
    valueUsd: number | null;
    status: string;
    feeNative: string | null;
    raw: unknown;
  };
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO transactions (chain, tx_hash, block_height, timestamp, from_address, to_address, value_native, value_usd, status, fee_native, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (chain, tx_hash) DO UPDATE SET
       block_height = EXCLUDED.block_height, timestamp = EXCLUDED.timestamp,
       from_address = EXCLUDED.from_address, to_address = EXCLUDED.to_address,
       value_native = EXCLUDED.value_native, status = EXCLUDED.status,
       fee_native = EXCLUDED.fee_native
     RETURNING id`,
    [
      t.chain,
      t.txHash,
      t.blockHeight,
      t.timestamp,
      t.from?.toLowerCase() ?? null,
      t.to?.toLowerCase() ?? null,
      t.valueNative,
      t.valueUsd,
      t.status,
      t.feeNative,
      JSON.stringify(t.raw)
    ]
  );
  if (!row) return;
  void userId;
}

chainRouter.get(
  "/transaction/:hash",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const hash = z.string().min(32).max(128).parse(req.params.hash);
    const chain = (req.query.chain ? z.string().parse(req.query.chain) : detect(hash)?.chain ?? "bitcoin") as Chain;
    const db = await getDb();

    const cached = await one(
      db,
      `SELECT * FROM transactions WHERE chain = $1 AND tx_hash = $2`,
      [chain, hash.toLowerCase()]
    );
    if (cached) {
      res.json({ source: "cache", transaction: cached });
      return;
    }

    try {
      const tx = await adapterFor(chain).getTransaction(hash);
      await persistTransaction(db, tx, req.user!.id);
      res.json({ source: "live", transaction: tx });
    } catch (err) {
      if (err instanceof ChainUnavailableError) throw new HttpError(502, "chain_unavailable", err.message);
      throw err;
    }
  })
);

chainRouter.get(
  "/address/:chain/:address/transactions",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const chain = z.enum(CHAINS as [string, ...string[]]).parse(req.params.chain) as Chain;
    const address = z.string().min(10).max(200).parse(req.params.address);
    const limit = z.coerce.number().int().min(1).max(50).default(25).parse(req.query.limit);
    const db = await getDb();

    const stored = await many(
      db,
      `SELECT * FROM transactions WHERE chain = $1 AND (from_address = $2 OR to_address = $2) ORDER BY timestamp DESC NULLS LAST LIMIT $3`,
      [chain, address.toLowerCase(), limit]
    );
    if (stored.length) {
      res.json({ source: "store", transactions: stored, note: "Served from our ingested records." });
      return;
    }

    try {
      const page = await adapterFor(chain).getTransactionsForAddress(address, { limit });
      for (const tx of page.transactions) await persistTransaction(db, tx, req.user!.id);
      res.json({
        source: "live",
        transactions: page.transactions,
        cursor: page.cursor,
        ...(chain === "ethereum" || chain === "polygon"
          ? {
              note: "Public EVM nodes do not index by address. For historical activity, configure an indexed provider under Integrations."
            }
          : {})
      });
    } catch (err) {
      if (err instanceof ChainUnavailableError) throw new HttpError(502, "chain_unavailable", err.message);
      throw err;
    }
  })
);

/** Decimal string, so a traced quantity is never rounded through a JS float. */
const decimalAmount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0, {
    message: "amountToTrace must be a positive number, e.g. \"12.5\""
  });

const traceSchema = z.object({
  caseId: z.string().uuid().nullish(),
  address: z.string().min(10).max(200).optional(),
  chain: z.enum(CHAINS as [string, ...string[]]).optional(),
  maxHops: z.coerce.number().int().min(1).max(6).default(3),
  maxEdges: z.coerce.number().int().min(5).max(500).default(150),
  maxNodes: z.coerce.number().int().min(5).max(300).default(120),
  direction: z.enum(["forward", "backward", "both"]).default("forward"),
  timeoutMs: z.coerce.number().int().min(2000).max(120000).default(45000),
  offline: z.boolean().default(false),
  maxCounterpartiesPerTx: z.coerce.number().int().min(2).max(100).default(20),
  maxStoredTxsPerAddress: z.coerce.number().int().min(10).max(1000).default(200),
  /**
   * Quantity to follow. Omitted or null traces every observed movement instead,
   * which is a different question and is labelled as such in the response.
   */
  amountToTrace: decimalAmount.nullish(),
  /** Asset the quantity is denominated in. Defaults to the chain's native asset. */
  asset: z.string().min(1).max(16).optional(),
  /** Attribution method for splits. Defaults to pro-rata, which conserves the total. */
  method: z.enum(["direct", "fifo", "pro_rata", "haircut", "poison"]).optional(),
  /** Runs a synthetic scenario instead of querying a chain. */
  demoCaseId: z.string().min(1).max(64).optional()
});

/**
 * Catalogue of synthetic scenarios.
 *
 * Read-only and unauthenticated-permission-gated like the rest of the chain
 * routes, so the UI can offer a demo before an investigator has traced anything.
 */
chainRouter.get(
  "/demo-cases",
  requirePermission("trace:run"),
  (_req: Request, res: Response) => {
    res.json({
      cases: listDemoCases(),
      // Stated in the payload as well as the UI, so a client cannot render a
      // demo result without having been told what it is.
      notice:
        "Every case below is simulated. Addresses, transactions, amounts, risk scores and reconciliation figures are synthetic and do not correspond to any real blockchain activity."
    });
  }
);

chainRouter.post(
  "/trace",
  requirePermission("trace:run"),  asyncRoute(async (req: Request, res: Response) => {
    const body = traceSchema.parse(req.body);
    const db = await getDb();
    const started = Date.now();

    // A demo case short-circuits every lookup: it is synthetic data, so querying
    // a chain for it would be both pointless and a route to presenting invented
    // results as observations.
    //
    // This runs before any address or case resolution on purpose. A demo has no
    // real address and no case row, so placing it after the "provide an address"
    // guard would reject every demo request before it was ever read.
    if (body.demoCaseId) {
      // The scenario's own quantity and method are the defaults; an explicit
      // amount or method overrides them so the same scenario can be asked a
      // different question.
      const graph = buildDemoGraph(body.demoCaseId, body.method, body.amountToTrace ?? undefined);
      if (!graph) throw badRequest(`Unknown demo case '${body.demoCaseId}'`);
      if (body.asset) graph.asset = body.asset.toUpperCase();

      // A demo case has no case row of its own, but attaching one to a real case
      // is legitimate: it lets a synthetic graph sit inside a case workspace for
      // training or walkthroughs. It is stored through the normal trace table, so
      // it keeps the `demo` flag, the `demo` evidence source on every edge and the
      // SIMULATED DATA caveat, and every reader that shows a graph shows those too.
      let traceId: string | null = null;
      if (body.caseId) {
        const target = await one<{ id: string }>(db, `SELECT id FROM cases WHERE id = $1`, [body.caseId]);
        if (!target) throw badRequest("Case not found");
        traceId = await persistTrace(db, graph, body.caseId, req.user!.id);
      }

      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "chain.trace.demo",
        entityType: "trace",
        entityId: graph.root,
        caseRef: body.caseId ?? null,
        after: {
          demoCaseId: body.demoCaseId,
          method: graph.method,
          amountToTrace: graph.amountToTrace,
          nodes: graph.totals.nodeCount,
          edges: graph.totals.edgeCount,
          traceId,
          durationMs: Date.now() - started
        },
        req
      });

      res.json({
        graph,
        meta: {
          durationMs: Date.now() - started,
          truncated: false,
          demo: true,
          demoCaseId: body.demoCaseId,
          traceId
        }
      });
      return;
    }

    let chain = body.chain as Chain | undefined;
    let address = body.address;

    if (body.caseId) {
      const c = await one<{ chain: string; case_ref: string }>(db, `SELECT chain, case_ref FROM cases WHERE id = $1`, [body.caseId]);
      if (!c) throw badRequest("Case not found");
      chain ??= c.chain as Chain;
    }

    // Fall back to the case's closest-to-source entity when no address was
    // passed. This has to run before the "no address" guard below, otherwise a
    // caseId-only request is rejected before its own seed is ever consulted.
    if (!address && body.caseId) {
      const seed = await one<{ address: string }>(
        db,
        `SELECT e.address FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
         WHERE ce.case_id = $1 ORDER BY ce.hop_count ASC LIMIT 1`,
        [body.caseId]
      );
      address = seed?.address ?? undefined;
    }

    if (!address) throw badRequest("Provide an address, or a caseId whose entities can seed the trace");

    if (!chain) {
      const det = detect(address);
      if (!det) throw badRequest("Could not determine chain from the address; pass `chain` explicitly");
      chain = det.chain;
    }

    let traceId: string | null = null;
    let progressSent = 0;

    const onProgress = async (state: { hop: number; frontier: number; nodes: number; edges: number }) => {
      progressSent++;
      const payload = {
        type: "trace_progress",
        traceId: traceId,
        hop: state.hop,
        frontier: state.frontier,
        nodes: state.nodes,
        edges: state.edges,
        progress: progressSent
      };
      broadcastGlobal(payload.type + "_" + traceId, payload);
    };

    const graph = await trace(db, {
      chain,
      rootAddress: address,
      maxHops: body.maxHops,
      maxEdges: body.maxEdges,
      maxNodes: body.maxNodes,
      direction: body.direction,
      timeoutMs: body.timeoutMs,
      offline: body.offline,
      maxCounterpartiesPerTx: body.maxCounterpartiesPerTx,
      maxStoredTxsPerAddress: body.maxStoredTxsPerAddress,
      amountToTrace: body.amountToTrace ?? null,
      asset: body.asset,
      method: body.method,
      persistCaseId: body.caseId ?? null,
      userId: req.user!.id,
      onProgress
    });

    if (body.caseId) {
      const persisted = await persistTrace(db, graph, body.caseId, req.user!.id);
      traceId = persisted ?? null;
    }

logger.info("Trace completed", { chain, address, nodes: graph.totals.nodeCount, edges: graph.totals.edgeCount, traceId });

    // Broadcast trace completion via WebSocket so frontends can update their graph
    const traceCompletion = {
      type: "trace_complete",
      traceId: traceId || `ad-hoc-${Date.now()}`,
      hop: body.maxHops ?? 3,
      nodes: graph.totals.nodeCount,
      edges: graph.totals.edgeCount,
      amountToTrace: graph.amountToTrace ?? null,
      asset: graph.asset,
      reconciliation: graph.reconciliation
    };
    broadcastGlobal("trace_complete_" + traceId, traceCompletion);

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "chain.trace",
      entityType: "trace",
      entityId: address,
      caseRef: body.caseId ?? null,
      after: {
        chain,
        maxHops: body.maxHops,
        // Recorded so a reviewer can tell a bounded traversal from an amount
        // investigation, which are different exercises with different limits.
        amountToTrace: graph.amountToTrace ?? null,
        method: graph.method ?? null,
        reconciliationStatus: graph.reconciliation?.status ?? null,
        nodes: graph.totals.nodeCount,
        edges: graph.totals.edgeCount,
        riskScore: graph.riskScore,
        truncated: graph.totals.truncated,
        durationMs: Date.now() - started
      },
      req
    });

    res.json({ graph, meta: { durationMs: Date.now() - started, truncated: graph.totals.truncated } });
  })
);

chainRouter.get(
  "/traces/:id",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const id = z.string().uuid().parse(req.params.id);
    const db = await getDb();
    const row = await one<{ graph: unknown; created_at: string; chain: string; root_address: string }>(
      db,
      `SELECT graph, created_at, chain, root_address FROM traces WHERE id = $1`,
      [id]
    );
    if (!row) throw new HttpError(404, "not_found", "Trace not found");
    res.json({ graph: row.graph, createdAt: row.created_at, chain: row.chain, rootAddress: row.root_address });
  })
);

/**
 * The fund-flow graph for a case, plus the runs that produced it.
 *
 * The Viewer renders whatever the analysis actually produced rather than
 * re-deriving a graph of its own, so what is displayed and what is on file are
 * the same artifact. `latest` is the most recent trace, which is the one a case
 * under review is being read against; the run list is what makes an older
 * version reachable, since a re-run replaces the view.
 *
 * A case with no trace returns `graph: null` and 200 rather than 404: the
 * absence of a trace is a normal state for a case that has not been traced yet,
 * and the client renders an instruction instead of an error.
 */
chainRouter.get(
  "/cases/:caseId/graph",
  requirePermission("case:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const caseId = z.string().uuid().parse(req.params.caseId);
    const db = await getDb();

    const caseRow = await one<{ id: string; case_ref: string; status: string }>(
      db,
      `SELECT id, case_ref, status FROM cases WHERE id = $1`,
      [caseId]
    );
    if (!caseRow) throw new HttpError(404, "not_found", "Case not found");

    const runs = await many<{
      id: string;
      chain: string;
      root_address: string;
      node_count: number;
      edge_count: number;
      total_usd: string | null;
      risk_score: number;
      risk_level: string;
      truncated_reasons: string[] | null;
      created_at: string;
      created_by_name: string | null;
    }>(
      db,
      `SELECT t.id, t.chain, t.root_address, t.node_count, t.edge_count, t.total_usd,
              t.risk_score, t.risk_level, t.truncated_reasons, t.created_at,
              u.display_name AS created_by_name
         FROM traces t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.case_id = $1
        ORDER BY t.created_at DESC`,
      [caseId]
    );

    // The graph itself is only fetched for the run actually being shown.
    const latestId = z.string().uuid().optional().parse(req.query.traceId) ?? runs[0]?.id;
    let graph: unknown = null;
    let selected: (typeof runs)[number] | undefined;
    if (latestId) {
      selected = runs.find((r) => r.id === latestId);
      const row = await one<{ graph: unknown }>(db, `SELECT graph FROM traces WHERE id = $1 AND case_id = $2`, [
        latestId,
        caseId
      ]);
      graph = row?.graph ?? null;
    }

    res.json({
      caseId,
      caseRef: caseRow.case_ref,
      status: caseRow.status,
      graph,
      selectedTraceId: selected?.id ?? null,
      runs: runs.map((r) => ({
        id: r.id,
        chain: r.chain,
        rootAddress: r.root_address,
        nodeCount: r.node_count,
        edgeCount: r.edge_count,
        totalUsd: r.total_usd === null ? null : Number(r.total_usd),
        riskScore: r.risk_score,
        riskLevel: r.risk_level,
        truncatedReasons: r.truncated_reasons ?? [],
        createdAt: r.created_at,
        createdBy: r.created_by_name
      }))
    });
  })
);
