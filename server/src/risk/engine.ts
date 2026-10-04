import type { Chain, MlAdvisory, RiskFactor, RiskLevel } from "../types.js";

export type { MlAdvisory };

/**
 * Explainable risk scoring.
 *
 * Design rules, per the project report:
 *  - Every factor carries source, observedAt, confidence and limitations.
 *  - Weights sum to a bounded 0-100 scale, and the score is a triage aid, not
 *    proof. Nothing here identifies a person or asserts wrongdoing.
 *  - A factor is only emitted when there is an underlying observation to cite.
 */

export const DEFAULT_THRESHOLDS = {
  critical: 75,
  high: 55,
  medium: 35,
  low: 15
} as const;

export function levelFor(score: number, t = DEFAULT_THRESHOLDS): RiskLevel {
  if (score >= t.critical) return "Critical";
  if (score >= t.high) return "High";
  if (score >= t.medium) return "Medium";
  if (score >= t.low) return "Low";
  return "Unrated";
}

export interface Label {
  chain: Chain;
  address: string;
  kind: "exchange" | "mixer" | "bridge" | "sanctioned" | "darknet" | "service";
  name: string;
  source: string;
  sourceUrl?: string;
  confidence: "low" | "medium" | "high";
  observedAt: string;
  note?: string;
}

export interface TraversalContext {
  /** Whole-transaction timing, in seconds, between consecutive hops. */
  hopIntervals: number[];
  /** True when the address consolidated many small inputs. */
  consolidationRatio: number | null;
  /** Number of distinct counterparties in the sampled window. */
  counterpartyCount: number;
  totalValueUsd: number;
  bridgeCrossings: number;
  labels: Label[];
  /** Analyst-supplied findings, treated as hypotheses with an author. */
  analystNotes: { note: string; author: string; at: string }[];
}

interface RuleInput {
  code: string;
  label: string;
  weight: number;
  confidence: number;
  detail: string;
  source: string;
  sourceUrl?: string;
  observedAt: string;
  evidence: RiskFactor["evidence"];
  limitations?: string;
  /** Optional gate: rule only fires when this returns true. */
  when?: (ctx: TraversalContext) => boolean;
}

const SEVERITY_WEIGHT = { critical: 40, high: 30, medium: 18, low: 8 } as const;

export const RULES: RuleInput[] = [
  {
    code: "mixer_interaction",
    label: "Mixer interaction",
    weight: 35,
    confidence: 0.85,
    detail: "Address transacted with a service labelled as a mixer or tumbler.",
    source: "CryptoTrace label store",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations:
      "Mixer labels are crowd-sourced and contested. Interaction is not proof of intent to obscure funds.",
    when: (ctx) => ctx.labels.some((l) => l.kind === "mixer")
  },
  {
    code: "sanctioned_exposure",
    label: "Exposure to sanctioned entity",
    weight: 40,
    confidence: 0.9,
    detail: "Counterparty matched a lawfully maintained restricted-party dataset.",
    source: "Sanctions screening (operator-configured feed)",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations:
      "Address matches are a screening lead only. Wallet addresses are pseudonymous; an address match does not identify a person or entity.",
    when: (ctx) => ctx.labels.some((l) => l.kind === "sanctioned")
  },
  {
    code: "bridge_exposure",
    label: "Cross-chain bridge exposure",
    weight: 22,
    confidence: 0.7,
    detail: "Funds crossed a bridge, which breaks native on-chain linkability.",
    source: "CryptoTrace label store",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations: "Bridges are also used legitimately; crossing one is not itself suspicious.",
    when: (ctx) => ctx.bridgeCrossings > 0
  },
  {
    code: "rapid_movement",
    label: "Rapid pass-through",
    weight: 25,
    confidence: 0.65,
    detail: "Value moved downstream within minutes of arriving, leaving little dwell time.",
    source: "Derived from on-chain timestamps",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations: "Automated and custodial flows also move quickly; timing alone is weak evidence.",
    when: (ctx) => ctx.hopIntervals.some((s) => s > 0 && s < 600)
  },
  {
    code: "consolidation_pattern",
    label: "Consolidation pattern",
    weight: 18,
    confidence: 0.6,
    detail: "Many small inputs were merged into a single output.",
    source: "Derived from on-chain transaction structure",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations: "Common in exchange batching and normal wallet management.",
    when: (ctx) => (ctx.consolidationRatio ?? 0) >= 3
  },
  {
    code: "high_fanout",
    label: "High counterparty fan-out",
    weight: 15,
    confidence: 0.55,
    detail: "Address interacted with an unusually large number of distinct counterparties.",
    source: "Derived from on-chain transaction structure",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations: "Exchanges and high-volume services show the same pattern legitimately.",
    when: (ctx) => ctx.counterpartyCount >= 50
  },
  {
    code: "exchange_deposit",
    label: "VASP deposit identified",
    weight: 12,
    confidence: 0.6,
    detail: "Address sent funds to an address labelled as a virtual asset service provider.",
    source: "CryptoTrace VASP register",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations: "Deposits are attributed to the VASP, not to any customer of the VASP.",
    when: (ctx) => ctx.labels.some((l) => l.kind === "exchange")
  },
  {
    code: "darknet_reference",
    label: "Darknet market reference",
    weight: 20,
    confidence: 0.6,
    detail: "Counterparty appears in a public darknet market reference list.",
    source: "Public market listings (operator-configured feed)",
    observedAt: new Date().toISOString(),
    evidence: [],
    limitations: "Stale listings remain online after markets close; presence is not current activity.",
    when: (ctx) => ctx.labels.some((l) => l.kind === "darknet")
  }
];

