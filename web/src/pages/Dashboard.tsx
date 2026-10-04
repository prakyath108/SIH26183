import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { DashboardResponse } from "../types";
import {
  Card,
  ChainBadge,
  DataTable,
  ErrorState,
  Grid,
  Kpi,
  KpiRow,
  Notice,
  PageHeader,
  RiskBadge,
  SeverityBadge
} from "../components/ui";
import { ActivityChart, Donut, ThresholdScale } from "../components/charts";
import { dateTime, num, relative, shortId, usd } from "../lib/format";
import { RiskDisclaimer } from "../components/RiskPanel";

const RISK_COLORS: Record<string, string> = {
  Critical: "var(--risk-critical)",
  High: "var(--risk-high)",
  Medium: "var(--risk-medium)",
  Low: "var(--risk-low)",
  Unrated: "var(--surface-3)"
};

/** Maps a 0-100 score onto the same bands the risk engine labels entities with. */
function bandOf(score: number | null): { tone: string; label: string } {
  if (score == null) return { tone: "unrated", label: "Unrated" };
  if (score >= 85) return { tone: "critical", label: "Critical" };
  if (score >= 70) return { tone: "high", label: "High" };
  if (score >= 45) return { tone: "medium", label: "Moderate" };
  if (score >= 20) return { tone: "low", label: "Low" };
  return { tone: "unrated", label: "Minimal" };
}

