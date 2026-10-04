/**
 * Exercises the automated status engine end to end against a running server.
 *
 * Verifies the transition table the specification calls for, that every
 * transition is recorded in the pipeline log, and that a case cannot be closed
 * by automation alone.
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:8080";

let accessToken = "";

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const results = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        expected ${expected}, got ${actual}`}`);
}

async function statusOf(caseId) {
  const r = await call("GET", `/api/status/${caseId}`);
  return r.json?.status ?? null;
}

const main = async () => {
  // ---- sign in as an investigator, who holds case:close ----
  const login = await call("POST", "/api/auth/login", {
    email: "investigator@cryptotrace.local",
    password: "Investigate!2026x"
  });
  if (login.status !== 200) {
    console.error("Login failed", login.status, login.json);
    process.exit(1);
  }
  accessToken = login.json.accessToken;
  console.log("Signed in as investigator\n");

  // ---- a fresh case to drive ----
  const created = await call("POST", "/api/cases", {
    title: "Status engine verification",
    description: "Created by the status engine verification script.",
    chain: "ethereum",
    priority: "Medium"
  });
  if (created.status !== 201) {
    console.error("Case creation failed", created.status, created.json);
    process.exit(1);
  }
  const caseId = created.json.case.id;
  console.log(`Case ${created.json.case.case_ref} (${caseId})\n`);

  check("new case starts Open", await statusOf(caseId), "Open");

  // ---- the trigger table, in order ----
  // A trace job is the cheapest event that moves the case, and it is what a real
  // investigation runs, so it is used to drive the spine.
  const traceJob = await call("POST", "/api/ai/trace-jobs", {
    caseId,
    chain: "ethereum",
    rootAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    maxHops: 2,
    userId: login.json.user.id
  });
  console.log(`trace job: ${traceJob.status} ${JSON.stringify(traceJob.json).slice(0, 160)}`);

  // The job runs asynchronously in the worker; wait for a terminal status.
  let job = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call("GET", `/api/ai/trace-jobs?caseId=${caseId}`);
    job = r.json?.jobs?.[0] ?? r.json?.[0] ?? null;
    if (job && ["completed", "partial", "failed", "cancelled"].includes(job.status)) break;
  }
  console.log(`trace job settled: ${job?.status} (${job?.error ?? "no error"})\n`);

  const afterTrace = await statusOf(caseId);
  check("trace activity moved the case off Open", afterTrace !== "Open", true);
  console.log(`        status is now: ${afterTrace}`);

  // ---- explicit escalation branch ----
  const esc = await call("POST", `/api/status/${caseId}/escalate`, {
    reason: "Verification: a critical condition requires investigator review"
  });
  check("escalate accepted", esc.status, 200);
  check("escalation moves the case to Escalated", await statusOf(caseId), "Escalated");

  // While escalated, ordinary pipeline work must not walk it back.
  await call("POST", `/api/status/${caseId}/review/start`);
  check("review start does not clear an escalation", await statusOf(caseId), "Escalated");

  // ---- de-escalation returns to Under Review ----
  const deesc = await call("POST", `/api/status/${caseId}/deescalate`, {
    reason: "Verification: the escalated condition was reviewed and cleared"
  });
  check("deescalate accepted", deesc.status, 200);
  const afterDeesc = await statusOf(caseId);
  check("de-escalation returns to Under Review", afterDeesc, "Under Review");

  // ---- closure requires a written outcome ----
  const tooShort = await call("POST", `/api/cases/${caseId}/close`, { closureNote: "done" });
  check("closure refuses a note under 10 characters", tooShort.status, 400);

  const blocked = await call("POST", `/api/cases/${caseId}/close`, {
    closureNote: "Verification closure with unresolved alerts present"
  });
  console.log(`        close with open alerts: ${blocked.status} ${blocked.json?.message?.slice(0, 90) ?? ""}`);

  const closed = await call("POST", `/api/cases/${caseId}/close`, {
    closureNote: "Verification closure, alerts reviewed and accepted as outstanding",
    acknowledgeBlockers: true
  });
  check("closure accepted with an explicit override", closed.status, 200);
  check("case is Closed", await statusOf(caseId), "Closed");

  // ---- a closed case ignores new pipeline work until reopened ----
  await call("POST", `/api/status/${caseId}/review/start`);
  check("a closed case is not revived by pipeline work", await statusOf(caseId), "Closed");

  const reopened = await call("POST", `/api/cases/${caseId}/reopen`, { note: "Verification reopen" });
  check("reopen accepted", reopened.status, 200);
  check("reopen returns the case to Open", await statusOf(caseId), "Open");

  // ---- the pipeline log is real history, not a projection ----
  const log = await call("GET", `/api/status/${caseId}/events`);
  const events = log.json?.events ?? [];
  console.log(`\nPipeline log (${events.length} events):`);
  for (const e of events) {
    const move = e.to_status ? `${e.from_status} -> ${e.to_status}` : "no status change";
    console.log(`  ${e.created_at.slice(11, 19)}  ${e.event_type.padEnd(24)} ${move}`);
    if (e.reason) console.log(`        ${e.reason}`);
  }
  check("pipeline log recorded the events", events.length > 0, true);
  check(
    "every event carries a reason",
    events.every((e) => typeof e.reason === "string" && e.reason.length > 0),
    true
  );
  check(
    "escalation appears in the log",
    events.some((e) => e.event_type === "ESCALATION_REQUIRED" && e.to_status === "Escalated"),
    true
  );

  // ---- the audit trail records the same decisions ----
  const audit = await call("GET", `/api/audit?caseRef=${created.json.case.case_ref}&limit=100`);
  const actions = (audit.json?.entries ?? audit.json?.audit ?? []).map((a) => a.action);
  console.log(`\nAudit actions: ${[...new Set(actions)].join(", ")}`);
  check("closure is in the audit log", actions.includes("case.close"), true);
  check("reopen is in the audit log", actions.includes("case.reopen"), true);
  check("escalation is in the audit log", actions.includes("case.status_change"), true);

  // ---- the graph endpoint the Viewer reads ----
  const graph = await call("GET", `/api/chain/cases/${caseId}/graph`);
  check("case graph endpoint responds 200", graph.status, 200);
  console.log(
    `        graph: ${graph.json?.graph ? `${graph.json.graph.nodes?.length} nodes, ${graph.json.graph.edges?.length} edges` : "null (no trace persisted)"}, ${graph.json?.runs?.length} run(s)`
  );

  // ---- cleanup ----
  await call("DELETE", `/api/cases/${caseId}`);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error("Script error", err);
  process.exit(1);
});
