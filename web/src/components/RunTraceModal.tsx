import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Chain, DemoCaseSummary, TraceMethod, TraceResponse } from "../types";
import { Field, Modal, Notice } from "./ui";

export interface RunTraceModalProps {
  open: boolean;
  caseId: string;
  defaultChain: Chain;
  defaultAddress?: string;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Methods an investigator can pick, described in terms of what they claim.
 *
 * The wording is the point: each entry states the assumption the method makes,
 * because the choice is a judgement about co-mingling, not a preference.
 */
const METHODS: { value: TraceMethod | "ai"; label: string; blurb: string; disabled?: boolean }[] = [
  {
    value: "direct",
    label: "Direct — only clean pass-throughs",
    blurb:
      "Follows a hop only when a single transfer carries the whole quantity. If the funds were split, it reports nothing rather than guessing. Use when you need a finding you can defend without caveats."
  },
  {
    value: "fifo",
    label: "FIFO — oldest funds first",
    blurb:
      "Consumes the oldest outbound transfers until the quantity is exhausted. Use when the wallet's history suggests the funds were moved promptly and in order."
  },
  {
    value: "pro_rata",
    label: "Pro-rata — split by observed amounts",
    blurb:
      "Apportioning across every outbound transfer in proportion to what each actually moved. Conserves the total exactly, so the figures add up. The default when no better assumption is available."
  },
  {
    value: "haircut",
    label: "Haircut — pro-rata, discounted",
    blurb:
      "Pro-rata with each share reduced at every split to reflect co-mingling uncertainty. Treat the result as a floor on what moved."
  },
  {
    value: "poison",
    label: "Poison-pill — assume the worst",
    blurb:
      "Treats every output of a co-mingled wallet as potentially holding the entire quantity. Deliberately over-attributes, so totals exceed the amount traced. Use to bound the exposure, never to state a total."
  },
  {
    value: "ai",
    label: "AI-Assisted Analysis (unavailable)",
    blurb: "This option is a placeholder for future work and cannot be selected.",
    disabled: true
  }
];

export function RunTraceModal({
  open,
  caseId,
  defaultChain,
  defaultAddress,
  onClose,
  onDone
}: RunTraceModalProps): JSX.Element {
  const [address, setAddress] = useState(defaultAddress || "");
  const [chain, setChain] = useState<Chain>(defaultChain);
  const [direction, setDirection] = useState<"forward" | "backward" | "both">("forward");
  const [maxHops, setMaxHops] = useState(3);
  const [offline, setOffline] = useState(false);

  // The investigation question. An empty amount means "follow everything",
  // which is a legitimate and different question, not an unset field.
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState("");
  const [method, setMethod] = useState<TraceMethod | "ai">("pro_rata");

  const [demoCases, setDemoCases] = useState<DemoCaseSummary[]>([]);
  const [demoCaseId, setDemoCaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveAsset = asset.trim() || (chain === "bitcoin" ? "BTC" : chain === "tron" ? "TRX" : chain === "polygon" ? "MATIC" : "ETH");

  const amountError = useMemo(() => {
    const trimmed = amount.trim();
    if (!trimmed) return null;
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return "Enter a plain positive number, for example 12.5";
    if (Number(trimmed) <= 0) return "The amount must be greater than zero";
    return null;
  }, [amount]);

  const selectedDemo = demoCases.find((d) => d.id === demoCaseId) ?? null;

  useEffect(() => {
    if (!open) return;
    setChain(defaultChain);
    setError(null);
    // The demo catalogue is static, so it is fetched once per open rather than
    // on every render.
    let cancelled = false;
    api
      .get<{ cases: DemoCaseSummary[] }>("/api/chain/demo-cases")
      .then((r) => {
        if (!cancelled) setDemoCases(r.cases);
      })
      .catch(() => {
        // A missing catalogue only costs the demo picker; the trace still works.
        if (!cancelled) setDemoCases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, defaultChain]);

  // Adopting a scenario fills in the question it was built to answer, so the
  // investigator starts from a working example rather than a blank form.
  useEffect(() => {
    if (!selectedDemo) return;
    setAmount(selectedDemo.amount);
    setAsset(selectedDemo.asset);
    setMethod(selectedDemo.suggestedMethod);
  }, [selectedDemo]);

  const runningDemo = demoCaseId !== "";
  const canRun = !busy && !amountError && (runningDemo || address.trim() !== "" || caseId !== "");

  async function run(): Promise<void> {
    if (method === "ai") {
      alert("AI-Assisted Analysis is not available yet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post<TraceResponse>("/api/chain/trace", {
        // A demo is not attached to a case: its entities are invented, so
        // binding them to a real investigation would contaminate it.
        caseId: runningDemo ? undefined : caseId,
        demoCaseId: runningDemo ? demoCaseId : undefined,
        address: runningDemo ? undefined : address.trim() || undefined,
        chain: runningDemo ? selectedDemo?.chain : chain,
        maxHops,
        direction,
        offline,
        amountToTrace: amount.trim() || undefined,
        asset: effectiveAsset,
        method
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The trace could not be completed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trace funds"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canRun} onClick={run}>
            {busy ? "Tracing…" : runningDemo ? "Run scenario" : "Run trace"}
          </button>
        </>
      }
    >
      <div className="stack">
        {demoCases.length > 0 ? (
          <Field
            label="Scenario"
            hint="Optional. A scenario is invented data that shows one tracing behaviour without touching a real wallet."
          >
            <select value={demoCaseId} onChange={(e) => setDemoCaseId(e.target.value)}>
              <option value="">Live investigation — query a real address</option>
              {demoCases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {runningDemo ? (
          <Notice tone="warn" title="Simulated data">
            <p>
              <strong>
                {selectedDemo?.name ?? "This scenario"} is synthetic.
              </strong>{" "}
              Every address, transaction, amount and score is invented and corresponds to no real blockchain activity. Results
              from this run are for learning the tool and must never be cited as a finding.
            </p>
            {selectedDemo ? <p className="field-hint">{selectedDemo.teaches}</p> : null}
          </Notice>
        ) : null}

        {!runningDemo ? (
          <>
            <Field label="Root address" hint="Leave blank to trace from this case's first hop-0 entity.">
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="mono"
                placeholder="Use case entity"
              />
            </Field>
            <Field label="Chain">
              <select value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
                <option value="bitcoin">Bitcoin</option>
                <option value="ethereum">Ethereum</option>
                <option value="tron">Tron</option>
                <option value="polygon">Polygon</option>
              </select>
            </Field>
          </>
        ) : null}

        <div className="row-2">
          <Field
            label="Amount to trace"
            hint="Optional. Leave blank to follow every transfer instead of one quantity."
            error={amountError ?? undefined}
          >
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mono"
              inputMode="decimal"
              placeholder="e.g. 25"
            />
          </Field>
          <Field label="Asset" hint={amount.trim() ? "The unit the quantity is in." : "Used to label the trace."}>
            <input value={asset} onChange={(e) => setAsset(e.target.value)} placeholder={effectiveAsset} maxLength={16} />
          </Field>
        </div>

        {!amount.trim() && !runningDemo ? (
          <Notice tone="info" title="No amount set — this traces every movement">
            <p>
              With no quantity nominated, the graph shows every observed transfer rather than following a specific sum. The
              reconciliation figures will be marked <em>not applicable</em>, because there is no total to account for.
            </p>
          </Notice>
        ) : null}

        <Field label="Attribution method" hint="Only matters once the funds split.">
          <select
            value={method}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "ai") return;
              setMethod(v as TraceMethod);
            }}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value} disabled={m.disabled} title={m.disabled ? "This option is not yet available." : undefined}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="field-hint method-blurb">{METHODS.find((m) => m.value === method)?.blurb}</p>

        <Field label="Direction" hint="Forward follows funds outward; backward follows them inward; both does each.">
          <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
            <option value="forward">Forward — where the funds went</option>
            <option value="backward">Backward — where the funds came from</option>
            <option value="both">Both directions</option>
          </select>
        </Field>

        <Field label="How far to follow" hint="Each extra hop multiplies the work. Start small and widen if the trail goes cold.">
          <select value={maxHops} onChange={(e) => setMaxHops(Number(e.target.value))}>
            <option value={1}>1 hop — direct counterparties</option>
            <option value={2}>2 hops</option>
            <option value={3}>3 hops — recommended</option>
            <option value={4}>4 hops</option>
            <option value={5}>5 hops</option>
            <option value={6}>6 hops — slow, may time out</option>
          </select>
        </Field>

        <label className="check">
          <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} />
          <span>
            Use stored records only
            <span className="field-hint">
              Skips live chain calls. Faster and works offline, but only sees what has already been ingested, so the graph
              reflects our own past records rather than the chain.
            </span>
          </span>
        </label>

        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