export default function Dashboard(): JSX.Element {
  const { can } = useAuth();
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [exporting, setExporting] = useState(false);
  const { data: stats, error, loading, reload } = useQuery<DashboardResponse>(
    `/api/reports/dashboard?days=${days}`
  );
  const active = loading;

  // The design shows a single "Systemic Risk Index". We surface the highest
  // real entity score rather than inventing a portfolio composite.
  const systemicScore = stats?.topRisk?.length
    ? Math.max(...stats.topRisk.map((r) => r.risk_score ?? 0))
    : null;
  const { tone: systemicTone, label: systemicLabel } = bandOf(systemicScore);

  return (
    <>
      <PageHeader
        title="Tactical Command Center"
        subtitle="Portfolio-level view across investigations, entities and risk signals."
        actions={
          <>
            <div className="seg">
              {[7, 30, 90].map((d) => (
                <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
                  {d}D
                </button>
              ))}
            </div>
            <button className="btn" onClick={reload}>
              Refresh
            </button>
            {can("evidence:export") ? (
              <button
                className="btn"
                disabled={exporting}
                title={`Export the portfolio summary for the ${days}-day window as a PDF`}
                onClick={async () => {
                  setExporting(true);
                  try {
                    const stamp = new Date().toISOString().slice(0, 10);
                    await api.download(
                      `/api/reports/dashboard/export.pdf?days=${days}`,
                      `cryptotrace-portfolio-${days}d-${stamp}.pdf`
                    );
                    toast.success("Portfolio summary downloaded");
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : "Export failed");
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                {exporting ? "Exporting…" : "Export PDF"}
              </button>
            ) : null}
            {can("case:write") ? (
              <Link className="btn primary" to="/investigations?new=1">
                New Case
              </Link>
            ) : null}
          </>
        }
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {stats?.caveat ? (
        <Notice tone="info" title="Read this before the numbers">
          <p>{stats.caveat}</p>
        </Notice>
      ) : null}

      <KpiRow cols={4}>
        <Kpi
          label="Active Investigations"
          value={num(stats?.kpis.open_cases, "—")}
          sub={`${num(stats?.kpis.critical_cases, "0")} critical`}
          tone={stats?.kpis.critical_cases ? "warn" : undefined}
        />
        <Kpi label="Monitored Wallets" value={num(stats?.kpis.entities, "—")} sub={`${num(stats?.kpis.high_risk, "0")} scoring 55+`} />
        <Kpi
          label="Critical Action Required"
          value={num(stats?.kpis.open_alerts, "—")}
          sub={`${num(stats?.kpis.critical_alerts, "0")} critical`}
          tone={stats?.kpis.critical_alerts ? "danger" : undefined}
        />
        <Kpi
          label="Traced Value"
          value={usd(stats?.kpis.traced_usd, { fallback: "not priced" })}
          sub={`${num(stats?.kpis.evidence, "0")} evidence items`}
        />
      </KpiRow>

      <Grid cols={3}>
        <Card title="Anomaly Threat Distribution" hint="Cases by priority across every investigation.">
          {stats ? (
            <Donut
              size={140}
              segments={stats.riskMix.map((s) => ({
                label: s.priority,
                value: s.n,
                color: RISK_COLORS[s.priority] ?? "var(--surface-3)"
              }))}
            />
          ) : null}
        </Card>

        <Card title="Systemic Risk Index" hint="Derived from the highest-scoring managed entities.">
          {stats ? (
            <>
              <div className={`risk-score-block tone-${systemicTone}`}>
                <span
                  className={`risk-score ${systemicTone}`}
                  title="Highest individual entity score currently on file; not a portfolio-wide regulatory measure."
                >
                  {systemicScore}/100
                </span>
                <span className="chain-tag">{systemicLabel}</span>
              </div>
              <p className="risk-note" style={{ marginTop: 10 }}>
                This mirrors the highest entity score on record, so it is a review priority signal — not a systemic or
                regulatory assessment. Aggregate figures need a defensible methodology before publication.
              </p>
            </>
          ) : null}
        </Card>

        <Card title={`${days}-Day Forensic Activity`} hint="Cases opened and closed over the selected window.">
          {stats ? <ActivityChart data={stats.activity} height={150} /> : null}
        </Card>
      </Grid>

      <Grid cols={2}>
        <Card
          title="Highest-risk entities"
          hint="Ranked by score across every case. Select one to see its factors."
          actions={
            <Link className="btn ghost sm" to="/risk">
              Risk Engine
            </Link>
          }
          flush
        >
          <DataTable
            rows={stats?.topRisk ?? []}
            loading={active}
            empty="No entities have been scored yet. Run a trace or look up an address to begin."
            columns={[
              {
                key: "address",
                header: "Entity",
                render: (r) => (
                  <div>
                    <span className="mono">{shortId(r.address, 10, 6)}</span>
                    <div className="sub">
                      {r.label ?? r.kind} <ChainBadge chain={r.chain} />
                    </div>
                  </div>
                )
              },
              {
                key: "risk",
                header: "Risk",
                render: (r) => <RiskBadge level={r.risk_level} score={r.risk_score} />
              },
              {
                key: "cases",
                header: "Cases",
                align: "right",
                render: (r) => num(r.linked_cases)
              }
            ]}
          />
        </Card>

        <Card
          title="Recent Incidents Feed"
          hint="Live and acknowledged alerts, newest first."
          actions={
            can("alert:read") ? (
              <Link className="btn ghost sm" to="/alerts">
                Alert Triage
              </Link>
            ) : null
          }
          flush
        >
          <DataTable
            rows={stats?.recentAlerts ?? []}
            loading={active}
            empty="No open alerts. Run a scan from the Alerts module to evaluate stored entities against the rule set."
            columns={[
              {
                key: "title",
                header: "Alert",
                render: (r) => (
                  <div>
                    <span>{r.title}</span>
                    <div className="sub">
                      <SeverityBadge severity={r.severity} /> <span className="mono">{r.category}</span>
                      {r.case_ref ? (
                        <>
                          {" · "}
                          <span className="mono">{r.case_ref}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                )
              },
              {
                key: "when",
                header: "When",
                align: "right",
                render: (r) => <span title={dateTime(r.created_at)}>{relative(r.created_at)}</span>
              }
            ]}
          />
        </Card>
      </Grid>

      <Card
        title="Risk thresholds in effect"
        hint="The bands used to label every score in the system. Administrators can retune these under Administration."
      >
        <ThresholdScale thresholds={stats?.thresholds ?? {}} />
        <RiskDisclaimer />
      </Card>

      <Card
        title="Node Sync & Coverage"
        hint="Provider reachability per chain. Block heights are only shown when a provider reports one."
      >
        <div className="chain-grid">
          {(stats?.chains ?? []).map((c) => (
            <div key={c.chain} className="chain-tile">
              <div className="chain-tile-head">
                <ChainBadge chain={c.chain} />
                <strong>{c.name}</strong>
              </div>
              <a href={c.explorer} target="_blank" rel="noreferrer noopener" className="mono small">
                {c.explorer}
              </a>
            </div>
          ))}
        </div>
        <p className="field-hint">
          Generated {dateTime(stats?.generatedAt)} · EVM address history is only available where an indexed provider is
          configured. Without one, lookups still return balance and nonce.
        </p>
      </Card>
    </>
  );
}
