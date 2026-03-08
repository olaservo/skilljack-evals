/**
 * Format a numeric delta value with a sign prefix.
 */
export function formatDelta(value: number, decimals = 2): string {
  if (value === 0) return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}`;
}
