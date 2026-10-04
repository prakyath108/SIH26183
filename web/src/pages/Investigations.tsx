import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { playCasePriorityBeep } from "../lib/sound";
import { useDebounce, useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { CaseListResponse, MetaResponse } from "../types";
import {
  Card,
  CaseStatusBadge,
  ChainBadge,
  DataTable,
  ErrorState,
  Field,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  RiskBadge,
  SearchInput
} from "../components/ui";
import { dateTime, num, relative } from "../lib/format";
import { CloseCaseModal } from "../components/CloseCaseModal";

const STATUSES = ["Open", "In Progress", "Under Review", "Escalated", "Closed"] as const;
const PRIORITIES = ["Critical", "High", "Medium", "Low", "Unrated"] as const;

export default function Investigations(): JSX.Element {
  const { can, user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [q, setQ] = useState("");
  const debounced = useDebounce(q);
  const [status, setStatus] = useState("");
  const [chain, setChain] = useState("");
  const [priority, setPriority] = useState("");
  const [referral, setReferral] = useState("");
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState("updated");
  const [offset, setOffset] = useState(0);

  const [createOpen, setCreateOpen] = useState(params.get("new") === "1");
  const [closing, setClosing] = useState<{ id: string; caseRef: string } | null>(null);

  const debouncedReferral = useDebounce(referral);
  const path = `/api/cases${ApiClientQS({ q: debounced, status, chain, priority, referral: debouncedReferral, mine: mine ? "true" : "", sort, limit: 25, offset })}`;
  const { data, error, loading, reload } = useQuery<CaseListResponse>(path, [debounced, status, chain, priority, debouncedReferral, mine, sort, offset]);
  const meta = useQuery<MetaResponse>("/api/reports/meta");

  // Any filter change invalidates the current page offset.
  useEffect(() => setOffset(0), [debounced, status, chain, priority, debouncedReferral, mine, sort]);

  useEffect(() => {
    if (params.get("new") === "1") {
      setCreateOpen(true);
      params.delete("new");
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  return (
    <>
      <PageHeader
        title="Blockchain Investigations"
        subtitle="Every case, its status, and the entities attached to it."
        actions={
          <>
            <button className="btn" onClick={reload}>
              Refresh
            </button>
            {can("case:write") ? (
              <button className="btn primary" onClick={() => setCreateOpen(true)}>
                New investigation
              </button>
            ) : null}
          </>
        }
      />

      <Card
        title={
          <span>
            Cases{" "}
            <span className="count-pill">{num(data?.total ?? 0)}</span>
          </span>
        }
        flush
      >
        <div className="filter-bar">
          <SearchInput value={q} onChange={setQ} placeholder="Search title, reference or description…" />
          <SearchInput value={referral} onChange={setReferral} placeholder="Filter by referral source…" />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="">All chains</option>
            {(meta.data?.chains ?? ["bitcoin", "ethereum", "tron", "polygon"]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">Recently updated</option>
            <option value="opened">Recently opened</option>
            <option value="priority">Priority</option>
          </select>
          {can("case:read") ? (
            <label className="check inline">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              <span>Assigned to me</span>
            </label>
          ) : null}
          {q || status || chain || priority || referral || mine ? (
            <button
              className="btn ghost sm"
              onClick={() => {
                setQ("");
                setStatus("");
                setChain("");
                setPriority("");
                setReferral("");
                setMine(false);
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        {error ? <ErrorState error={error} onRetry={reload} /> : null}

        <DataTable
          rows={data?.cases ?? []}
          loading={loading}
          onRowClick={(c) => navigate(`/investigations/${c.id}`)}
          empty={
            q || status || chain || priority || mine
              ? "No cases match these filters."
              : "No investigations yet. Create one to start collecting entities and evidence."
          }
          columns={[
            {
              key: "ref",
              header: "Case",
              render: (c) => (
                <div>
                  <span className="mono strong">{c.case_ref}</span>
                  <div className="sub">{c.title}</div>
                </div>
              )
            },
            { key: "chain", header: "Chain", render: (c) => <ChainBadge chain={c.chain} /> },
            { key: "status", header: "Status", render: (c) => <CaseStatusBadge status={c.status} /> },
            { key: "priority", header: "Priority", render: (c) => <RiskBadge level={c.priority} /> },
            {
              key: "counts",
              header: "Contents",
              align: "right",
              render: (c) => (
                <span className="counts">
                  <span title="Linked entities">{num(c.entity_count ?? 0)} ent.</span>
                  <span title="Evidence items">{num(c.evidence_count ?? 0)} ev.</span>
                  {c.open_alert_count ? <span className="warn-text">{c.open_alert_count} alert</span> : null}
                </span>
              )
            },
            {
              key: "lead",
              header: "Lead",
              render: (c) =>
                c.lead_name ? (
                  <span title={c.lead_email ?? undefined}>
                    {c.lead_name}
                    {c.lead_investigator_id === user?.id ? <span className="sub"> (you)</span> : null}
                  </span>
                ) : (
                  <span className="muted">Unassigned</span>
                )
            },
            {
              key: "updated",
              header: "Updated",
              align: "right",
              render: (c) => <span title={dateTime(c.updated_at)}>{relative(c.updated_at)}</span>
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (c) =>
                can("case:close") && c.status !== "Closed" ? (
                  <button
                    className="btn ghost sm"
                    onClick={(e) => {
                      // The row itself navigates to the case; closing is a
                      // separate decision and must not be triggered by accident.
                      e.stopPropagation();
                      setClosing({ id: c.id, caseRef: c.case_ref });
                    }}
                  >
                    Close
                  </button>
                ) : null
            }
          ]}
        />

        <Pagination limit={25} offset={offset} total={data?.total ?? 0} onChange={setOffset} />
      </Card>

      <CreateCaseModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id, ref) => {
          setCreateOpen(false);
          toast.success(`Created ${ref}`);
          reload();
          void navigate(`/investigations/${id}`);
        }}
      />

      <CloseCaseModal
        open={closing !== null}
        caseId={closing?.id ?? ""}
        caseRef={closing?.caseRef ?? ""}
        onClose={() => setClosing(null)}
        onClosed={() => {
          setClosing(null);
          toast.success("Case closed and logged to the audit trail");
          reload();
        }}
      />
    </>
  );
}

/** Query-string builder, kept local so this page has no dependency on the client. */
function ApiClientQS(params: Record<string, string | number>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function CreateCaseModal({
  open,
  onClose,
  onCreated
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, ref: string) => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chain, setChain] = useState("bitcoin");
  const [priority, setPriority] = useState("Unrated");
  const [seed, setSeed] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setSeed("");
      setReferralSource("");
      setError(null);
      setFieldErrors({});
    }
  }, [open]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await api.post<{ case: { id: string; case_ref: string } }>("/api/cases", {
        title: title.trim(),
        description: description.trim() || undefined,
        chain,
        priority,
        seed: seed.trim() || undefined,
        referralSource: referralSource.trim() || undefined
      });
      // Play beep for high/critical priority cases
      playCasePriorityBeep(priority);
      onCreated(res.case.id, res.case.case_ref);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError("Could not create the case.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New investigation"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || title.trim().length < 3}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create case"}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Title" required error={fieldErrors.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} />
        </Field>

        <Field label="Chain" required hint="Used as the default for tracing and evidence collection on this case.">
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="bitcoin">Bitcoin</option>
            <option value="ethereum">Ethereum</option>
            <option value="tron">Tron</option>
            <option value="polygon">Polygon</option>
            <option value="unknown">Unknown / cross-chain</option>
          </select>
        </Field>

        <Field label="Priority" hint="Initial triage priority. This is a workflow field, not a risk score.">
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>

        <Field
          label="Description"
          hint="What prompted this investigation, and what is being looked for."
          error={fieldErrors.description}
        >
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </Field>

        <Field
          label="Seed address or transaction hash (optional)"
          error={fieldErrors.seed}
          hint="An address is attached as the hop-0 entity. A transaction hash is resolved: the largest payable output is attached as hop 0 and every alternative output is listed on the case, because nothing on-chain says which output continues the funds."
        >
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="bc1q…, 0x…, or a 64-character tx hash"
            className="mono"
          />
        </Field>

        <Field
          label="Referral / allegation source (optional)"
          error={fieldErrors.referralSource}
          hint="Stored on the case as a filterable field, and recorded as a note for provenance."
        >
          <input value={referralSource} onChange={(e) => setReferralSource(e.target.value)} maxLength={500} />
        </Field>

        {error ? <Notice tone="danger">{error}</Notice> : null}
      </form>
    </Modal>
  );
}
