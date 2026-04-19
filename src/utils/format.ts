/** Threshold below which a delta is considered effectively zero for arrow display. */
export const ARROW_DIRECTION_EPSILON = 0.001;

/**
 * Format a numeric delta value with a sign prefix.
 */
export function formatDelta(value: number, decimals = 2): string {
  if (value === 0) return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
  const sign = value > 0 ? '+' : '';
  const formatted = `${sign}${value.toFixed(decimals)}`;
  // Normalize negative zero strings (e.g. -0.004 → "-0.00" should become "0.00")
  const zeroStr = decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
  if (formatted === `-${zeroStr}`) return zeroStr;
  return formatted;
}

/**
 * Format a percentage string from count/total. Returns '0' when total is 0.
 */
export function pct(count: number, total: number): string {
  return total > 0 ? ((count / total) * 100).toFixed(0) : '0';
}

/**
 * Format a token count for display, or a fallback string when unavailable.
 */
export function formatTokens(n: number | undefined, fallback = 'n/a'): string {
  return n !== undefined ? n.toLocaleString() : fallback;
}

/**
 * Format a failure category slug as a human-readable label.
 */
export function formatCategory(cat: string): string {
  if (cat === 'none') return 'No Failure';
  return cat
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
