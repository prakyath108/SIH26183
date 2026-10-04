import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { ChainHealthRow, IntegrationsResponse } from "../types";
import {
  Badge,
  Card,
  ChainBadge,
  DataTable,
  ErrorState,
  Field,
  isUnloaded,
  Kpi,
  KpiRow,
  Modal,
  NOT_LOADED,
  Notice,
  PageHeader
} from "../components/ui";
import { dateTime, num } from "../lib/format";

const KINDS = ["node", "indexer", "rpc", "intelligence", "storage"] as const;

export default function Integrations(): JSX.Element {
  const { can } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const { data, error, loading, reload } = useQuery<IntegrationsResponse>("/api/admin/integrations");

  const healthy = data?.health.filter((h) => h.ok).length ?? 0;
  const enabledCount = data?.integrations.filter((i) => i.enabled).length ?? 0;
  const loaded = !isUnloaded({ data, error, loading });

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Chain providers, indexers and intelligence sources this deployment depends on."
        actions={
          can("integration:manage") ? (
            <button className="btn primary" onClick={() => setAddOpen(true)}>
              Add integration
            </button>
          ) : null
        }
      />

      <Notice tone="info" title="How secrets are handled here">
        <p>
          {data?.securityNote ??
            "API keys are referenced by name, never stored here. Supply them through environment variables or a secrets manager so they are not captured in exports or logs."}
        </p>
      </Notice>

      <KpiRow cols={3}>
        <Kpi
          label="Configured integrations"
          value={loaded ? num(data!.integrations.length) : NOT_LOADED}
          sub={loaded ? `${enabledCount} enabled` : undefined}
        />
        <Kpi
          label="Healthy providers"
          value={loaded ? `${healthy} / ${data!.health.length}` : NOT_LOADED}
          tone={loaded ? (healthy === data!.health.length ? "ok" : "warn") : undefined}
        />
        <Kpi
          label="Unhealthy"
          value={loaded ? num(data!.health.length - healthy) : NOT_LOADED}
          tone={loaded && healthy !== data!.health.length ? "high" : undefined}
        />
      </KpiRow>

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      <Card title="Provider health" hint="Live check against each chain adapter.">
        <div className="chain-grid">
          {(data?.health ?? []).map((h) => (
            <HealthTile key={h.chain} h={h} />
          ))}
        </div>
      </Card>

      <Card title="Effective configuration" hint="Resolved from environment variables at runtime." flush>
        <DataTable
          rows={Object.entries(data?.effective ?? {}).map(([name, v]) => ({ name, ...v }))}
          loading={loading}
          empty={loaded ? "No providers resolved." : null}
          columns={[
            { key: "name", header: "Provider", render: (r) => <span className="strong">{r.name}</span> },
            { key: "url", header: "Endpoint", render: (r) => <span className="mono small">{r.baseUrl}</span> },
            {
              key: "auth",
              header: "Auth",
              render: (r) => <Badge tone={r.auth.startsWith("none") ? "warn" : "ok"}>{r.auth}</Badge>
            },
            { key: "note", header: "Note", render: (r) => <span className="small">{r.note ?? "—"}</span> }
          ]}
        />
      </Card>

      <Card title="Registered integrations" hint="Saved provider definitions. Upsert by name." flush>
        <DataTable
          rows={data?.integrations ?? []}
          loading={loading}
          empty={
            loaded
              ? "No integrations registered yet. Add one to document a provider this deployment should use."
              : null
          }
          columns={[
            {
              key: "name",
              header: "Name",
              render: (i) => (
                <div>
                  <span className="strong">{i.name}</span>
                  <div className="sub">
                    <Badge tone="neutral">{i.kind}</Badge> {i.chain ? <ChainBadge chain={i.chain} /> : null}
                  </div>
                </div>
              )
            },
            { key: "url", header: "Endpoint", render: (i) => <span className="mono small">{i.base_url ?? "—"}</span> },
            {
              key: "key",
              header: "Key reference",
              render: (i) =>
                i.api_key_ref ? <span className="mono small">{i.api_key_ref}</span> : <span className="muted">none</span>
            },
            {
              key: "rate",
              header: "Rate limit",
              align: "right",
              render: (i) => `${num(i.rate_limit_per_min)}/min`
            },
            {
              key: "enabled",
              header: "Enabled",
              render: (i) => <Badge tone={i.enabled ? "ok" : "neutral"}>{i.enabled ? "enabled" : "disabled"}</Badge>
            },
            {
              key: "updated",
              header: "Updated",
              align: "right",
              render: (i) => dateTime(i.updated_at)
            }
          ]}
        />
      </Card>

      <AddIntegrationModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); reload(); }} />
    </>
  );
}

function HealthTile({ h }: { h: ChainHealthRow }): JSX.Element {
  return (
    <div className={`chain-tile ${h.ok ? "ok" : "warn"}`}>
      <div className="chain-tile-head">
        <ChainBadge chain={h.chain} />
        <strong>{h.name}</strong>
        <span className={`pill ${h.ok ? "ok" : "warn"}`}>{h.ok ? `${h.latencyMs}ms` : "unavailable"}</span>
      </div>
      <p className="field-hint">{h.detail}</p>
    </div>
  );
}

function AddIntegrationModal({
  open,
  onClose,
  onAdded
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("indexer");
  const [chain, setChain] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeyRef, setApiKeyRef] = useState("");
  const [rateLimit, setRateLimit] = useState(120);
  const [enabled, setEnabled] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add integration"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post("/api/admin/integrations", {
                  name: name.trim(),
                  kind,
                  chain: chain.trim() || undefined,
                  baseUrl: baseUrl.trim() || undefined,
                  apiKeyRef: apiKeyRef.trim() || undefined,
                  enabled,
                  rateLimitPerMin: rateLimit,
                  notes: notes.trim() || undefined
                });
                toast.success("Integration saved");
                setName("");
                setBaseUrl("");
                setApiKeyRef("");
                setNotes("");
                onAdded();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not save the integration");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="warn">
          <p>
            This records metadata only. It does not store a secret: put the key in the environment under the name given
            in “Key reference”, and it will be read from there at runtime.
          </p>
        </Notice>
        <Field label="Name" required hint="Upsert key: saving with an existing name updates it.">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Kind" required>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </Field>
        <Field label="Chain" hint="Optional. Leave blank for a cross-chain provider.">
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="">Any / cross-chain</option>
            {(["bitcoin", "ethereum", "tron", "polygon"] as ChainHealthRow["chain"][]).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Base URL" hint="Optional for providers reached over their public default endpoint.">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" />
        </Field>
        <Field label="API key reference" hint="The environment variable name, not the key itself.">
          <input value={apiKeyRef} onChange={(e) => setApiKeyRef(e.target.value)} placeholder="ETHERSCAN_API_KEY" className="mono" />
        </Field>
        <Field label="Rate limit per minute" hint="Client-side pacing, to stay inside provider quotas.">
          <input type="number" min={1} max={100000} value={rateLimit} onChange={(e) => setRateLimit(Number(e.target.value))} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
        <Field label="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