export interface RiskResult {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  methodology: string;
  caveats: string[];
  /**
   * Optional second opinion from the ML service, attached to root assessments
   * only. Null whenever it is unavailable or unfitted.
   *
   * Deliberately separate from `score`/`level` and never combined with them: the
   * rule result is the analyst-facing assessment, and blending a relative,
   * uncalibrated rank into it would make the cited factors no longer explain the
   * number shown.
   */
  mlAdvisory?: MlAdvisory | null;
}

const GLOBAL_CAVEATS = [
  "Risk scores prioritise analyst review. They are not findings of fact and do not establish identity or wrongdoing.",
  "Third-party labels may be stale, incomplete or incorrect. Analysts can challenge and correct any factor.",
  "A wallet address alone is not proof of a real-world identity."
];

export function scoreRisk(ctx: TraversalContext, extraWeights: Record<string, number> = {}): RiskResult {
  const now = new Date().toISOString();
  const factors: RiskFactor[] = [];

  for (const rule of RULES) {
    if (rule.when && !rule.when(ctx)) continue;

    const matched = ctx.labels.filter((l) => labelMatchesRule(l.kind, rule.code));
    const weight = extraWeights[rule.code] ?? rule.weight;

    const evidence: RiskFactor["evidence"] = [
      ...matched.map((l) => ({ address: l.address, valueUsd: undefined })),
      ...rule.evidence
    ].slice(0, 25);

    factors.push({
      code: rule.code,
      label: rule.label,
      weight,
      confidence: matched.length ? Math.min(1, rule.confidence * matched.length * 0.8) : rule.confidence,
      detail: matched.length
        ? `${rule.detail} Matched: ${matched.map((m) => `${m.name} (${m.confidence} confidence, ${m.source})`).join("; ")}`
        : rule.detail,
      source: matched.length ? matched[0]!.source : rule.source,
      ...(matched[0]?.sourceUrl ? { sourceUrl: matched[0].sourceUrl } : {}),
      observedAt: matched[0]?.observedAt ?? now,
      evidence,
      ...(rule.limitations ? { limitations: rule.limitations } : {})
    });
  }

  // Confidence-weighted additive score, saturating so many weak signals cannot
  // add up to a Critical rating on their own.
  const raw = factors.reduce((sum, f) => sum + f.weight * f.confidence, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 * (1 - Math.exp(-raw / 55)))));

  return {
    score,
    level: levelFor(score),
    factors: factors.sort((a, b) => b.weight * b.confidence - a.weight * a.confidence),
    methodology:
      "Weighted sum of rule matches, each discounted by confidence and passed through a saturating curve to 0-100. Weights are operator-configurable.",
    caveats: GLOBAL_CAVEATS
  };
}

function labelMatchesRule(kind: Label["kind"], code: string): boolean {
  switch (code) {
    case "mixer_interaction":
      return kind === "mixer";
    case "sanctioned_exposure":
      return kind === "sanctioned";
    case "bridge_exposure":
      return kind === "bridge";
    case "exchange_deposit":
      return kind === "exchange";
    case "darknet_reference":
      return kind === "darknet";
    default:
      return false;
  }
}

export function riskForSeverity(severity: keyof typeof SEVERITY_WEIGHT): { weight: number; confidence: number } {
  return { weight: SEVERITY_WEIGHT[severity], confidence: 0.9 };
}
