/**
 * Exact base-unit to decimal conversion.
 *
 * Chain amounts are uint256 / int64 integers in the smallest unit. Dividing by
 * `10 ** decimals` in floating point silently loses precision once the integer
 * exceeds 2^53 - 1, which is only ~90.07 BTC but is just 0.009 ETH or 9e-7 TRX.
 * Any uint256 token balance blows past that limit, so the conversion is done
 * with BigInt and rendered as an exact decimal string.
 */

/**
 * Render `value` (in the smallest unit) as a decimal string with `decimals`
 * fractional digits, trailing zeros removed.
 *
 * @param value - Amount in the chain's smallest unit.
 * @param decimals - Fractional digits the asset uses (8 for BTC, 6 for TRX, 18 for EVM natives).
 */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;

  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;

  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${padded}`;
}