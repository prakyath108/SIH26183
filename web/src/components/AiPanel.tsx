import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import { Badge, ChainBadge, Notice } from "./ui";
import type {
  AiChatAnswer,
  AiProposalRow,
  AiStatus,
  AppliedSummary,
  CaseDocument,
  CaseProposal,
  ProposalIndicator
} from "../types";

/**
 * Case-scoped AI assistant.
 *
 * The panel is deliberately a *review* surface, not an autopilot. Everything it
 * shows is a proposal produced by a model that has not been allowed to write
 * anything: the investigator ticks the identifiers they recognise, chooses
 * whether case fields are overwritten, and only then presses Apply. The server
 * re-validates every value against its own chain detection before it can
 * reach the database, so a plausible-looking but fabricated address is dropped
 * rather than attached to a real case.
 *
 * It renders on `/investigations/:caseId` only. Everywhere else it stays out of
 * the way, because a document upload is meaningless without a case to attach
 * the resulting evidence to.
 */

const ACCEPTED = ".pdf,.csv,.tsv,.txt,.text,.log,.json,.md";

/**
 * Broadcast after a successful apply. The panel is mounted by the layout while
 * the data it changes belongs to the case page, so the refresh is an event the
 * owning page subscribes to rather than a prop threaded through the router.
 */
export const CASE_APPLIED_EVENT = "cryptotrace:case-ai-applied";

interface Props {
  caseId: string;
  onApplied: () => void;
}

