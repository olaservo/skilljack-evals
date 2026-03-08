/**
 * Format a numeric delta value with a sign prefix.
 */
export function formatDelta(value: number, decimals = 2): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}`;
}
