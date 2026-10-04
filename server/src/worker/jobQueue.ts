import { getDb, type Db } from "../db/index.js";
import { logger } from "../logger.js";

/**
 * Handlers keep their own payload type and validate it at the top of `handle`.
 * The registry stores them type-erased (`never` = accepts anything, invoked
 * through the `as never` cast in `processNext`), so no unsafe downcast leaks
 * into the call sites that register handlers.
 */
export interface JobHandler<TPayload = Record<string, unknown>> {
  readonly jobType: string;
  readonly maxRetries: number;
  readonly pollIntervalMs: number;
  handle(jobId: string, payload: TPayload, db: Db): Promise<void>;
  /**
   * Called once the job reaches a terminal state, after status has been
   * written. Work that must observe the *final* status belongs here rather
   * than in `handle`, which still runs while the job is 'running'. Failures in
   * this hook are logged and swallowed: the job outcome is already decided
   * and must not be rewritten by follow-up bookkeeping.
   */
  onSettled?(jobId: string, db: Db): Promise<void>;
}

export interface JobQueueOptions {
  concurrency: number;
  pollIntervalMs: number;
}

/** Columns each job type needs in the claim RETURNING clause, per table shape. */
const CLAIM_COLUMNS: Record<string, string[]> = {
  auto_process: ["document_id", "case_id", "config", "created_by"],
  trace_job: ["case_id", "trace_plan_id", "chain", "root_address", "max_hops", "direction", "max_nodes", "max_edges", "created_by"]
};

export class JobQueue {
  private handlers = new Map<string, JobHandler<never>>();
  private running = false;
  private workers: Array<Promise<void>> = [];
  private readonly options: JobQueueOptions;

  constructor(options: JobQueueOptions) {
    this.options = options;
  }

  register<TPayload>(handler: JobHandler<TPayload>): void {
    if (this.handlers.has(handler.jobType)) {
      throw new Error(`Job handler for ${handler.jobType} already registered`);
    }
    this.handlers.set(handler.jobType, handler);
    logger.info("Registered job handler", { jobType: handler.jobType });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("Starting job queue", { concurrency: this.options.concurrency });

    for (let i = 0; i < this.options.concurrency; i++) {
      this.workers.push(this.workerLoop(i));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.workers.map((w) => w.catch(() => undefined)));
    this.workers = [];
    logger.info("Job queue stopped");
  }

  private async workerLoop(workerId: number): Promise<void> {
    logger.info("Worker started", { workerId });
    while (this.running) {
      try {
        await this.processNext();
      } catch (err) {
        logger.error("Worker loop error", { workerId, error: err });
      }
      await this.sleep(this.options.pollIntervalMs);
    }
    logger.info("Worker stopped", { workerId });
  }

  private async processNext(): Promise<void> {
    const db = await getDb();
    const handlerEntries = Array.from(this.handlers.entries());

    for (const [jobType, handler] of handlerEntries) {
      const job = await this.claimJob(db, jobType);
      if (!job) continue;

      const startedAt = Date.now();
      logger.info("Processing job", { jobId: job.id, jobType, attempt: job.attempts });

      try {
        await handler.handle(job.id, job.payload as never, db);

        // Merge rather than overwrite: the handler already staged granular
        // progress (stage/step/caseRef) that the UI renders while it runs.
        const done = await db.query(
          `UPDATE ${this.getJobTable(jobType)}
           SET status = 'completed', completed_at = now(), error = NULL,
               progress = progress || $2::jsonb
           WHERE id = $1`,
          [job.id, JSON.stringify({ completed: true, durationMs: Date.now() - startedAt })]
        );

        // A claim that matched nothing upstream would otherwise be reported as
        // a clean success while the job sat in 'running' forever.
        if (done.rowCount === 0) {
          throw new Error(`Job ${job.id} disappeared before it could be completed`);
        }

        logger.info("Job completed", { jobId: job.id, jobType, durationMs: Date.now() - startedAt });
        await this.runSettled(handler, job.id, db);
      } catch (err) {
        const terminal = await this.handleJobFailure(db, job, handler, err);
        // A job parked in 'retry' is not settled; it will be claimed again.
        if (terminal) await this.runSettled(handler, job.id, db);
      }
    }
  }

