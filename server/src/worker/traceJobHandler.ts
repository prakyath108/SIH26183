import { z } from "zod";
import { one, many, type Db } from "../db/index.js";
import { trace } from "../trace/tracer.js";
import { detect } from "../chains/index.js";
import { logger } from "../logger.js";
import { caseEventBus } from "../status/events.js";
import { type Chain } from "../types.js";
import type { JobHandler } from "./jobQueue.js";

const traceJobConfigSchema = z.object({
  caseId: z.string().uuid(),
  tracePlanId: z.string().uuid().optional(),
  chain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]),
  rootAddress: z.string().max(200),
  maxHops: z.number().int().min(1).max(6).default(3),
  direction: z.enum(["forward", "backward", "both"]).default("forward"),
  maxNodes: z.number().int().min(5).max(300).default(120),
  maxEdges: z.number().int().min(10).max(500).default(150),
  userId: z.string().uuid()
});

/** Parsed at the start of `handle`: the config is read back from JSONB/columns
 *  and may predate the current schema, so trusting it unchecked would leave
 *  maxHops/direction/maxNodes/maxEdges undefined and silently change what the
 *  trace actually does. */
const traceJobPayloadSchema = z.object({ config: traceJobConfigSchema });

type TraceJobPayload = z.infer<typeof traceJobPayloadSchema>;

function isRealChain(chain: Chain): chain is Exclude<Chain, "unknown"> {
  return chain !== "unknown";
}

async function updateProgress(db: Db, jobId: string, progress: Record<string, unknown>): Promise<void> {
  await db.query(`UPDATE trace_jobs SET progress = $1 WHERE id = $2`, [JSON.stringify(progress), jobId]);
}

export const traceJobHandler: JobHandler<TraceJobPayload> = {
  jobType: "trace_job",
  maxRetries: 3,
  pollIntervalMs: 5_000,

  async handle(jobId: string, rawPayload: TraceJobPayload, db: Db): Promise<void> {
    const { config } = traceJobPayloadSchema.parse(rawPayload);
    const { caseId, chain, rootAddress, maxHops, direction, maxNodes, maxEdges, userId } = config;

    await updateProgress(db, jobId, { stage: "initializing", subject: rootAddress, chain });

    // Tracing has begun: the case is In Progress from here until the pass ends.
    await caseEventBus.traceStarted(caseId, userId, jobId);

    const det = detect(rootAddress);
    if (!det || det.type !== "address" || !isRealChain(det.chain)) {
      throw new Error(`Invalid trace root: ${rootAddress} is not a valid address on a supported chain`);
    }

    const effectiveChain = det.chain;

    await updateProgress(db, jobId, { stage: "tracing", subject: det.normalized, chain: effectiveChain, maxHops, direction });

    const graph = await trace(db, {
      chain: effectiveChain,
      rootAddress: det.normalized,
      maxHops,
      direction,
      maxNodes,
      maxEdges,
      persistCaseId: caseId,
      userId
    });

    await updateProgress(db, jobId, { stage: "snapshotting", traceId: graph.traceId });

    await db.query(
      `INSERT INTO trace_snapshots (trace_job_id, trace_id, snapshot_type, graph, ledger, risk_summary, node_count, edge_count, risk_score, risk_level, description, created_by)
       VALUES ($1,$2,'original',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        jobId, graph.traceId ?? null, JSON.stringify(graph),
        graph.ledger ? JSON.stringify(graph.ledger) : null,
        JSON.stringify({ riskScore: graph.riskScore, riskLevel: graph.riskLevel }),
        graph.totals.nodeCount, graph.totals.edgeCount, graph.riskScore, graph.riskLevel,
        `Trace from ${det.normalized} (${direction}, ${maxHops} hops)`, userId
      ]
    );

    // result_trace_id is what the job list/detail endpoints return, and it is
    // the only durable link from the job back to the graph it produced. The
    // queue sets status/completed_at, but not this.
    await db.query(
      `UPDATE trace_jobs SET result_trace_id = $2, error = NULL WHERE id = $1`,
      [jobId, graph.traceId ?? null]
    );

    await updateProgress(db, jobId, {
      stage: "completed",
      traceId: graph.traceId,
      nodes: graph.totals.nodeCount,
      edges: graph.totals.edgeCount,
      riskScore: graph.riskScore,
      riskLevel: graph.riskLevel,
      truncated: graph.totals.truncatedReasons
    });

    // Traces carry their own risk pass, so the graph is scored by the time it
    // lands; reporting the pass as complete here is what hands the case to an
    // investigator instead of leaving it In Progress with nothing left running.
    if (graph.traceId) {
      await caseEventBus.traceCompleted(caseId, userId, jobId, graph.traceId, {
        nodeCount: graph.totals.nodeCount,
        edgeCount: graph.totals.edgeCount
      });
      await caseEventBus.riskAnalysisCompleted(caseId, userId);
    }
  },

  /**
   * A plan fans out to one job per subject, so the plan must only be marked
   * executed once the last of them has settled. Runs after the queue has
   * written this job's terminal status, so every row can be read uniformly.
   */
  async onSettled(jobId: string, db: Db): Promise<void> {
    const job = await one<{ trace_plan_id: string | null }>(
      db, `SELECT trace_plan_id FROM trace_jobs WHERE id = $1`, [jobId]
    );
    const planId = job?.trace_plan_id;
    if (!planId) return;

    const remaining = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM trace_jobs
       WHERE trace_plan_id = $1 AND id <> $2 AND status IN ('queued','running','retry')`,
      [planId, jobId]
    );
    if ((remaining?.n ?? 0) > 0) return;

    const jobs = await many<{
      root_address: string;
      status: string;
      result_trace_id: string | null;
      error: string | null;
      progress: Record<string, unknown> | null;
    }>(
      db,
      `SELECT root_address, status, result_trace_id, error, progress
       FROM trace_jobs WHERE trace_plan_id = $1 ORDER BY created_at`,
      [planId]
    );

    const traces: Record<string, unknown>[] = [];
    const tracesFailed: { address: string; reason: string }[] = [];

    for (const j of jobs) {
      if (j.status === "completed") {
        const p = j.progress ?? {};
        traces.push({
          address: j.root_address,
          traceId: j.result_trace_id,
          nodes: p.nodes ?? 0,
          edges: p.edges ?? 0,
          riskScore: p.riskScore ?? 0,
          riskLevel: p.riskLevel ?? "Unrated",
          truncated: p.truncated ?? []
        });
      } else {
        tracesFailed.push({ address: j.root_address, reason: j.error ?? j.status });
      }
    }

    const summary = {
      traces,
      tracesFailed,
      subjectsTraced: traces.length,
      subjectsFailed: tracesFailed.length
    };

    await db.query(
      `UPDATE trace_plans
       SET status = 'executed', executed_at = now(), execution_summary = $2
       WHERE id = $1 AND status = 'executing'`,
      [planId, JSON.stringify(summary)]
    );

    logger.info("Trace plan settled", {
      tracePlanId: planId,
      subjectsTraced: traces.length,
      subjectsFailed: tracesFailed.length
    });
  }
};