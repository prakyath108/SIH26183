import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import type { AlertsResponse, RiskDistributionResponse, RiskRulesResponse } from "../types";
import {
  Badge,
  Card,
  DataTable,
  Grid,
  Kpi,
  KpiRow,
  PageHeader,
  Tabs
} from "../components/ui";
import { BarSeries, Donut, ThresholdScale } from "../components/charts";
import { RiskDisclaimer } from "../components/RiskPanel";
import { num, relative } from "../lib/format";

const BAND_COLORS: Record<string, string> = {
  Critical: "var(--risk-critical)",
  High: "var(--risk-high)",
  Medium: "var(--risk-medium)",
  Low: "var(--risk-low)",
  Unrated: "var(--surface-3)"
};

type Tab = "distribution" | "factors" | "rules" | "alerts";

export default function Risk(): JSX.Element {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("distribution");

  const dist = useQuery<RiskDistributionResponse>("/api/reports/risk-distribution");
  const rules = useQuery<RiskRulesResponse>("/api/reports/risk-rules");
  const alerts = useQuery<AlertsResponse>(can("alert:read") ? "/api/alerts?limit=200" : null);

  const total = dist.data?.bands.reduce((s, b) => s + b.n, 0) ?? 0;
  const critical = dist.data?.bands.find((b) => b.band === "Critical")?.n ?? 0;
  const high = dist.data?.bands.find((b) => b.band === "High")?.n ?? 0;
  const avgScore = dist.data?.byChain.length
    ? dist.data.byChain.reduce((s, c) => s + Number(c.avg_score), 0) / dist.data.byChain.length
    : null;

  return (
    <>
      <PageHeader
        title="Heuristic Risk Engine Configuration"
        subtitle="Distribution of scores, the factors driving them, and the rules behind both."
        actions={
          <button className="btn" onClick={() => { dist.reload(); rules.reload(); }}>
            Refresh
          </button>
        }
      />

      <RiskDisclaimer />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "distribution", label: "Distribution" },
          { id: "factors", label: "Factors" },
          { id: "rules", label: "Rules" },
          { id: "alerts", label: "Risk alerts" }
        ]}
      />

      {tab === "distribution" ? (
        <>
          <KpiRow cols={4}>
            <Kpi label="Scored entities" value={num(total)} />
            <Kpi label="Critical" value={num(critical)} tone="critical" />
            <Kpi label="High" value={num(high)} tone="high" />
            <Kpi label="Mean score" value={avgScore === null ? "—" : avgScore.toFixed(1)} sub="across all chains" />
          </KpiRow>

          <Grid cols={2}>
            <Card title="Score bands" hint="Every scored entity, bucketed by its final band.">
              {dist.data ? (
                <Donut
                  size={150}
                  segments={dist.data.bands.map((b) => ({
                    label: b.band,
                    value: b.n,
                    color: BAND_COLORS[b.band] ?? "var(--surface-3)"
                  }))}
                />
              ) : null}
            </Card>

            <Card title="Thresholds in effect">
              <ThresholdScale thresholds={dist.data?.thresholds ?? {}} />
              <p className="field-hint">
                Bands are fixed at these cut-offs. Weights per rule are administrator-configurable and change scores
                without moving the bands.
              </p>
            </Card>
          </Grid>

          <Card title="Mean score by chain" hint="Comparability caveat: chain coverage differs, so this is not a league table.">
            {dist.data?.byChain.length ? (
              <BarSeries
                data={dist.data.byChain.map((c) => ({ label: c.chain, value: Number(c.avg_score) }))}
                height={170}
              />
            ) : (
              <p className="muted">No scored entities yet.</p>
            )}
            {dist.data?.byChain.length ? (
              <table className="data dense">
                <thead>
                  <tr>
                    <th>Chain</th>
                    <th className="right">Entities</th>
                    <th className="right">Mean score</th>
                  </tr>
                </thead>
                <tbody>
                  {dist.data.byChain.map((c) => (
                    <tr key={c.chain}>
                      <td>{c.chain}</td>
                      <td className="right num">{num(c.n)}</td>
                      <td className="right num">{c.avg_score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Card>
        </>
      ) : null}

      {tab === "factors" ? (
        <Card
          title="Most frequent factors"
          hint="How many stored entities carry each factor. A factor appearing often is not automatically a true positive."
        >
          {dist.data?.factors.length ? (
            <>
              <BarSeries
                height={200}
                data={dist.data.factors.slice(0, 10).map((f) => ({ label: f.label, value: f.n }))}
              />
              <table className="data dense">
                <thead>
                  <tr>
                    <th>Factor</th>
                    <th>Rule code</th>
                    <th className="right">Entities</th>
                  </tr>
                </thead>
                <tbody>
                  {dist.data.factors.map((f) => (
                    <tr key={f.code}>
                      <td>{f.label}</td>
                      <td className="mono small">{f.code}</td>
                      <td className="right num">{num(f.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="muted">No factors recorded. Score some entities by looking them up in the explorer.</p>
          )}
        </Card>
      ) : null}

      {tab === "rules" ? (
        <Card
          title="Rule set"
          hint="The complete, auditable basis for every score in the system."
          actions={
            <Link className="btn ghost sm" to="/admin?tab=risk">
              Adjust weights
            </Link>
          }
          flush
        >
          <DataTable
            rows={rules.data?.rules ?? []}
            loading={rules.loading}
            empty="No rules loaded."
            columns={[
              {
                key: "label",
                header: "Rule",
                render: (r) => (
                  <div>
                    <span className="strong">{r.label}</span>
                    <div className="sub mono">{r.code}</div>
                  </div>
                )
              },
              {
                key: "detail",
                header: "What it detects",
                render: (r) => (
                  <div>
                    <span className="small">{r.detail}</span>
                    {r.limitations ? <div className="sub">Limitation: {r.limitations}</div> : null}
                  </div>
                )
              },
              {
                key: "source",
                header: "Source",
                render: (r) => <span className="small">{r.source}</span>
              },
              {
                key: "weight",
                header: "Default weight",
                align: "right",
                render: (r) => num(r.defaultWeight)
              },
              {
                key: "confidence",
                header: "Confidence",
                align: "right",
                render: (r) => `${Math.round(r.confidence * 100)}%`
              }
            ]}
          />
          <div className="card-foot">
            <p className="field-hint">
              Final score = round(100 × (1 − e<sup>−Σ(weight × confidence) / 55</sup>)). The saturating curve stops many
              weak signals from outvoting one strong one.
            </p>
          </div>
        </Card>
      ) : null}

      {tab === "alerts" ? (
        <Card title="Alerts arising from risk factors" hint="Raised by an on-demand scan over stored entities." flush>
          <DataTable
            rows={alerts.data?.alerts ?? []}
            loading={alerts.loading}
            empty="No alerts. Run a scan from the Alerts module to evaluate stored entities."
            columns={[
              {
                key: "title",
                header: "Alert",
                render: (a) => (
                  <div>
                    <span>{a.title}</span>
                    <div className="sub mono">{a.category}</div>
                  </div>
                )
              },
              {
                key: "severity",
                header: "Severity",
                render: (a) => <Badge tone={a.severity}>{a.severity}</Badge>
              },
              {
                key: "state",
                header: "State",
                render: (a) => <Badge tone={a.state === "open" ? "critical" : a.state === "resolved" ? "ok" : "neutral"}>{a.state}</Badge>
              },
              { key: "when", header: "When", align: "right", render: (a) => relative(a.created_at) }
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}
