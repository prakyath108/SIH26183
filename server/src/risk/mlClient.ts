import { env } from "../config.js";
import type { MlAdvisory } from "../types.js";
import type { TraversalContext } from "./engine.js";

/**
 * Client for the advisory ML service (`services/risk-service`).
 *
 * Design constraints, all of which follow from the service being a second
 * opinion rather than a source of truth:
 *
 * 1. **Fail open, always.** Every failure mode — unreachable, slow, 500,
 *    malformed JSON, a response that disagrees with the request — resolves to
 *    `null`. An advisory that cannot be obtained must never fail the case
 *    creation or address lookup that asked for it, because a missing second
 *    opinion is strictly better than a lost case file.
 * 2. **Never invent a score.** `null` means no advisory. There is no default,
 *    no zero, no "unrated" stand-in: in this domain a fabricated number is
 *    indistinguishable from an assessed one once it is in a case file.
 * 3. **No caching.** A score is cheap but case state is not, and a cached
 *    advisory served against a newer traversal would be actively misleading.
 */

interface ScoreResponse {
  ready?: unknown;
  score?: unknown;
  level?: unknown;
  calibrated?: unknown;
  bandBasis?: unknown;
  modelVersion?: unknown;
  trainedAt?: unknown;
  caveat?: unknown;
}

/** True when the response is a usable advisory rather than "no model fitted". */
function parseAdvisory(body: unknown): MlAdvisory | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as ScoreResponse;

  // `ready: false` is the documented steady state with no model. It is not an
  // error, so it must not be logged as one.
  if (r.ready !== true) return null;
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) return null;

  return {
    score: Math.min(100, Math.max(0, r.score)),
    // A band is optional: without one the score still orders the queue, and an
    // absent label is better than an invented one.
    level: typeof r.level === "string" ? r.level : "",
    calibrated: r.calibrated === true,
    bandBasis: typeof r.bandBasis === "string" ? r.bandBasis : null,
    modelVersion: typeof r.modelVersion === "string" ? r.modelVersion : "unknown",
    trainedAt: typeof r.trainedAt === "string" ? r.trainedAt : null,
    caveat:
      typeof r.caveat === "string" && r.caveat.length > 0
        ? r.caveat
        : "Advisory model output. Not a finding of fact and not analyst-reviewed.",
  };
}

/**
 * Ask the advisory service to score a traversal.
 *
 * Returns `null` whenever no advisory is available, including when the service
 * is disabled, unreachable, or has no model fitted.
 */
export async function fetchAdvisory(ctx: TraversalContext): Promise<MlAdvisory | null> {
  if (!env.riskServiceAvailable) return null;

  // The service accepts an unmodified TraversalContext and ignores the label and
  // analyst-note fields (the rule engine owns those), so no mapping is needed
  // here beyond the request envelope.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.RISK_SERVICE_TIMEOUT_MS);

  try {
    const res = await fetch(`${env.riskServiceUrl}/v1/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[risk] advisory service returned ${res.status}; continuing without it`);
      return null;
    }
    return parseAdvisory(await res.json());
  } catch (err) {
    // Logged at warn, not error: an absent advisory is expected, and erroring
    // here would train operators to ignore the log.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[risk] advisory unavailable (${reason}); continuing without it`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}