export function AiPanel({ caseId, onApplied }: Props): JSX.Element | null {
  const { can } = useAuth();

  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<"intake" | "ask">("intake");

  // Only fetch status for a role that could use the panel at all; a viewer has
  // ai:read but no route to write, and probing would produce a pointless 403.
  const status = useQuery<AiStatus>(can("ai:read") ? "/api/ai/status" : null);

  if (!can("ai:read")) return null;

  const unavailable = status.data ? !status.data.available : false;

  return (
    <aside className={`ai-panel ${collapsed ? "collapsed" : ""}`} aria-label="AI assistant">
      <div className="ai-panel-head">
        <button
          className="ai-panel-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          title={collapsed ? "Open AI assistant" : "Collapse AI assistant"}
        >
          <span aria-hidden="true">✦</span>
          {!collapsed ? <strong>Case AI</strong> : null}
        </button>
        {!collapsed && status.data ? (
          <Badge tone={status.data.available ? "ok" : "neutral"}>
            {status.data.available ? status.data.model : "unconfigured"}
          </Badge>
        ) : null}
      </div>

      {collapsed ? null : (
        <>
          {unavailable ? (
            <div className="ai-panel-note">
              <Notice tone="info" title="AI is not configured">
                <p>{status.data?.reason ?? "The server has no model provider configured."}</p>
                <p className="muted">
                  Everything else on this page works normally. Set <code>OPENAI_API_KEY</code> to enable
                  document analysis and questions.
                </p>
              </Notice>
            </div>
          ) : null}

          <div className="ai-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "intake"}
              className={tab === "intake" ? "active" : ""}
              onClick={() => setTab("intake")}
            >
              Documents
            </button>
            <button role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}>
              Ask
            </button>
          </div>

          {tab === "intake" ? (
            <IntakeTab caseId={caseId} available={!unavailable} onApplied={onApplied} />
          ) : (
            <AskTab caseId={caseId} available={!unavailable} />
          )}
        </>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ intake */

function IntakeTab({
  caseId,
  available,
  onApplied
}: {
  caseId: string;
  available: boolean;
  onApplied: () => void;
}): JSX.Element {
  const { can } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<{ id: string; error?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const documents = useQuery<{ documents: CaseDocument[] }>(`/api/ai/cases/${caseId}/documents`, [caseId]);
  const proposals = useQuery<{ proposals: AiProposalRow[] }>(`/api/ai/cases/${caseId}/proposals`, [caseId]);

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api.upload<{ document: CaseDocument; duplicate: boolean }>(
        `/api/ai/cases/${caseId}/documents`,
        form
      );
      if (res.duplicate) {
        // The server keys on content hash, so this is the same bytes under a
        // different name. Say so rather than looking like a fresh upload.
        setUploadError(`"${res.document.filename}" is already attached to this case.`);
      }
      documents.reload();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function analyze(id: string): Promise<void> {
    setAnalyzing({ id, error: undefined });
    try {
      await api.post(`/api/ai/documents/${id}/analyze`);
      proposals.reload();
      documents.reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Analysis failed.";
      setAnalyzing({ id, error: msg });
      documents.reload();
    }
  }

  const canUpload = can("ai:upload") && available;
  const rows = documents.data?.documents ?? [];

  return (
    <div className="ai-panel-body">
      {canUpload ? (
        <div className="ai-upload">
          <label className="btn ghost file-btn">
            {uploading ? "Uploading…" : "Attach document"}
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED}
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </label>
          <span className="field-hint">PDF, CSV, TSV, JSON or text. Scanned PDFs need OCR first.</span>
        </div>
      ) : null}

      {(uploadError || analyzing?.error) ? (
        <Notice tone="danger" title={analyzing?.error ? "Analysis failed" : "Upload failed"}>
          {analyzing?.error ?? uploadError}
        </Notice>
      ) : null}

      {documents.loading ? <p className="muted">Loading documents…</p> : null}

      {!documents.loading && !rows.length ? (
        <p className="muted">
          No documents yet. Attach an intelligence report or a transaction export and it will be read for
          addresses, transaction hashes and case details.
        </p>
      ) : null}

      {rows.map((doc) => (
        <DocumentRow
          key={doc.id}
          doc={doc}
          canAnalyze={can("ai:upload") && available}
          analyzing={analyzing?.id === doc.id}
          analyzeError={analyzing?.id === doc.id ? analyzing.error : undefined}
          onAnalyze={() => void analyze(doc.id)}
        />
      ))}

      {proposals.loading ? <p className="muted">Loading proposals…</p> : null}

      {(proposals.data?.proposals ?? []).map((p) => (
        <ProposalCard
          key={p.id}
          row={p}
          canApply={can("ai:apply")}
          onApplied={() => {
            proposals.reload();
            documents.reload();
            onApplied();
          }}
        />
      ))}
    </div>
  );
}

function DocumentRow({
  doc,
  canAnalyze,
  analyzing,
  analyzeError,
  onAnalyze
}: {
  doc: CaseDocument;
  canAnalyze: boolean;
  analyzing: boolean;
  analyzeError?: string;
  onAnalyze: () => void;
}): JSX.Element {
  const { can } = useAuth();
  const statusTone = doc.status === "failed" ? "danger" : doc.status === "analyzed" ? "ok" : "neutral";

  return (
    <div className="ai-doc">
      <div className="ai-doc-main">
        <strong title={doc.filename}>{doc.filename}</strong>
        <span className="muted">
          {formatBytes(doc.byteSize)}
          {doc.pageCount ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}` : ""}
          {doc.charCount ? ` · ${doc.charCount.toLocaleString()} chars` : ""}
          {doc.ocr?.used ? (
            <span className="ocr-badge">
              <Badge tone="info">OCR</Badge>
              <span className="muted">{doc.ocr.pagesProcessed}/{doc.pageCount} pages · {doc.ocr.averageConfidence.toFixed(0)}% confidence</span>
            </span>
          ) : null}
        </span>
        {doc.error ? <span className="field-error">{doc.error}</span> : null}
        {analyzeError ? <span className="field-error">{analyzeError}</span> : null}
      </div>
      <div className="ai-doc-side">
        <Badge tone={statusTone}>{doc.status}</Badge>
        {can("ai:read") ? (
          <a className="btn ghost sm" href={`/api/ai/documents/${doc.id}/original`} target="_blank" rel="noreferrer">
            Open
          </a>
        ) : null}
        {canAnalyze && doc.status !== "analyzed" ? (
          <button className="btn sm" onClick={onAnalyze} disabled={analyzing || doc.status === "failed"}>
            {analyzing ? "Reading…" : analyzeError ? "Retry" : "Read"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- proposal */

function ProposalCard({ row, canApply, onApplied }: { row: AiProposalRow; canApply: boolean; onApplied: () => void }): JSX.Element {
  const toast = useToast();
  const proposal: CaseProposal = row.proposal;
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [applyFields, setApplyFields] = useState(false);
  const [runTraces, setRunTraces] = useState(true);
  const [maxHops, setMaxHops] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(row.status === "pending");

  const decided = row.status !== "pending";
  const indicators = useMemo(() => proposal.indicators ?? [], [proposal]);

  // Default to everything offered, with only the addresses that look like
  // subjects traced. The investigator's real job is to *remove* the wrong ones,
  // not to hunt for the right ones.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated) return;
    setPicked(new Set(indicators.map((_: unknown, i: number) => i)));
    setHydrated(true);
  }, [hydrated, indicators]);

  function toggle(i: number): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // traceSubjects is sent in the accepted-list index space, which is what
      // the server filters down to before it reads it.
      const subjects = indicators
        .map((ind: ProposalIndicator, i: number) => ({ ind, i }))
        .filter(({ i }) => picked.has(i) && row.proposal.indicators[i]?.kind === "address")
        .map(({ i }) => i);
      const res = await api.post<{ applied: AppliedSummary }>(`/api/ai/proposals/${row.id}/apply`, {
        acceptedIndexes: [...picked].sort((a, b) => a - b),
        applyCaseFields: applyFields,
        runTraces,
        maxHops,
        traceSubjects: runTraces ? subjects : []
      });
      const applied = res.applied;
      onApplied();
      setOpen(false);
      // Report what the apply actually did. Partial outcomes are the norm — a
      // chain endpoint can fail while the entities still write — so the trace
      // failures are named rather than swallowed into a generic success.
      const notes: string[] = [];
      if (applied.entitiesCreated) notes.push(`${applied.entitiesCreated} entit${applied.entitiesCreated === 1 ? "y" : "ies"}`);
      if (applied.transactionsCreated) notes.push(`${applied.transactionsCreated} transaction(s)`);
      if (applied.traces.length) notes.push(`${applied.traces.length} trace(s)`);
      if (applied.tracesFailed.length) notes.push(`${applied.tracesFailed.length} trace(s) failed`);
      if (applied.indicatorsSkipped.length) notes.push(`${applied.indicatorsSkipped.length} skipped`);
      const summary = notes.length ? notes.join(", ") : "no new records";
      if (applied.tracesFailed.length) {
        toast.notify(`Applied with warnings: ${summary}`, "info");
      } else {
        toast.success(`Applied: ${summary}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/ai/proposals/${row.id}/reject`, {});
      onApplied();
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject the proposal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`ai-proposal ${decided ? "decided" : ""}`}>
      <button className="ai-proposal-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="ai-proposal-title">
          <strong>{row.filename ?? "Document"}</strong>
          <span className="muted">
            {row.model} · {row.prompt_version} · {new Date(row.created_at).toLocaleString()}
          </span>
        </span>
        <Badge tone={row.status === "applied" ? "ok" : row.status === "rejected" ? "neutral" : "pending"}>
          {row.status}
        </Badge>
      </button>

      {open ? (
        <div className="ai-proposal-body">
          <p className="ai-summary">{proposal.summary}</p>

          {proposal.caseFields?.title || proposal.caseFields?.description || proposal.caseFields?.priority ? (
            <div className="ai-fields">
              <div className="ai-fields-head">
                <span className="field-label">Suggested case fields</span>
                {canApply && !decided ? (
                  <label className="check sm">
                    <input type="checkbox" checked={applyFields} onChange={(e) => setApplyFields(e.target.checked)} />
                    <span>Overwrite the case</span>
                  </label>
                ) : null}
              </div>
              {proposal.caseFields.title ? <div><span className="muted">Title</span> {proposal.caseFields.title}</div> : null}
              {proposal.caseFields.priority ? (
                <div><span className="muted">Priority</span> {proposal.caseFields.priority}</div>
              ) : null}
              {proposal.caseFields.description ? (
                <div><span className="muted">Description</span> {proposal.caseFields.description}</div>
              ) : null}
            </div>
          ) : null}

          {indicators.length ? (
            <div className="ai-indicators">
              <div className="ai-fields-head">
                <span className="field-label">
                  {indicators.length} identifier{indicators.length === 1 ? "" : "s"} found
                </span>
                {canApply && !decided ? (
                  <span className="muted">{picked.size} selected</span>
                ) : null}
              </div>
              {indicators.map((ind: ProposalIndicator, i: number) => (
                <IndicatorRow
                  key={`${ind.value}-${i}`}
                  ind={ind}
                  checked={picked.has(i)}
                  disabled={!canApply || decided}
                  onToggle={() => toggle(i)}
                />
              ))}
            </div>
          ) : (
            <p className="muted">No blockchain identifiers were found in this document.</p>
          )}

          {proposal.entities?.length ? (
            <div className="ai-list">
              <span className="field-label">Named parties in document</span>
              <ul>
                {proposal.entities.map((e, i) => (
                  <li key={i}>
                    {e.name} — {e.role} <span className="muted">“{e.excerpt}”</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {proposal.hypotheses?.length ? (
            <div className="ai-list">
              <span className="field-label">Leads to pin</span>
              <ul>
                {proposal.hypotheses.map((h, i) => (
                  <li key={i}>
                    {h.text} <span className="muted">— {h.basis}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {proposal.openQuestions?.length ? (
            <div className="ai-list">
              <span className="field-label">Open questions</span>
              <ul>
                {proposal.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {row.status === "applied" && row.applied_summary ? <ApplyReport summary={row.applied_summary} /> : null}

          {error ? <Notice tone="danger">{error}</Notice> : null}

          {canApply && !decided ? (
            <div className="ai-actions">
              <label className="check sm">
                <input type="checkbox" checked={runTraces} onChange={(e) => setRunTraces(e.target.checked)} />
                <span>Trace the selected subjects</span>
              </label>
              {runTraces ? (
                <label className="field sm">
                  <span className="field-label">Hops</span>
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={maxHops}
                    onChange={(e) => setMaxHops(Math.max(1, Math.min(6, Number(e.target.value) || 1)))}
                  />
                </label>
              ) : null}
              <div className="ai-actions-buttons">
                <button className="btn ghost" onClick={() => void reject()} disabled={busy}>
                  Discard
                </button>
                <button className="btn primary" onClick={() => void apply()} disabled={busy || picked.size === 0}>
                  {busy ? "Applying…" : `Apply ${picked.size || ""}`.trim()}
                </button>
              </div>
            </div>
          ) : !decided ? (
            <p className="muted">Your role can read this proposal but not apply it.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IndicatorRow({
  ind,
  checked,
  disabled,
  onToggle
}: {
  ind: ProposalIndicator;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <label className={`ai-indicator ${checked ? "on" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="ai-indicator-main">
        <code title={ind.value}>{ind.value}</code>
        <span className="ai-indicator-tags">
          <ChainBadge chain={ind.chain} />
          <Badge tone={ind.kind === "tx" ? "neutral" : "info"}>{ind.kind === "tx" ? "transaction" : "address"}</Badge>
          <Badge tone={ind.role === "subject" ? "warn" : "neutral"}>{ind.role}</Badge>
          <Badge tone={ind.confidence === "high" ? "ok" : ind.confidence === "medium" ? "warn" : "neutral"}>{ind.confidence}</Badge>
          {ind.label ? <span className="muted">{ind.label}</span> : null}
        </span>
        {ind.excerpt ? <span className="ai-indicator-excerpt">“{ind.excerpt}”</span> : null}
      </span>
    </label>
  );
}

function ApplyReport({ summary }: { summary: AppliedSummary }): JSX.Element {
  return (
    <div className="ai-list">
      <span className="field-label">Applied</span>
      <ul>
        <li>
          {summary.entitiesCreated} entit{summary.entitiesCreated === 1 ? "y" : "ies"},{" "}
          {summary.transactionsCreated} transaction{summary.transactionsCreated === 1 ? "" : "s"}
        </li>
        {summary.hypothesesAdded ? <li>{summary.hypothesesAdded} lead(s) pinned as notes</li> : null}
        {summary.traces.map((t) => (
          <li key={t.address}>
            Traced <code>{t.address}</code> — {t.nodes} nodes, {t.edges} edges, risk {t.riskScore} ({t.riskLevel})
            {t.truncated.length ? <span className="muted"> · truncated: {t.truncated.join("; ")}</span> : null}
          </li>
        ))}
        {summary.tracesFailed.map((t) => (
          <li key={t.address} className="field-error">
            Could not trace {t.address}: {t.reason}
          </li>
        ))}
        {summary.indicatorsSkipped.map((s, i) => (
          <li key={i} className="muted">
            Skipped {s.value}: {s.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------------- ask */

function AskTab({ caseId, available }: { caseId: string; available: boolean }): JSX.Element {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<{ q: string; a: AiChatAnswer }[]>([]);
  const [useDocs, setUseDocs] = useState(true);

  const docs = useQuery<{ documents: CaseDocument[] }>(useDocs ? `/api/ai/cases/${caseId}/documents` : null, [caseId]);

  async function ask(e: FormEvent): Promise<void> {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ answer: AiChatAnswer }>(`/api/ai/cases/${caseId}/ask`, {
        question: q,
        documentIds: useDocs ? (docs.data?.documents ?? []).map((d) => d.id) : []
      });
      setAnswers((prev) => [...prev, { q, a: res.answer }]);
      setQuestion("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The assistant could not answer.");
    } finally {
      setBusy(false);
    }
  }

  if (!available) {
    return (
      <div className="ai-panel-body">
        <p className="muted">The assistant needs a configured model provider. See the note above.</p>
      </div>
    );
  }

  return (
    <div className="ai-panel-body">
      <form className="ai-ask" onSubmit={ask}>
        <textarea
          className="ai-ask-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about this case, e.g. “Which counterparty received the most, and is it labelled?”"
          rows={3}
          maxLength={2000}
        />
        <label className="check sm">
          <input type="checkbox" checked={useDocs} onChange={(e) => setUseDocs(e.target.checked)} />
          <span>Include the attached documents</span>
        </label>
        <button className="btn primary" type="submit" disabled={busy || question.trim().length < 3}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {answers.map((item, i) => (
        <div key={i} className="ai-answer">
          <div className="ai-answer-q">{item.q}</div>
          <div className="ai-answer-a">{item.a.answer}</div>
          <div className="ai-answer-foot">
            <Badge tone={item.a.confidence === "high" ? "ok" : item.a.confidence === "medium" ? "warn" : "neutral"}>
              {item.a.confidence} confidence
            </Badge>
            {item.a.insufficientData ? <Badge tone="neutral">insufficient data</Badge> : null}
          </div>
          {item.a.citations.length ? (
            <div className="ai-cites">
              {item.a.citations.map((c, j) => (
                <span key={j} className="ai-cite">
                  {c.kind}: {c.label}
                  {c.locator ? <span className="muted"> {c.locator}</span> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      <p className="muted ai-ask-hint">
        Answers are grounded in this case's own records. The model cannot query the database directly, and
        says so when the case does not contain enough to answer.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ format */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
