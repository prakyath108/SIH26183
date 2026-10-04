/**
 * Fixed-point decimal helpers for fund attribution.
 *
 * Native amounts on every supported chain are integers in the base unit, and
 * the API surfaces them as decimal strings. Attributing a specific quantity
 * across a split means repeatedly taking a share of a value, so binary floating
 * point is not an option: 0.1 + 0.2 !== 0.3 would show up in the reconciliation
 * panel as phantom unresolved funds.
 *
 * These operate on BigInt-scaled decimals with an explicit working precision
 * rather than parsing to `number`, so a large satoshi amount cannot lose its
 * low-order digits.
 */

/** Working precision for intermediate division. */
const SCALE = 18n;
const SCALE_DEC = 18;

/** Parse a decimal string into a BigInt scaled by 10^SCALE. */
function toScaled(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const s = String(value).trim();
  if (!s || s === "0") return 0n;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [intPart = "0", decPart = ""] = body.split(".");
  // Guard against a provider sending an exponent form or junk; fall back to 0
  // rather than throwing inside a traversal.
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(decPart)) return 0n;
  const padded = (decPart + "0".repeat(Number(SCALE))).slice(0, Number(SCALE));
  const magnitude = BigInt((intPart || "0") + padded);
  return negative ? -magnitude : magnitude;
}

/** Render a scaled BigInt back to a trimmed decimal string. */
function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const intPart = magnitude / 10n ** SCALE;
  const decPart = (magnitude % 10n ** SCALE).toString().padStart(SCALE_DEC, "0").replace(/0+$/, "");
  const body = decPart ? `${intPart}.${decPart}` : intPart.toString();
  return negative ? `-${body}` : body;
}

export function addDecimal(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

export function subDecimal(a: string, b: string): string {
  return fromScaled(toScaled(a) - toScaled(b));
}

/** Clamp to >= 0. Attributed shares are never negative. */
export function clampZero(value: string): string {
  return toScaled(value) < 0n ? "0" : value;
}

/** The smaller of two amounts. */
export function minDecimal(a: string, b: string): string {
  return toScaled(a) <= toScaled(b) ? a : b;
}

/**
 * `a * (b / c)`, computed at working precision.
 *
 * `c` of zero yields `"0"` rather than a division error: an upstream provider
 * that reports a transfer with no value on any leg means the amount is unknown,
 * and an unknown amount must never be reported as an infinite or NaN share.
 */
export function shareDecimal(a: string, b: string, c: string): string {
  const denom = toScaled(c);
  if (denom === 0n) return "0";
  const numerator = toScaled(a) * toScaled(b);
  return fromScaled(numerator / denom);
}

export function toNumber(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** True when the two amounts agree to within `tolerance` (absolute). */
export function nearEqual(a: string, b: string, tolerance = "0.000000000000000001"): boolean {
  const diff = toScaled(a) - toScaled(b);
  if (diff === 0n) return true;
  return (diff < 0n ? -diff : diff) <= toScaled(tolerance);
}

/** Format for display without losing precision on small fractions. */
export function formatAmount(value: string, maxDecimals = 8): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
}