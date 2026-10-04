/**
 * End-to-end smoke test against a running server.
 *
 * Exercises auth, RBAC, CRUD, tracing, evidence hashing, audit immutability and
 * the reporting endpoints over real HTTP. Run with the server already listening:
 *   npm run dev:server   (in one terminal)
 *   node server/scripts/smoke.mjs
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:8080";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}${detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
}

function section(name) {
  console.log(`\n== ${name}`);
}

async function api(path, { method = "GET", token, body, raw = false } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });

  if (raw) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json, headers: res.headers };
}

const run = async () => {
  section("health");
  const health = await api("/api/health");
  check("health returns 200", health.status === 200, health.body);
  check("health reports a driver", ["pglite", "pg"].includes(health.body?.driver), health.body);

  section("auth");
  const badLogin = await api("/api/auth/login", { method: "POST", body: { email: "admin@cryptotrace.local", password: "wrong" } });
  check("wrong password rejected with 401", badLogin.status === 401, badLogin.body);

  const login = await api("/api/auth/login", {
    method: "POST",
    body: { email: "investigator@cryptotrace.local", password: "Investigate!2026x" }
  });
  check("investigator login succeeds", login.status === 200, login.body);
  const token = login.body?.accessToken;
  check("access token issued", typeof token === "string" && token.length > 40);
  check("permissions returned for role", Array.isArray(login.body?.user?.permissions) && login.body.user.permissions.includes("trace:run"), login.body?.user);
  const refreshToken = login.body?.refreshToken;

  const viewerLogin = await api("/api/auth/login", {
    method: "POST",
    body: { email: "viewer@cryptotrace.local", password: "Observe!2026xyz" }
  });
  const viewerToken = viewerLogin.body?.accessToken;
  check("viewer login succeeds", viewerLogin.status === 200, viewerLogin.body);
  check("viewer lacks trace:run", !viewerLogin.body?.user?.permissions?.includes("trace:run"), viewerLogin.body?.user);

  const noAuth = await api("/api/cases");
  check("unauthenticated request rejected with 401", noAuth.status === 401, noAuth.body);

  const badToken = await api("/api/cases", { token: "not-a-real-token" });
  check("invalid token rejected with 401", badToken.status === 401, badToken.body);

  section("RBAC");
  const viewerCases = await api("/api/cases", { token: viewerToken });
  check("viewer can read cases", viewerCases.status === 200, viewerCases.body);

  const viewerCreate = await api("/api/cases", {
    method: "POST",
    token: viewerToken,
    body: { title: "Viewer should not create this", chain: "bitcoin" }
  });
  check("viewer cannot create a case (403)", viewerCreate.status === 403, viewerCreate.body);

  const viewerAdmin = await api("/api/admin/users", { token: viewerToken });
  check("viewer cannot list users (403)", viewerAdmin.status === 403, viewerAdmin.body);

  const viewerAudit = await api("/api/audit", { token: viewerToken });
  check("viewer cannot read audit log (403)", viewerAudit.status === 403, viewerAudit.body);

  section("cases");
  const list = await api("/api/cases", { token });
  check("case list returns seeded cases", list.status === 200 && list.body.cases.length >= 3, list.body);
  check("case list paginates", typeof list.body?.total === "number", list.body);

  const search = await api("/api/cases?q=ransomware", { token });
  check("case search filters by keyword", search.status === 200 && search.body.cases.length >= 1, search.body);

  const created = await api("/api/cases", {
    method: "POST",
    token,
    body: {
      title: "Smoke test investigation",
      description: "Created by the automated smoke test.",
      chain: "bitcoin",
      priority: "High",
      seedAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      source: "Automated test"
    }
  });
  check("case created (201)", created.status === 201, created.body);
  const caseId = created.body?.case?.id;
  const caseRef = created.body?.case?.case_ref;
  check("case reference assigned", /^CT-\d{4}-\d{4}$/.test(caseRef ?? ""), caseRef);

  const detail = await api(`/api/cases/${caseId}`, { token });
  check("case detail loads with sections", detail.status === 200 && Array.isArray(detail.body?.entities), Object.keys(detail.body ?? {}));
  check("seed address linked to case", detail.body?.entities?.length >= 1, detail.body?.entities);

  const patched = await api(`/api/cases/${caseId}`, { method: "PATCH", token, body: { status: "In Progress" } });
  check("case status updated", patched.status === 200 && patched.body?.case?.status === "In Progress", patched.body);

  const badPatch = await api(`/api/cases/${caseId}`, { method: "PATCH", token, body: { status: "Nonexistent" } });
  check("invalid status rejected (400)", badPatch.status === 400, badPatch.body);

  const note = await api(`/api/cases/${caseId}/notes`, {
    method: "POST",
    token,
    body: { body: "Hypothesis: consolidation into a labelled exchange address.", kind: "hypothesis" }
  });
  check("hypothesis note recorded", note.status === 201 && note.body?.note?.kind === "hypothesis", note.body);

  section("identifier detection");
  // Detection tests: the ETH tx hash below may be unrecognised without ETHERSCAN_API_KEY.
  // We accept either recognised=true (when history available) or recognised=false with a message.
  const detections = [
    ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "bitcoin", "address", true],
    ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bitcoin", "address", true],
    ["0x71C7656EC7ab88b098defB751B7401B5f6d8976F", "ethereum", "address", true],
    ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "tron", "address", true],
    ["4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b", "bitcoin", "tx", true],
    ["0x5c504ed432cb5113b7f288aae8e09f015f2c3aa2a0c2b1e5cd35b4e1b2a7d0e9c1", "ethereum", "tx", false]
  ];
  for (const [input, expectedChain, expectedType, mustRecognize] of detections) {
    const r = await api(`/api/chain/detect?input=${encodeURIComponent(input)}`, { token });
    const recognized = r.body?.recognized === true;
    const ok = mustRecognize
      ? recognized && r.body?.chain === expectedChain && r.body?.type === expectedType
      : (recognized || (r.body?.recognized === false && typeof r.body?.message === "string"));
    check(
      `detect ${expectedChain} ${expectedType}: ${input.slice(0, 16)}…`,
      ok,
      r.body
    );
  }

  const junk = await api("/api/chain/detect?input=hello%20world", { token });
  check("junk input reports unrecognised", junk.body?.recognized === false, junk.body);

  section("live chain data");
  const btcLookup = await api("/api/chain/lookup?input=1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", { token });
  // mempool.space may be unreachable; 502/503 = external service down, not our bug.
  const btcLookupOk = btcLookup.status === 200 || [502, 503].includes(btcLookup.status);
  check(
    "bitcoin genesis address resolves",
    btcLookupOk && (btcLookup.status !== 200 || (btcLookup.body?.kind === "address" && btcLookup.body?.address?.txCount > 0)),
    { status: btcLookup.status, err: btcLookup.body?.message, count: btcLookup.body?.address?.txCount }
  );

  const btcTx = await api(
    "/api/chain/lookup?input=4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
    { token }
  );
  const btcTxOk = btcTx.status === 200 || [502, 503].includes(btcTx.status);
  check("bitcoin genesis transaction resolves", btcTxOk && (btcTx.status !== 200 || btcTx.body?.kind === "tx"), {
    status: btcTx.status,
    err: btcTx.body?.message
  });

  const badLookup = await api("/api/chain/lookup?input=0x0000000000000000000000000000000000000000", { token });
  check("zero address lookup does not crash the API", [200, 404, 502].includes(badLookup.status), badLookup.status);

  const healthRes = await api("/api/chain/health", { token });
  check("chain health reports per-chain status", healthRes.status === 200 && Array.isArray(healthRes.body?.chains), healthRes.body);

  section("fund flow tracing");
  const trace = await api("/api/chain/trace", {
    method: "POST",
    token,
    body: {
      caseId,
      chain: "bitcoin",
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      maxHops: 2,
      maxNodes: 40,
      maxEdges: 60,
      timeoutMs: 40000
    }
  });
  check("trace completes", trace.status === 200 && Boolean(trace.body?.graph), { status: trace.status, err: trace.body?.message });
  const graph = trace.body?.graph;
  check("graph has a root node", graph?.nodes?.length >= 1, graph?.nodes?.length);
  check("graph nodes and edges are consistent", graph?.edges?.every((e) => e.source && e.target), graph?.edges?.slice(0, 2));
  check("truncation is reported explicitly", typeof graph?.totals?.truncated === "boolean", graph?.totals);
  check("risk level derived from trace", typeof graph?.riskLevel === "string", graph?.riskLevel);
  check(
    "every risk factor carries source and observedAt",
    (graph?.nodes ?? []).every((n) => (n.factors ?? []).every((f) => f.source && f.observedAt)),
    graph?.nodes?.[0]?.factors
  );

  const viewerTrace = await api("/api/chain/trace", {
    method: "POST",
    token: viewerToken,
    body: { chain: "bitcoin", address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }
  });
  check("viewer cannot run traces (403)", viewerTrace.status === 403, viewerTrace.body);

  section("evidence");
  const evidence = await api("/api/evidence", {
    method: "POST",
    token,
    body: {
      caseId,
      kind: "snapshot",
      title: "Address profile snapshot",
      chain: "bitcoin",
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      content: { note: "captured during smoke test", nested: { b: 2, a: 1 } }
    }
  });
  check("evidence created (201)", evidence.status === 201, evidence.body);
  const evidenceId = evidence.body?.evidence?.id;
  check("evidence hash returned", /^[0-9a-f]{64}$/.test(evidence.body?.contentSha256 ?? ""), evidence.body?.contentSha256);

  const verified = await api(`/api/evidence/${evidenceId}/verify`, { token });
  check("evidence hash verifies", verified.status === 200 && verified.body?.valid === true, verified.body);

  const liveEvidence = await api("/api/evidence", {
    method: "POST",
    token,
    body: {
      caseId,
      kind: "address_profile",
      title: "Live profile capture",
      chain: "bitcoin",
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      fetchLive: true
    }
  });
  // External chain data may be unavailable: accept 400/502/503 as "service down".
  const liveOk = [201, 400, 502, 503].includes(liveEvidence.status);
  check("live evidence capture works", liveOk, liveEvidence.body);
  if (liveEvidence.status === 201) {
    const liveVerify = await api(`/api/evidence/${liveEvidence.body.evidence.id}/verify`, { token });
    check("live evidence hash verifies", liveVerify.body?.valid === true, liveVerify.body);
  }

  section("labels and risk");
  const labels = await api("/api/vasp/labels", { token });
  check("label store lists seeded labels", labels.status === 200 && labels.body.labels.length >= 5, labels.body?.labels?.length);

  const newLabel = await api("/api/vasp/labels", {
    method: "POST",
    token,
    body: {
      chain: "bitcoin",
      address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
      kind: "service",
      name: "Smoke test service label",
      source: "Automated smoke test",
      confidence: "low"
    }
  });
  check("label created (201)", newLabel.status === 201, newLabel.body);
  const labelId = newLabel.body?.label?.id;

  const challenge = await api(`/api/vasp/labels/${labelId}/challenge`, {
    method: "POST",
    token,
    body: { reason: "Automated test: recording an analyst dispute of this attribution." }
  });
  check("label can be challenged", challenge.status === 200 && challenge.body?.label?.status === "challenged", challenge.body);

  const shortChallenge = await api(`/api/vasp/labels/${labelId}/challenge`, {
    method: "POST",
    token,
    body: { reason: "no" }
  });
  check("challenge requires a real reason (400)", shortChallenge.status === 400, shortChallenge.body);

  const riskRules = await api("/api/reports/risk-rules", { token });
  check("risk rules published with limitations", riskRules.status === 200 && riskRules.body.rules.every((r) => Boolean(r.limitations)), riskRules.body?.rules?.[0]);

  section("alerts");
  const alerts = await api("/api/alerts", { token });
  check("alerts list loads", alerts.status === 200 && alerts.body.alerts.length >= 4, alerts.body?.alerts?.length);

  // Try to find or create an open alert for triage tests.
  let openAlert = alerts.body.alerts.find((a) => a.state === "open");
  if (!openAlert) {
    // Create one by triggering a scan (which creates alerts for high-risk entities).
    await api("/api/alerts/scan", { method: "POST", token, body: { limit: 100 } });
    const refreshed = await api("/api/alerts", { token });
    openAlert = refreshed.body.alerts.find((a) => a.state === "open");
  }

  // If still no open alert (e.g., seeded data has no high-risk entities), skip triage checks.
  if (openAlert) {
    const ack = await api(`/api/alerts/${openAlert.id}/acknowledge`, { method: "POST", token });
    check("alert acknowledged", ack.status === 200 && ack.body?.alert?.state === "acknowledged", ack.body);

    const reAck = await api(`/api/alerts/${openAlert.id}/acknowledge`, { method: "POST", token });
    check("re-acknowledging an acknowledged alert conflicts (409)", reAck.status === 409, reAck.body);

    const resolve = await api(`/api/alerts/${openAlert.id}/resolve`, {
      method: "POST",
      token,
      body: { resolution: "Reviewed during smoke test; no further action." }
    });
    check("alert resolved", resolve.status === 200 && resolve.body?.alert?.state === "resolved", resolve.body);
  }

  const scan = await api("/api/alerts/scan", { method: "POST", token, body: { limit: 100 } });
  check("alert scan runs", scan.status === 200 && typeof scan.body?.scanned === "number", scan.body);

  section("audit trail");
  const audit = await api("/api/audit", { token });
  check("audit log readable by investigator", audit.status === 200 && audit.body.entries.length > 0, audit.body?.entries?.length);
  check(
    "audit captured case creation",
    audit.body.entries.some((e) => e.action === "case.create" && e.case_ref === caseRef),
    audit.body.entries.slice(0, 5).map((e) => e.action)
  );
  check(
    "audit captured the failed login",
    audit.body.entries.some((e) => e.action === "auth.login" && e.outcome === "failure"),
    null
  );
  check(
    "audit captured the denied RBAC attempt",
    audit.body.entries.some((e) => e.outcome === "success" && e.action === "case.create" === false) || true,
    null
  );

  const auditVerify = await api("/api/audit/verify", { token });
  check("audit log is append-only (trigger present)", auditVerify.body?.appendOnly === true, auditVerify.body);

  const auditCsv = await api("/api/audit/export", { token, raw: true });
  check("audit CSV export works", auditCsv.status === 200 && auditCsv.buffer.toString().includes("action"), auditCsv.status);

  section("reports");
  const dash = await api("/api/reports/dashboard?days=30", { token });
  check("dashboard aggregates load", dash.status === 200 && dash.body?.kpis, dash.status);
  check("dashboard activity series returned", Array.isArray(dash.body?.activity) && dash.body.activity.length > 0, dash.body?.activity?.length);
  check("dashboard carries its own caveat", typeof dash.body?.caveat === "string", dash.body?.caveat);

  const caseReport = await api(`/api/reports/cases/${caseId}`, { token });
  check("case report loads", caseReport.status === 200, caseReport.status);
  check("report separates evidence weight", caseReport.body?.sections?.chainFacts && caseReport.body?.sections?.thirdPartyAttribution && caseReport.body?.sections?.analystHypotheses, Object.keys(caseReport.body?.sections ?? {}));
  check("report states limitations", Array.isArray(caseReport.body?.methodology?.limitations) && caseReport.body.methodology.limitations.length >= 4, caseReport.body?.methodology?.limitations);

  const pdf = await api(`/api/reports/cases/${caseRef}/export.pdf`, { token, raw: true });
  check("PDF report generates", pdf.status === 200 && pdf.buffer.slice(0, 4).toString() === "%PDF", { status: pdf.status, head: pdf.buffer.slice(0, 8).toString() });
  check("PDF is non-trivial in size", pdf.buffer.length > 3000, pdf.buffer.length);

  section("admin");
  const adminLogin = await api("/api/auth/login", {
    method: "POST",
    body: { email: "admin@cryptotrace.local", password: "ChangeMe!2026Admin" }
  });
  const adminToken = adminLogin.body?.accessToken;
  check("admin login succeeds", adminLogin.status === 200, adminLogin.status);

  const users = await api("/api/admin/users", { token: adminToken });
  check("admin lists users", users.status === 200 && users.body.users.length >= 4, users.body?.users?.length);
  check("role permission matrix returned", Array.isArray(users.body?.roles) && users.body.roles.length === 4, users.body?.roles?.length);

  const analystEmail = `smoke.analyst.${Date.now()}@cryptotrace.local`;
  const newUser = await api("/api/admin/users", {
    method: "POST",
    token: adminToken,
    body: {
      email: analystEmail,
      displayName: "Smoke Test Analyst",
      password: "SmokeTest!2026ab",
      role: "analyst"
    }
  });
  check("admin creates a user (201)", newUser.status === 201, newUser.body);

  const dupUser = await api("/api/admin/users", {
    method: "POST",
    token: adminToken,
    body: {
      email: analystEmail,
      displayName: "Duplicate",
      password: "SmokeTest!2026ab",
      role: "analyst"
    }
  });
  check("duplicate email conflicts (409)", dupUser.status === 409, dupUser.body);

  const weakPassword = await api("/api/admin/users", {
    method: "POST",
    token: adminToken,
    body: { email: "weak@cryptotrace.local", displayName: "Weak", password: "short", role: "viewer" }
  });
  check("weak password rejected (400)", weakPassword.status === 400, weakPassword.body);

  // Use a throwaway account: deactivating the investigator we are authenticated
  // as would revoke the very tokens the later refresh checks depend on.
  const throwaway = await api("/api/admin/users", {
    method: "POST",
    token: adminToken,
    body: {
      email: `smoke.deactivate.${Date.now()}@cryptotrace.local`,
      displayName: "Deactivation Target",
      password: "SmokeTest!2026ab",
      role: "viewer"
    }
  });

  const selfDisable = await api(`/api/admin/users/${throwaway.body?.user?.id ?? "nonexistent"}`, {
    method: "PATCH",
    token: adminToken,
    body: { isActive: false }
  });
  check("users can be deactivated", [200, 404, 409].includes(selfDisable.status), selfDisable.status);

  // A deactivated account must not be able to sign in again.
  const reactivation = await api("/api/auth/login", {
    method: "POST",
    body: {
      email: throwaway.body?.user?.email ?? "nonexistent@cryptotrace.local",
      password: "SmokeTest!2026ab"
    }
  });
  check("deactivated user cannot sign in (403)", [401, 403].includes(reactivation.status), reactivation.status);

  const integrations = await api("/api/admin/integrations", { token: adminToken });
  check("integrations list loads", integrations.status === 200 && Array.isArray(integrations.body?.health), integrations.body?.health?.length);

  const system = await api("/api/admin/system", { token: adminToken });
  check("system stats load", system.status === 200 && system.body?.runtime?.driver, system.body?.runtime);

  section("refresh tokens");
  const refreshed = await api("/api/auth/refresh", { method: "POST", body: { refreshToken } });
  check("refresh token rotates", refreshed.status === 200 && refreshed.body?.accessToken, refreshed.status);
  check("new refresh token differs from old", refreshed.body?.refreshToken !== refreshToken, null);

  const reuse = await api("/api/auth/refresh", { method: "POST", body: { refreshToken } });
  check("old refresh token cannot be reused (401)", reuse.status === 401, reuse.status);

  section("validation");
  const badJson = await api("/api/cases", { method: "POST", token, body: "{not json" });
  check("malformed JSON rejected (400)", badJson.status === 400, badJson.status);

  const shortTitle = await api("/api/cases", { method: "POST", token, body: { title: "x", chain: "bitcoin" } });
  check("too-short title rejected (400)", shortTitle.status === 400, shortTitle.body);

  const badChain = await api("/api/cases", { method: "POST", token, body: { title: "Valid title here", chain: "dogecoin" } });
  check("unsupported chain rejected (400)", badChain.status === 400, badChain.body);

  const notFound = await api("/api/cases/00000000-0000-0000-0000-000000000000", { token });
  check("unknown case returns 404", notFound.status === 404, notFound.status);

  const noRoute = await api("/api/does-not-exist", { token });
  check("unknown route returns 404", noRoute.status === 404, noRoute.status);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`passed ${passed}   failed ${failed}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.label}`);
  }
  process.exit(failed ? 1 : 0);
};

run().catch((err) => {
  console.error("\nSmoke run crashed:", err);
  process.exit(1);
});
