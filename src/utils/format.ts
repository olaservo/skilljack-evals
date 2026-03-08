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
