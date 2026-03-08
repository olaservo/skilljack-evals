/**
 * Shared formatting utilities for report modules.
 */

/** Threshold below which a delta is considered effectively zero for arrow display. */
export const ARROW_DIRECTION_EPSILON = 0.001;

/**
 * Format a numeric delta with sign prefix and fixed decimal places.
 */
export function formatDelta(value: number, suffix = ''): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}${suffix}`;
}

/**
 * Format a snake_case failure category as Title Case.
 */
export function formatCategory(cat: string): string {
  if (cat === 'none') return 'No Failure';
  return cat
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
