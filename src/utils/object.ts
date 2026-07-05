/**
 * Shared object helpers.
 */

/** Narrow an unknown value to a plain record (object, non-null, non-array). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
