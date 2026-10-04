import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../lib/toast";
import type { Chain } from "../types";
import { Field, Modal, Notice } from "./ui";

export interface AddEvidenceModalProps {
  open: boolean;
  caseId: string;
  defaultChain: Chain;
  defaultAddress?: string;
  defaultTxHash?: string;
  onClose: () => void;
  onAdded: () => void;
}

export function AddEvidenceModal({
  open,
  caseId,
  defaultChain,
  defaultAddress,
  defaultTxHash,
  onClose,
  onAdded
}: AddEvidenceModalProps): JSX.Element {
  const toast = useToast();
  const [kind, setKind] = useState("snapshot");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chain, setChain] = useState<Chain>(defaultChain);
  const [address, setAddress] = useState(defaultAddress || "");
  const [txHash, setTxHash] = useState(defaultTxHash || "");
  const [fetchLive, setFetchLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChain(defaultChain);
      setError(null);
    }
  }, [open, defaultChain]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Collect evidence"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || title.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post("/api/evidence", {
                  caseId,
                  kind,
                  title: title.trim(),
                  description: description.trim() || undefined,
                  chain,
                  address: address.trim() || undefined,
                  txHash: txHash.trim() || undefined,
                  fetchLive
                });
                toast.success("Evidence collected and hashed");
                onAdded();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Collection failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Collecting…" : "Collect & seal"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="info" title="How sealing works">
          <p>
            The content is canonicalised (object keys sorted), hashed with SHA-256, and stored with the digest. Verifying
            later recomputes the hash. Live captures record the source and the fact that a public endpoint was used, so
            staleness stays visible.
          </p>
        </Notice>
        <Field label="Kind" required>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="snapshot">Snapshot — chain state at a moment</option>
            <option value="transaction">Transaction</option>
            <option value="address_profile">Address profile</option>
            <option value="label">Label — third-party attribution</option>
            <option value="note">Analyst note</option>
            <option value="attachment">Attachment</option>
            <option value="report_snapshot">Report snapshot</option>
          </select>
        </Field>
        <Field label="Title" required>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={300} />
        </Field>
        <Field label="Description">
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </Field>
        <Field label="Chain">
          <select value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
            <option value="bitcoin">Bitcoin</option>
            <option value="ethereum">Ethereum</option>
            <option value="tron">Tron</option>
            <option value="polygon">Polygon</option>
          </select>
        </Field>
        <Field label="Address" hint="Subject address, if any.">
          <input value={address} onChange={(e) => setAddress(e.target.value)} className="mono" />
        </Field>
        <Field label="Transaction hash" hint="Subject transaction, if any.">
          <input value={txHash} onChange={(e) => setTxHash(e.target.value)} className="mono" />
        </Field>
        <label className="check">
          <input type="checkbox" checked={fetchLive} onChange={(e) => setFetchLive(e.target.checked)} />
          <span>
            Fetch live from the chain now
            <span className="field-hint">
              Requires an address or hash. Public endpoints can be stale; the provenance is recorded either way.
            </span>
          </span>
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}