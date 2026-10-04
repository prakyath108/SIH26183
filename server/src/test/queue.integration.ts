/**
 * Integration check for the background job queue against a real database.
 *
 * Runs the same SQL the worker runs, through the same JobQueue, so the claim
 * projections, payload reconstruction, backoff and progress-merge behaviour are
 * verified rather than assumed. Handlers are stubs: the point is the queue
 * machinery, not the AI calls, which need a network and an API key.
 *
 * Usage: npm run test:worker  (uses a throwaway DATA_DIR, never the dev db)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, so it is erased at runtime and DATA_DIR is still set before
// paths.ts reads it.
import type { JobHandler } from "../worker/jobQueue.js";

const dataDir = await mkdtemp(join(tmpdir(), "cryptotrace-worker-"));
process.env.DATA_DIR = dataDir;

const { getDb } = await import("../db/index.js");
const { migrate } = await import("../db/migrate.js");
const { JobQueue } = await import("../worker/jobQueue.js");

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  say(`${ok ? "  ok  " : " FAIL "} ${name}${ok ? "" : `\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`}`);
}
function checkThat(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  say(`${cond ? "  ok  " : " FAIL "} ${name}${cond ? "" : ` ${detail}`}`);
}

const db = await getDb();
await migrate();

const user = await db.query<{ id: string }>(
  `INSERT INTO users (email, password_hash, display_name, role)
   VALUES ('worker-test@test.local','x','Worker Test','analyst') RETURNING id`
);
const userId = user.rows[0]!.id;

const caseRow = await db.query<{ id: string; case_ref: string }>(
  `INSERT INTO cases (case_ref, title, chain, status)
   VALUES ('CT-WT','Worker test','ethereum','Open') RETURNING id, case_ref`
);
const caseId = caseRow.rows[0]!.id;

const docRow = await db.query<{ id: string }>(
  `INSERT INTO documents (case_id, filename, mime, byte_size, sha256, storage_path, status)
   VALUES ($1,'note.txt','text/plain',4,'abc123','uploads/note.txt','extracted') RETURNING id`,
  [caseId]
);
const documentId = docRow.rows[0]!.id;

const ADDR = "0x0000000000000000000000000000000000000001";

const seenAuto: Record<string, unknown>[] = [];
const seenTrace: Record<string, unknown>[] = [];

const autoHandler: JobHandler<{ documentId: string; config: Record<string, unknown> }> = {
  jobType: "auto_process",
  maxRetries: 2,
  pollIntervalMs: 20,
  async handle(jobId, payload) {
    seenAuto.push(payload);
    await db.query(
      `UPDATE auto_process_jobs SET progress = progress || '{"stage":"applying_indicators","step":4}'::jsonb WHERE id = $1`,
      [jobId]
    );
    await db.query(
      `UPDATE auto_process_jobs SET result = $2 WHERE id = $1`,
      [jobId, JSON.stringify({ caseId, markers: 7 })]
    );
  }
};

const traceHandler: JobHandler<{ config: Record<string, unknown> }> = {
  jobType: "trace_job",
  maxRetries: 1,
  pollIntervalMs: 20,
  async handle(jobId, payload) {
    seenTrace.push(payload);
    await db.query(
      `UPDATE trace_jobs SET result_trace_id = NULL, progress = progress || '{"stage":"tracing"}'::jsonb WHERE id = $1`,
      [jobId]
    );
  }
};

/** Always throws, to exercise the retry-then-fail path. Uses the real
 *  auto_process table, so the failure path runs the production SQL. */
const failHandler: JobHandler<Record<string, unknown>> = {
  jobType: "auto_process",
  maxRetries: 2,
  pollIntervalMs: 20,
  async handle() {
    throw new Error("synthetic handler failure");
  }
};

const queue = new JobQueue({ concurrency: 1, pollIntervalMs: 20 });
queue.register(autoHandler);
queue.register(traceHandler);

const autoJob = await db.query<{ id: string }>(
  `INSERT INTO auto_process_jobs (case_id, document_id, status, config, created_by)
   VALUES ($1,$2,'queued',$3,$4) RETURNING id`,
  [caseId, documentId, JSON.stringify({ createCase: false, maxHops: 3 }), userId]
);
const traceJob = await db.query<{ id: string }>(
  `INSERT INTO trace_jobs (case_id, chain, root_address, max_hops, direction, max_nodes, max_edges, status, created_by)
   VALUES ($1,'ethereum',$2,4,'both',77,88,'queued',$3) RETURNING id`,
  [caseId, ADDR, userId]
);

await queue.start();

const deadline = Date.now() + 20_000;
const settle = async (id: string, table: string): Promise<Record<string, unknown>> => {
  for (;;) {
    const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    const row = r.rows[0]!;
    if (row.status === "completed" || row.status === "failed") return row;
    if (Date.now() > deadline) throw new Error(`${table} ${id} stuck in status ${row.status}`);
    await new Promise((res) => setTimeout(res, 25));
  }
};

