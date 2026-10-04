import type { RiskFactor, RiskLevel } from "../types";

/**
 * Client-side mirror of the server's scoring curve.
 *
 * This exists only for the one projection that does not carry a score: the
 * case entity list returns stored risk factors but not `entities.risk_score`.
 * The formula is duplicated from `server/src/risk/engine.ts:186-230` and must
 * change with it.
 *
 * Order matters and this is where the previous version was wrong. The server
 * bands the *saturated* score (`engine.ts:220` computes it, `:221` bands it).
 * Banding the raw sum first makes the level disagree with the number printed
 * beside it — a raw sum of 31 yields "Low" while its saturated score of 43 sits
 * in the Medium band, so the badge and the meter contradict each other.
 */
export const RISK_THRESHOLDS = {
  critical: 75,
  high: 55,
  medium: 35,
  low: 15
} as const;

export type RiskThresholds = { -readonly [K in keyof typeof RISK_THRESHOLDS]: number };

export function levelFor(score: number, t: RiskThresholds = RISK_THRESHOLDS): RiskLevel {
  if (score >= t.critical) return "Critical";
  if (score >= t.high) return "High";
  if (score >= t.medium) return "Medium";
  if (score >= t.low) return "Low";
  return "Unrated";
}

/** Confidence-weighted additive sum, before the saturating curve. */
export function rawRisk(factors: Pick<RiskFactor, "weight" | "confidence">[]): number {
  return factors.reduce((sum, f) => sum + f.weight * f.confidence, 0);
}

/** Saturating curve: many weak signals cannot add up to a Critical on their own. */
export function curve(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(100 * (1 - Math.exp(-raw / 55)))));
}

/** Full client-side derivation, in the same order the server uses. */
export function deriveRisk(
  factors: Pick<RiskFactor, "weight" | "confidence">[],
  t: RiskThresholds = RISK_THRESHOLDS
): { score: number; level: RiskLevel } {
  const score = curve(rawRisk(factors));
  return { score, level: levelFor(score, t) };
}
