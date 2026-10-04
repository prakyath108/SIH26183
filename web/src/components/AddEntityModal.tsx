import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../lib/toast";
import { Field, Modal, Notice } from "./ui";

export interface AddEntityModalProps {
  open: boolean;
  caseId: string;
  defaultAddress?: string;
  onClose: () => void;
  onAdded: () => void;
}

export function AddEntityModal({
  open,
  caseId,
  defaultAddress,
  onClose,
  onAdded
}: AddEntityModalProps): JSX.Element {
  const toast = useToast();
  const [address, setAddress] = useState(defaultAddress || "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setAddress("");
      setNote("");
      setError(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Attach entity"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || address.trim().length < 10}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post(`/api/cases/${caseId}/entities`, { address: address.trim(), note: note.trim() || undefined });
                toast.success("Entity attached");
                onAdded();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not attach the entity");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Attaching…" : "Attach"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Address or transaction hash" required hint="Format is validated and the chain inferred server-side.">
          <input value={address} onChange={(e) => setAddress(e.target.value)} className="mono" autoFocus />
        </Field>
        <Field label="Why is this entity relevant?">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}