const autoDone = await settle(autoJob.rows[0]!.id, "auto_process_jobs");
const traceDone = await settle(traceJob.rows[0]!.id, "trace_jobs");
await queue.stop();

say("\n-- auto_process job --");
check("status", autoDone.status, "completed");
check("attempts incremented once", autoDone.attempts, 1);
check("completed_at set", autoDone.completed_at !== null, true);
check(
  "handler received documentId from the document_id column",
  seenAuto[0]?.documentId,
  documentId
);
check("handler received caseId", seenAuto[0]?.caseId, caseId);
check(
  "config came from the config column",
  (seenAuto[0]?.config as Record<string, unknown>)?.maxHops,
  3
);
check(
  "config.userId backfilled from created_by",
  (seenAuto[0]?.config as Record<string, unknown>)?.userId,
  userId
);
const autoProgress = autoDone.progress as Record<string, unknown>;
check("handler progress preserved", autoProgress.stage, "applying_indicators");
check("queue completion merged into progress", autoProgress.completed, true);
check("handler step preserved through merge", autoProgress.step, 4);
check(
  "result written by handler survived completion",
  (autoDone.result as Record<string, unknown>)?.markers,
  7
);

say("\n-- trace_job job --");
check("status", traceDone.status, "completed");
const tcfg = seenTrace[0]?.config as Record<string, unknown>;
check("rootAddress from root_address column", tcfg?.rootAddress, ADDR);
check("chain from chain column", tcfg?.chain, "ethereum");
check("maxHops from max_hops column", tcfg?.maxHops, 4);
check("direction from direction column", tcfg?.direction, "both");
check("maxNodes from max_nodes column", tcfg?.maxNodes, 77);
check("maxEdges from max_edges column", tcfg?.maxEdges, 88);
check("caseId from case_id column", tcfg?.caseId, caseId);
check("userId from created_by column", tcfg?.userId, userId);
checkThat("trace_plan_id absent maps to undefined", tcfg?.tracePlanId === undefined);

say("\n-- retry and backoff --");
const failJob = await db.query<{ id: string }>(
  `INSERT INTO auto_process_jobs (case_id, document_id, status, config, created_by, max_retries)
   VALUES ($1,$2,'queued','{}',$3,2) RETURNING id`,
  [caseId, documentId, userId]
);
const failing = new JobQueue({ concurrency: 1, pollIntervalMs: 20 });
failing.register(failHandler);
await failing.start();

const retrySeen: string[] = [];
for (;;) {
  const r = await db.query<Record<string, unknown>>(
    `SELECT status, attempts, error, retry_at FROM auto_process_jobs WHERE id = $1`,
    [failJob.rows[0]!.id]
  );
  const row = r.rows[0]!;
  retrySeen.push(String(row.status));
  if (row.status === "failed") break;
  if (retrySeen.length > 200) break;
  await new Promise((res) => setTimeout(res, 25));
}
checkThat(
  "a job that keeps failing is retried then marked failed",
  retrySeen.includes("retry") && retrySeen[retrySeen.length - 1] === "failed",
  `saw: ${[...new Set(retrySeen)].join(",")}`
);
const finalRow = await db.query<Record<string, unknown>>(
  `SELECT status, attempts, error, retry_at FROM auto_process_jobs WHERE id = $1`,
  [failJob.rows[0]!.id]
);
check("attempts capped at max_retries", finalRow.rows[0]!.attempts, 2);
check("error recorded", finalRow.rows[0]!.error, "synthetic handler failure");
check("retry_at cleared on terminal failure", finalRow.rows[0]!.retry_at, null);
await failing.stop();

say("\n-- settlement hook --");
// Fails once, then succeeds. onSettled must fire only for the terminal
// outcome: firing it on the retry would let a plan be finalised by a job that
// is about to run again.
let handleCalls = 0;
let settledCalls = 0;
const flakyHandler: JobHandler<Record<string, unknown>> = {
  jobType: "auto_process",
  maxRetries: 3,
  pollIntervalMs: 20,
  async handle() {
    handleCalls++;
    if (handleCalls === 1) throw new Error("transient failure");
    await db.query(`UPDATE auto_process_jobs SET result = '{"ok":true}'::jsonb WHERE id = $1`, [currentId]);
  },
  async onSettled() {
    settledCalls++;
  }
};

let currentId = "";
const flakyJob = await db.query<{ id: string }>(
  `INSERT INTO auto_process_jobs (case_id, document_id, status, config, created_by, max_retries)
   VALUES ($1,$2,'queued','{}',$3,3) RETURNING id`,
  [caseId, documentId, userId]
);
currentId = flakyJob.rows[0]!.id;

