import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useDebounce, useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { Chain, VaspLabelsResponse, VaspRegisterResponse } from "../types";
import {
  Badge,
  Card,
  ChainBadge,
  Copyable,
  DataTable,
  Details,
  ErrorState,
  Field,
  Modal,
  Notice,
  PageHeader,
  SearchInput,
  Tabs
} from "../components/ui";
import { dateTime, num, relative, usd } from "../lib/format";

const KINDS = ["exchange", "mixer", "bridge", "sanctioned", "darknet", "service"] as const;

type Tab = "labels" | "register";

export default function Vasp(): JSX.Element {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("labels");
  const [q, setQ] = useState("");
  const debounced = useDebounce(q);
  const [chain, setChain] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("active");
  const [addOpen, setAddOpen] = useState(false);
  const [challenge, setChallenge] = useState<{ id: string; name: string; address: string } | null>(null);

  const labels = useQuery<VaspLabelsResponse>(
    `/api/vasp/labels${qs({ q: debounced, chain, kind, status })}`,
    [debounced, chain, kind, status]
  );
  const register = useQuery<VaspRegisterResponse>(tab === "register" ? "/api/vasp/register" : null, [tab]);

  return (
    <>
      <PageHeader
        title="VASP Label & Compliance Intelligence"
        subtitle="Attributions for exchanges, mixers, bridges and other service providers, with the source behind each one."
        actions={
          can("label:challenge") ? (
            <button className="btn primary" onClick={() => setAddOpen(true)}>
              Record attribution
            </button>
          ) : null
        }
      />

      <Notice tone="warn" title="What a label is, and is not">
        <p>
          {labels.data?.disclaimer ??
            "Labels are third-party or analyst attributions with a recorded source. They can be stale, incomplete or incorrect and are never evidence of identity or wrongdoing on their own."}
        </p>
      </Notice>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "labels", label: "Attributions", count: labels.data?.labels.length },
          { id: "register", label: "VASP register", count: register.data?.register.length }
        ]}
      />

      {tab === "labels" ? (
        <>
          <Card
            title={`Attributions (${num(labels.data?.labels.length ?? 0)})`}
            flush
            actions={
              <div className="filter-bar inline">
                <SearchInput value={q} onChange={setQ} placeholder="Search name, address, source…" />
                <select value={chain} onChange={(e) => setChain(e.target.value)}>
                  <option value="">All chains</option>
                  {["bitcoin", "ethereum", "tron", "polygon"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">All types</option>
                  {KINDS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="challenged">Challenged</option>
                  <option value="retracted">Retracted</option>
                  <option value="">Any status</option>
                </select>
              </div>
            }
          >
            {labels.error ? <ErrorState error={labels.error} onRetry={labels.reload} /> : null}
            <DataTable
              rows={labels.data?.labels ?? []}
              loading={labels.loading}
              empty="No attributions match these filters. Seed data includes a small set; add more as they are verified."
              columns={[
                {
                  key: "name",
                  header: "Attribution",
                  render: (l) => (
                    <div>
                      <span className="strong">{l.name}</span>
                      <div className="sub">
                        <Badge tone={l.kind === "sanctioned" ? "critical" : l.kind === "mixer" ? "high" : "neutral"}>
                          {l.kind}
                        </Badge>{" "}
                        <ChainBadge chain={l.chain} />
                        {l.status !== "active" ? (
                          <Badge tone="warn">{l.status}</Badge>
                        ) : null}
                      </div>
                    </div>
                  )
                },
                { key: "address", header: "Address", render: (l) => <Copyable value={l.address} /> },
                {
                  key: "source",
                  header: "Source",
                  render: (l) =>
                    l.source_url ? (
                      <a href={l.source_url} target="_blank" rel="noreferrer noopener" className="small">
                        {l.source}
                      </a>
                    ) : (
                      <span>{l.source}</span>
                    )
                },
                {
                  key: "confidence",
                  header: "Confidence",
                  render: (l) => (
                    <Badge tone={l.confidence === "high" ? "high" : l.confidence === "medium" ? "medium" : "low"}>
                      {l.confidence}
                    </Badge>
                  )
                },
                {
                  key: "observed",
                  header: "Observed",
                  align: "right",
                  render: (l) => <span title={dateTime(l.observed_at)}>{relative(l.observed_at)}</span>
                },
                {
                  key: "action",
                  header: "",
                  align: "right",
                  render: (l) =>
                    can("label:challenge") && l.status === "active" ? (
                      <button
                        className="btn ghost sm"
                        onClick={() => setChallenge({ id: l.id, name: l.name, address: l.address })}
                      >
                        Challenge
                      </button>
                    ) : l.challenge_reason ? (
                      <Details summary="Reason">
                        <p className="small">{l.challenge_reason}</p>
                      </Details>
                    ) : null
                }
              ]}
            />
          </Card>

          {labels.data?.byKind.length ? (
            <Card title="Coverage by type" hint="Active attributions only.">
              <div className="chip-wrap">
                {labels.data.byKind.map((k) => (
                  <Badge key={k.kind} tone="neutral">
                    {k.kind}: {k.n}
                  </Badge>
                ))}
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {tab === "register" ? (
        <>
          <Notice tone="info" title="Scope of this register">
            <p>
              {register.data?.notice ??
                "This register records operator-entered attributions, not an official VASP list."}
            </p>
          </Notice>
          <Card title="VASP Address Registry" flush>
            {register.error ? <ErrorState error={register.error} onRetry={register.reload} /> : null}
            <DataTable
              rows={register.data?.register ?? []}
              loading={register.loading}
              empty="No exchange attributions recorded."
              columns={[
                { key: "name", header: "Provider", render: (r) => <span className="strong">{r.name}</span> },
                { key: "chain", header: "Chain", render: (r) => <ChainBadge chain={r.chain} /> },
                { key: "address", header: "Address", render: (r) => <Copyable value={r.address} /> },
                {
                  key: "source",
                  header: "Source",
                  render: (r) =>
                    r.source_url ? (
                      <a href={r.source_url} target="_blank" rel="noreferrer noopener" className="small">
                        {r.source}
                      </a>
                    ) : (
                      r.source
                    )
                },
                {
                  key: "confidence",
                  header: "Confidence",
                  render: (r) => <Badge tone={r.confidence === "high" ? "high" : "medium"}>{r.confidence}</Badge>
                },
                { key: "cases", header: "Linked cases", align: "right", render: (r) => num(r.linked_cases) },
                {
                  key: "volume",
                  header: "Case value",
                  align: "right",
                  render: (r) => usd(r.case_volume_usd, { fallback: "not priced" })
                }
              ]}
            />
          </Card>
        </>
      ) : null}

      <AddLabelModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); labels.reload(); }} />
      <ChallengeModal
        challenge={challenge}
        onClose={() => setChallenge(null)}
        onDone={() => {
          setChallenge(null);
          labels.reload();
        }}
      />
    </>
  );
}

function qs(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function AddLabelModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }): JSX.Element {
  const toast = useToast();
  const [chain, setChain] = useState<Chain>("bitcoin");
  const [address, setAddress] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("exchange");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [confidence, setConfidence] = useState<"low" | "medium" | "high">("medium");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record an attribution"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || name.trim().length < 2 || source.trim().length < 2 || address.trim().length < 10}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post("/api/vasp/labels", {
                  chain,
                  address: address.trim(),
                  kind,
                  name: name.trim(),
                  source: source.trim(),
                  sourceUrl: sourceUrl.trim() || undefined,
                  confidence,
                  note: note.trim() || undefined
                });
                toast.success("Attribution recorded");
                setName("");
                setAddress("");
                setSource("");
                setSourceUrl("");
                setNote("");
                onAdded();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not record the attribution");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Record"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="info">
          <p>
            Every attribution needs a source. A label with no provenance is an opinion, and it will not survive challenge
            from another analyst.
          </p>
        </Notice>
        <Field label="Chain" required>
          <select value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
            <option value="bitcoin">Bitcoin</option>
            <option value="ethereum">Ethereum</option>
            <option value="tron">Tron</option>
            <option value="polygon">Polygon</option>
          </select>
        </Field>
        <Field label="Address" required>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className="mono" />
        </Field>
        <Field label="Type" required>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </Field>
        <Field label="Name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Source" required hint="Who asserts this, and how you verified it.">
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>
        <Field label="Source URL" hint="Optional, but a link makes the claim checkable.">
          <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" />
        </Field>
        <Field label="Confidence" hint="How much weight this attribution deserves in risk scoring.">
          <select value={confidence} onChange={(e) => setConfidence(e.target.value as typeof confidence)}>
            <option value="low">Low — weak or indirect</option>
            <option value="medium">Medium — reasonable support</option>
            <option value="high">High — directly documented</option>
          </select>
        </Field>
        <Field label="Note">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

function ChallengeModal({
  challenge,
  onClose,
  onDone
}: {
  challenge: { id: string; name: string; address: string } | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      open={Boolean(challenge)}
      onClose={onClose}
      title="Challenge an attribution"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={busy || reason.trim().length < 10}
            onClick={async () => {
              if (!challenge) return;
              setBusy(true);
              setError(null);
              try {
                await api.post(`/api/vasp/labels/${challenge.id}/challenge`, { reason: reason.trim() });
                toast.success("Challenge recorded");
                setReason("");
                onDone();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not record the challenge");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Recording…" : "Record challenge"}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          Challenging marks <strong>{challenge?.name}</strong> at{" "}
          <span className="mono">{challenge?.address}</span> as disputed. The original attribution is never deleted — the
          dispute is recorded alongside it, so the provenance chain stays auditable.
        </p>
        <Field
          label="Why is this attribution incorrect?"
          required
          hint="Be specific. This is retained as part of the case record and may be read by other agencies."
        >
          <textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
