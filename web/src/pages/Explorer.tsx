import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { JSX } from "react";
import { api, ApiError } from "../lib/api";
import { useDebounce, useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type {
  AddressTransactionsResponse,
  Chain,
  Detection,
  LookupResponse,
  NormalizedTransaction,
  SupportedChainsResponse
} from "../types";
import { normalizeTxRow } from "../lib/normalize";
import {
  Badge,
  Card,
  ChainBadge,
  Copyable,
  DataTable,
  Details,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  SearchInput
} from "../components/ui";
import { RiskPanel } from "../components/RiskPanel";
import { chainName, dateTime, num, native, relative, usd } from "../lib/format";

type Tab = "address" | "transaction" | "history";

export default function Explorer(): JSX.Element {
  const { can } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();

  const [input, setInput] = useState(params.get("q") ?? "");
  const [tab, setTab] = useState<Tab>("address");
  const [result, setResult] = useState<LookupResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<AddressTransactionsResponse | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  const supported = useQuery<SupportedChainsResponse>("/api/chain/supported");
  const health = useQuery<{ chains: { chain: Chain; ok: boolean; detail: string; latencyMs: number }[] }>(
    can("case:read") ? "/api/chain/health" : null
  );

  const debounced = useDebounce(input, 400);
  const [detection, setDetection] = useState<Detection | null>(null);

  // Live format feedback while typing, so a pasted identifier is validated
  // before the user commits to a lookup.
  useEffect(() => {
    if (debounced.trim().length < 4) {
      setDetection(null);
      return;
    }
    let cancelled = false;
    api
      .get<Detection>(`/api/chain/detect?input=${encodeURIComponent(debounced.trim())}`)
      .then((d) => {
        if (!cancelled) setDetection(d.recognized ? d : null);
      })
      .catch(() => {
        if (!cancelled) setDetection(null);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  useEffect(() => {
    setResult(null);
    setError(null);
    setHistory(null);
  }, [tab]);

  async function lookup(): Promise<void> {
    const value = input.trim();
    if (value.length < 4) return;
    setBusy(true);
    setError(null);
    setHistory(null);
    try {
      const res = await api.get<LookupResponse>(`/api/chain/lookup?input=${encodeURIComponent(value)}`);
      setResult(res);
      setTab(res.kind === "tx" ? "transaction" : "address");
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "unknown", "Lookup failed"));
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory(chain: Chain, address: string): Promise<void> {
    setHistoryBusy(true);
    try {
      setHistory(
        await api.get<AddressTransactionsResponse>(
          `/api/chain/address/${chain}/${encodeURIComponent(address)}/transactions?limit=25`
        )
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not load history");
    } finally {
      setHistoryBusy(false);
    }
  }

  const address = result?.kind === "address" ? result.address : undefined;

  return (
    <>
      <PageHeader
        title="Blockchain Forensics Explorer"
        subtitle="Look up an address or transaction, see what we hold about it, and score it against the rule set."
      />

      <Card>
        <div className="lookup-bar">
          <SearchInput
            value={input}
            onChange={setInput}
            placeholder="Paste a Bitcoin, EVM or Tron address, or a transaction hash…"
            autoFocus
          />
          <button className="btn primary" onClick={() => void lookup()} disabled={busy || input.trim().length < 4}>
            {busy ? "Looking up…" : "Look up"}
          </button>
        </div>

        {detection ? (
          <div className="detect-line">
            <Badge tone="ok">recognised</Badge>
            <span>
              {detection.type === "address" ? "Address" : "Transaction"} on{" "}
              <strong>{chainName(detection.chain)}</strong> · {detection.encoding}
            </span>
            {detection.ambiguousChains.length > 1 ? (
              <span className="muted">
                · also valid on {detection.ambiguousChains.filter((c) => c !== detection.chain).map(chainName).join(", ")}
              </span>
            ) : null}
          </div>
        ) : debounced.trim().length >= 4 ? (
          <p className="field-hint">Not yet a recognised identifier. Bitcoin (base58, bc1), EVM (0x…) or Tron (T…).</p>
        ) : null}
      </Card>

      {error ? <ErrorState error={error} /> : null}

      {!result && !error ? (
        <>
          <EmptyState action={<span className="muted">Results appear here.</span>}>
            Enter an identifier above to begin.
          </EmptyState>

          {supported.data ? (
            <Card title="Supported formats" hint={supported.data.note}>
              <div className="chain-grid">
                {supported.data.chains.map((c) => {
                  const h = health.data?.chains.find((x) => x.chain === c.id);
                  return (
                    <div key={c.id} className="chain-tile">
                      <div className="chain-tile-head">
                        <ChainBadge chain={c.id} />
                        <strong>{c.name}</strong>
                        {h ? (
                          <span className={`pill ${h.ok ? "ok" : "warn"}`} title={h.detail}>
                            {h.ok ? `${h.latencyMs}ms` : "unavailable"}
                          </span>
                        ) : null}
                      </div>
                      <code className="small">{c.addressExample}</code>
                      <p className="field-hint">
                        <a href={c.explorer} target="_blank" rel="noreferrer noopener">
                          {c.explorer}
                        </a>
                      </p>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {result?.kind === "address" && address ? (
        <>
          <Card
            title="Address"
            actions={
              <>
                {can("trace:run") ? (
                  <Link className="btn sm" to={`/fund-flow?address=${address.address}&chain=${address.chain}`}>
                    Trace fund flow
                  </Link>
                ) : null}
                {can("case:write") ? (
                  <Link className="btn sm ghost" to="/investigations?new=1">
                    Open a case
                  </Link>
                ) : null}
              </>
            }
          >
            <dl className="kv">
              <dt>Address</dt>
              <dd>
                <Copyable value={address.address} display={address.address} />
              </dd>
              <dt>Chain</dt>
              <dd>
                <ChainBadge chain={address.chain} /> {chainName(address.chain)}
              </dd>
              <dt>First seen</dt>
              <dd>{dateTime(address.firstSeen)}</dd>
              <dt>Last seen</dt>
              <dd>{dateTime(address.lastSeen)}</dd>
              <dt>Transactions</dt>
              <dd>{num(address.txCount)}</dd>
              <dt>Received</dt>
              <dd>{native(address.receivedTotal, undefined, 8)}</dd>
              <dt>Sent</dt>
              <dd>{native(address.sentTotal, undefined, 8)}</dd>
              <dt>Balance</dt>
              <dd>{native(address.balance, undefined, 8)}</dd>
            </dl>
            <p className="field-hint">
              Stored and scored during this lookup. A look-up is written to the audit trail.
            </p>
          </Card>

          {result.risk ? <RiskPanel risk={result.risk} /> : null}

          <Card
            title="Activity"
            hint="Stored records are preferred; a live provider is used when we hold nothing."
            actions={
              <button className="btn sm" onClick={() => void loadHistory(address.chain, address.address)} disabled={historyBusy}>
                {historyBusy ? "Loading…" : history ? "Refresh" : "Load activity"}
              </button>
            }
            flush
          >
            {history ? (
              <>
                {history.note ? <Notice tone="warn">{history.note}</Notice> : null}
                <TransactionTable rows={history.transactions} />
              </>
            ) : (
              <EmptyState>
                Activity is not loaded. On public EVM nodes, address history is usually unavailable — configure an
                indexed provider under Integrations for full coverage.
              </EmptyState>
            )}
          </Card>
        </>
      ) : null}

      {result?.kind === "tx" && result.transaction ? (
        <TransactionDetail tx={result.transaction} detection={result.detection} />
      ) : null}
    </>
  );
}

function TransactionDetail({
  tx,
  detection
}: {
  tx: NormalizedTransaction;
  detection?: Detection;
}): JSX.Element {
  return (
    <Card title="Transaction" actions={detection ? <ChainBadge chain={tx.chain} /> : null}>
      <dl className="kv">
        <dt>Hash</dt>
        <dd>
          <Copyable value={tx.txHash} display={tx.txHash} />
        </dd>
        <dt>Block</dt>
        <dd>{tx.blockHeight ?? "—"}</dd>
        <dt>Time</dt>
        <dd>{dateTime(tx.timestamp)}</dd>
        <dt>From</dt>
        <dd>
          {tx.from ? <Copyable value={tx.from} /> : <span className="muted">coinbase / mint</span>}
          {tx.inputCount != null && tx.inputCount > 1 ? (
            <div className="sub muted">first of {tx.inputCount} inputs</div>
          ) : null}
        </dd>
        <dt>To</dt>
        <dd>
          {tx.to ? <Copyable value={tx.to} /> : <span className="muted">contract deployment or burn</span>}
          {tx.outputCount != null && tx.outputCount > 1 ? (
            <div className="sub muted">first of {tx.outputCount} outputs</div>
          ) : null}
        </dd>
        {tx.inputCount != null ? (
          <>
            <dt>Total in</dt>
            <dd>{native(tx.inputTotal, "BTC", 8)}</dd>
            <dt>Total out</dt>
            <dd>{native(tx.outputTotal, "BTC", 8)}</dd>
            <dt>Inputs / outputs</dt>
            <dd>
              {num(tx.inputCount)} / {num(tx.outputCount)}
            </dd>
          </>
        ) : null}
        <dt>Value</dt>
        <dd>
          {native(tx.valueNative)} · {usd(tx.valueUsd)}
        </dd>
        <dt>Fee</dt>
        <dd>{native(tx.feeNative)}</dd>
        <dt>Status</dt>
        <dd>
          <Badge tone={tx.status === "confirmed" ? "ok" : tx.status === "failed" ? "critical" : "neutral"}>
            {tx.status}
          </Badge>
        </dd>
      </dl>

      {tx.inputs?.length || tx.outputs?.length ? (
        <UtxoTables tx={tx} />
      ) : null}

      {tx.transfers?.length ? (
        <Details summary={`Token transfers (${tx.transfers.length})`} defaultOpen>
          <table className="data dense">
            <thead>
              <tr>
                <th>Asset</th>
                <th>From</th>
                <th>To</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {tx.transfers.map((t, i) => (
                <tr key={i}>
                  <td>
                    {t.kind === "native" ? "native" : t.asset}
                    {t.contract ? <div className="sub mono">{shortish(t.contract)}</div> : null}
                  </td>
                  <td className="mono">{t.from ? shortish(t.from) : "—"}</td>
                  <td className="mono">{t.to ? shortish(t.to) : "—"}</td>
                  <td className="right num">{t.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Details>
      ) : null}

      {tx.raw ? (
        <Details summary="Raw provider response">
          <pre className="json">{JSON.stringify(tx.raw, null, 2)}</pre>
        </Details>
      ) : null}
    </Card>
  );
}

function UtxoTables({ tx }: { tx: NormalizedTransaction }): JSX.Element | null {
  const inputs = tx.inputs ?? [];
  const outputs = tx.outputs ?? [];
  if (!inputs.length && !outputs.length) return null;

  return (
    <>
      <Details summary={`Inputs (${inputs.length})`} defaultOpen>
        {inputs.length ? (
          <table className="data dense">
            <thead>
              <tr>
                <th>#</th>
                <th>Address</th>
                <th>Spends</th>
                <th className="right">Amount (BTC)</th>
              </tr>
            </thead>
            <tbody>
              {inputs.map((i) => (
                <tr key={i.index}>
                  <td className="num">{i.index}</td>
                  <td className="mono">
                    {i.address ? (
                      <Copyable value={i.address} display={i.address} />
                    ) : (
                      <span className="muted">{i.coinbase ? "coinbase (creates value)" : "—"}</span>
                    )}
                  </td>
                  <td className="mono small muted">
                    {i.spends ? `${shortish(i.spends.txid)}:${i.spends.vout}` : "—"}
                  </td>
                  <td className="right num">{i.coinbase ? "—" : i.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="field-hint">No inputs recorded.</p>
        )}
      </Details>

      <Details summary={`Outputs (${outputs.length})`} defaultOpen>
        {outputs.length ? (
          <table className="data dense">
            <thead>
              <tr>
                <th>#</th>
                <th>Address</th>
                <th className="right">Amount (BTC)</th>
              </tr>
            </thead>
            <tbody>
              {outputs.map((o) => (
                <tr key={o.index}>
                  <td className="num">{o.index}</td>
                  <td className="mono">
                    {o.address ? (
                      <Copyable value={o.address} display={o.address} />
                    ) : (
                      <span className="muted">unspendable / no address</span>
                    )}
                  </td>
                  <td className="right num">{o.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="field-hint">No outputs recorded.</p>
        )}
      </Details>
    </>
  );
}

export function TransactionTable({
  rows
}: {
  rows: AddressTransactionsResponse["transactions"];
}): JSX.Element {
  const txs = rows.map(normalizeTxRow);
  return (
    <DataTable
      rows={txs}
      empty="No transactions returned."
      dense
      columns={[
        {
          key: "hash",
          header: "Hash",
          render: (t) => <Copyable value={t.txHash} />
        },
        { key: "time", header: "Time", render: (t) => (t.timestamp ? relative(t.timestamp) : <span className="muted">unknown</span>) },
        { key: "from", header: "From", render: (t) => <span className="mono">{t.from ? shortish(t.from) : "—"}</span> },
        { key: "to", header: "To", render: (t) => <span className="mono">{t.to ? shortish(t.to) : "—"}</span> },
        { key: "value", header: "Value", align: "right", render: (t) => native(t.valueNative) },
        { key: "usd", header: "USD", align: "right", render: (t) => usd(t.valueUsd) },
        {
          key: "status",
          header: "Status",
          render: (t) => (
            <Badge tone={t.status === "confirmed" ? "ok" : t.status === "failed" ? "critical" : "neutral"}>
              {t.status}
            </Badge>
          )
        }
      ]}
    />
  );
}

function shortish(v: string): string {
  return v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v;
}