const flakyQueue = new JobQueue({ concurrency: 1, pollIntervalMs: 20 });
flakyQueue.register(flakyHandler);
await flakyQueue.start();
const flakyDone = await settle(flakyJob.rows[0]!.id, "auto_process_jobs");
await flakyQueue.stop();

check("flaky job eventually completes", flakyDone.status, "completed");
check("handler ran twice (one failure, one success)", handleCalls, 2);
check("onSettled fired exactly once, not on the retry", settledCalls, 1);
check("attempts recorded both tries", flakyDone.attempts, 2);

say("\n-- multi-job plan finalisation --");
// Two jobs for one plan. The plan must stay 'executing' until the last settles.
const plan = await db.query<{ id: string }>(
  `INSERT INTO ai_proposals (case_id, document_id, proposal, status, model, prompt_version, created_by)
   VALUES ($1,$2,'{"indicators":[]}'::jsonb,'pending','test-model','test-prompt',$3) RETURNING id`,
  [caseId, documentId, userId]
);
const tracePlan = await db.query<{ id: string }>(
  `INSERT INTO trace_plans (proposal_id, case_id, plan, status, created_by)
   VALUES ($1,$2,'{"primarySubject":null,"additionalSubjects":[],"maxHops":2,"direction":"forward"}'::jsonb,'executing',$3)
   RETURNING id`,
  [plan.rows[0]!.id, caseId, userId]
);

const planSettled: string[] = [];
const planHandler: JobHandler<Record<string, unknown>> = {
  jobType: "trace_job",
  maxRetries: 1,
  pollIntervalMs: 20,
  async handle(jobId) {
    await db.query(
      `UPDATE trace_jobs SET progress = progress || '{"stage":"completed","nodes":5,"edges":4,"riskScore":10,"riskLevel":"Low"}'::jsonb WHERE id = $1`,
      [jobId]
    );
  },
  async onSettled(jobId) {
    const remaining = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trace_jobs
       WHERE trace_plan_id = $1 AND id <> $2 AND status IN ('queued','running','retry')`,
      [tracePlan.rows[0]!.id, jobId]
    );
    if ((remaining.rows[0]?.n ?? 0) > 0) {
      planSettled.push("waiting");
      return;
    }
    planSettled.push("finalised");
    const jobs = await db.query<{ root_address: string; status: string; progress: Record<string, unknown> | null }>(
      `SELECT root_address, status, progress FROM trace_jobs WHERE trace_plan_id = $1 ORDER BY created_at`,
      [tracePlan.rows[0]!.id]
    );
    const summary = {
      traces: jobs.rows.filter((j) => j.status === "completed").map((j) => ({ address: j.root_address, nodes: j.progress?.nodes })),
      subjectsTraced: jobs.rows.filter((j) => j.status === "completed").length
    };
    await db.query(
      `UPDATE trace_plans SET status='executed', executed_at=now(), execution_summary=$2 WHERE id=$1 AND status='executing'`,
      [tracePlan.rows[0]!.id, JSON.stringify(summary)]
    );
  }
};

const planJobs = await db.query<{ id: string }>(
  `INSERT INTO trace_jobs (case_id, trace_plan_id, chain, root_address, max_hops, direction, status, created_by)
   VALUES ($1,$2,'ethereum','0x0000000000000000000000000000000000000001',2,'forward','queued',$3),
          ($1,$2,'ethereum','0x0000000000000000000000000000000000000002',2,'forward','queued',$3)
   RETURNING id`,
  [caseId, tracePlan.rows[0]!.id, userId]
);
check("two jobs queued for one plan", planJobs.rows.length, 2);

const planQueue = new JobQueue({ concurrency: 1, pollIntervalMs: 20 });
planQueue.register(planHandler);
await planQueue.start();
for (const j of planJobs.rows) await settle(j.id, "trace_jobs");
await planQueue.stop();

const planRow = await db.query<{ status: string; execution_summary: { traces: unknown[]; subjectsTraced: number } | null }>(
  `SELECT status, execution_summary FROM trace_plans WHERE id = $1`,
  [tracePlan.rows[0]!.id]
);
check("plan finalised exactly once", planSettled.filter((s) => s === "finalised").length, 1);
check("the other job saw a peer still running", planSettled.filter((s) => s === "waiting").length, 1);
check("plan marked executed", planRow.rows[0]!.status, "executed");
check("summary counted both traces", planRow.rows[0]!.execution_summary?.subjectsTraced, 2);
check(
  "summary carries per-subject node counts",
  (planRow.rows[0]!.execution_summary?.traces as { nodes: number }[]).map((t) => t.nodes),
  [5, 5]
);

say(`\n${failures === 0 ? "PASS" : `FAIL (${failures} assertion${failures === 1 ? "" : "s"})`}`);
await db.close();
await rm(dataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