  private async runSettled(handler: JobHandler<never>, jobId: string, db: Db): Promise<void> {
    if (!handler.onSettled) return;
    try {
      await handler.onSettled(jobId, db);
    } catch (err) {
      logger.error("Job settlement hook failed", {
        jobId,
        jobType: handler.jobType,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async claimJob(
    db: Db,
    jobType: string
  ): Promise<{ id: string; payload: Record<string, unknown>; attempts: number } | null> {
    const table = this.getJobTable(jobType);
    const columns = CLAIM_COLUMNS[jobType];
    if (!columns) {
      throw new Error(`No claim projection registered for job type ${jobType}`);
    }

    const row = await db.query<{ id: string; attempts: number } & Record<string, unknown>>(
      `UPDATE ${table} SET status = 'running', started_at = now(), attempts = attempts + 1, retry_at = NULL
       WHERE id = (
         SELECT id FROM ${table}
         WHERE status IN ('queued', 'retry')
           AND attempts < max_retries
           AND (retry_at IS NULL OR retry_at <= now())
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, ${columns.join(", ")}, attempts`
    );

    const r = row.rows[0];
    if (!r || typeof r.id !== "string") return null;

    return { id: r.id, attempts: r.attempts, payload: this.buildPayload(jobType, r) };
  }

  /**
   * Neither job table stores a single `payload` column: the auto-process job
   * keeps its request in `config`, while the trace job is stored column-wise.
   * Rebuild the handler's expected shape from the claimed row here.
   */
  private buildPayload(jobType: string, row: Record<string, unknown>): Record<string, unknown> {
    if (jobType === "auto_process") {
      const config = (row.config ?? {}) as Record<string, unknown>;
      return {
        documentId: row.document_id,
        caseId: row.case_id ?? undefined,
        config: { ...config, userId: config.userId ?? row.created_by }
      };
    }

    return {
      config: {
        caseId: row.case_id,
        tracePlanId: row.trace_plan_id ?? undefined,
        chain: row.chain,
        rootAddress: row.root_address,
        maxHops: row.max_hops,
        direction: row.direction,
        maxNodes: row.max_nodes,
        maxEdges: row.max_edges,
        userId: row.created_by
      }
    };
  }

  /** Returns true once the job has reached a terminal state. */
  private async handleJobFailure(
    db: Db,
    job: { id: string; attempts: number },
    handler: JobHandler<never>,
    err: unknown
  ): Promise<boolean> {
    const table = this.getJobTable(handler.jobType);
    const error = err instanceof Error ? err.message : String(err);

    const row = await db.query<{ max_retries: number }>(
      `SELECT max_retries FROM ${table} WHERE id = $1`,
      [job.id]
    );
    const maxRetries = row.rows[0]?.max_retries ?? handler.maxRetries;

    if (job.attempts >= maxRetries) {
      await db.query(
        `UPDATE ${table} SET status = 'failed', completed_at = now(), error = $2, retry_at = NULL WHERE id = $1`,
        [job.id, error]
      );
      logger.error("Job failed permanently", {
        jobId: job.id, jobType: handler.jobType, error, attempts: job.attempts, maxRetries
      });
      return true;
    }

    // Exponential backoff lives in retry_at, which claimJob honours, so a
    // failing job cannot spin through its whole retry budget in one poll.
    const backoffMs = Math.min(1000 * 2 ** job.attempts, 60_000);
    await db.query(
      `UPDATE ${table}
       SET status = 'retry', error = $2, retry_at = now() + ($3 || ' milliseconds')::interval,
           progress = progress || $4::jsonb
       WHERE id = $1`,
      [job.id, error, String(backoffMs), JSON.stringify({ attempt: job.attempts, retryAt: Date.now() + backoffMs })]
    );
    logger.warn("Job retry scheduled", {
      jobId: job.id, jobType: handler.jobType, attempt: job.attempts, backoffMs
    });
    return false;
  }

  private getJobTable(jobType: string): string {
    switch (jobType) {
      case "auto_process":
        return "auto_process_jobs";
      case "trace_job":
        return "trace_jobs";
      default:
        return `${jobType}_jobs`;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const jobQueue = new JobQueue({
  concurrency: 3,
  pollIntervalMs: 5_000
});