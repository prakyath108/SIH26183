import type { MlAdvisory, RiskFactor, RiskResult, TraceGraph } from "../types";
import { RISK_TONE, dateTime, shortId } from "../lib/format";
import { Badge, Details, Meter, Notice } from "./ui";

/**
 * Risk explanation panel.
 *
 * The ordering is deliberate: score first, then the caveats, then the factors
 * with their source, confidence and limitations. A score shown without its
 * provenance is the fastest way to turn a triage aid into a finding of fact.
 */
export function RiskPanel({
  risk,
  compact = false
}: {
  risk: Pick<RiskResult, "score" | "level" | "factors" | "mlAdvisory">;
  compact?: boolean;
}): JSX.Element {
  return (
    <div className="risk-panel">
      <div className="risk-head">
        <div className="risk-score-block">
          <span className="risk-score" aria-label={`Risk score ${risk.score} out of 100`}>
            {risk.score}
          </span>
          <div>
            <Badge tone={RISK_TONE[risk.level] ?? "neutral"}>{risk.level}</Badge>
            <Meter value={risk.score} tone={RISK_TONE[risk.level] ?? "unrated"} />
          </div>
        </div>
        <p className="risk-note">
          Triage signal from configurable rules. Not a determination of wrongdoing and not evidence of identity.
        </p>
      </div>

      {risk.factors.length === 0 ? (
        <p className="muted">No risk factors matched. This is not the same as a clean address.</p>
      ) : (
        <ol className="factor-list">
          {risk.factors.map((f, i) => (
            <li key={`${f.code}-${i}`} className="factor">
              <div className="factor-head">
                <span className="factor-label">{f.label}</span>
                <span className="factor-meta">
                  <Badge tone="neutral" title="Rule weight before confidence discounting">
                    ×{f.weight}
                  </Badge>
                  <Badge tone={f.confidence >= 0.8 ? "high" : f.confidence >= 0.6 ? "medium" : "low"}>
                    {Math.round(f.confidence * 100)}% conf.
                  </Badge>
                </span>
              </div>
              <p className="factor-detail">{f.detail}</p>
              {!compact ? <FactorProvenance factor={f} /> : null}
            </li>
          ))}
        </ol>
      )}

      <MlAdvisoryNote advisory={risk.mlAdvisory} />
    </div>
  );
}

/**
 * The ML second opinion, quarantined below the rule factors.
 *
 * Rendered last and visually subordinate on purpose. It is a relative rank, so
 * a value that reads as "High" may simply mean "unusual compared with the sample
 * the model was trained on" — presenting it beside the rule score at equal
 * weight would invite an analyst to treat two different kinds of number as one.
 * The bands are uncalibrated, so that is stated outright rather than implied.
 */
export function MlAdvisoryNote({ advisory }: { advisory?: MlAdvisory | null }): JSX.Element | null {
  if (!advisory) return null;
  return (
    <div className="ml-advisory">
      <div className="ml-advisory-head">
        <span className="ml-advisory-title">Model advisory</span>
        <Badge tone="neutral" title="Advisory only. The rule score above remains the assessment.">
          second opinion
        </Badge>
        <span className="ml-advisory-score mono">
          {advisory.score}
          <span className="muted"> / 100 relative</span>
        </span>
        {advisory.level ? <span className="ml-advisory-band">{advisory.level}</span> : null}
      </div>
      <p className="ml-advisory-detail">
        Structure only (timing, fan-out, consolidation, value spread). It does not weigh sanctions, mixers or darknet
        exposure — those remain the rule factors above.
      </p>
      <p className="ml-advisory-detail">
        <strong>{advisory.level || "This band"}</strong> means how unusual the shape is compared with traffic like the
        model&rsquo;s training sample — not how serious it is. Nothing here is evidence of wrongdoing.
      </p>
      <p className="ml-advisory-detail muted">
        {advisory.caveat} Model {advisory.modelVersion}
        {advisory.trainedAt ? `, trained ${advisory.trainedAt.slice(0, 10)}` : ""}.
      </p>
    </div>
  );
}

function FactorProvenance({ factor }: { factor: RiskFactor }): JSX.Element {
  return (
    <div className="factor-prov">
      <span>
        Source:{" "}
        {factor.sourceUrl ? (
          <a href={factor.sourceUrl} target="_blank" rel="noreferrer noopener">
            {factor.source}
          </a>
        ) : (
          factor.source
        )}
      </span>
      <span>Observed {dateTime(factor.observedAt)}</span>
      {factor.evidence.length ? (
        <span>
          Evidence:{" "}
          {factor.evidence.slice(0, 3).map((e, i) => (
            <span key={i} className="mono">
              {e.txHash ? shortId(e.txHash, 8, 6) : e.address ? shortId(e.address, 8, 6) : "—"}
              {i < Math.min(3, factor.evidence.length) - 1 ? ", " : ""}
            </span>
          ))}
        </span>
      ) : null}
      {factor.limitations ? (
        <span className="factor-limitation">Limitation: {factor.limitations}</span>
      ) : null}
    </div>
  );
}

/**
 * Advisory attached to a trace graph root.
 *
 * Exported separately because a trace carries no per-factor breakdown for the
 * root, so the full RiskPanel would show an empty factor list and imply the
 * score had no explanation. This renders only the advisory, under a heading
 * that makes clear the rule score it accompanies is the assessment.
 */
export function GraphRiskAdvisory({ graph }: { graph: Pick<TraceGraph, "mlAdvisory"> }): JSX.Element | null {
  if (!graph.mlAdvisory) return null;
  return (
    <MlAdvisoryNote advisory={graph.mlAdvisory} />
  );
}

/** Full methodology disclosure, for the places where a score is exported. */
export function RiskMethodology({ methodology, caveats }: { methodology?: string; caveats?: string[] }): JSX.Element | null {
  if (!methodology && !caveats?.length) return null;
  return (
    <Details summary="Scoring methodology and caveats">
      {methodology ? <p>{methodology}</p> : null}
      {caveats?.length ? (
        <ul>
          {caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
    </Details>
  );
}

/** Standing disclaimer used at the top of modules that display risk. */
export function RiskDisclaimer(): JSX.Element {
  return (
    <Notice tone="info" title="How to read these scores">
      <p>
        Scores rank review priority. They are produced by weighted rules discounted by source confidence, and the weights
        are operator-configurable. A score is not a finding of fact, does not identify a person, and does not establish
        unlawful conduct. Always read the factors and their sources before acting on a number.
      </p>
    </Notice>
  );
}
