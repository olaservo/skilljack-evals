/**
 * Shared concurrency utilities.
 *
 * Provides a generic bounded-concurrency runner used by both the task runner
 * (BaseRunner.runAll) and the scorer (SkillJudge.judgeAll / blindCompareAll).
 */

/** Default maximum number of concurrent API calls to the judge. */
export const DEFAULT_CONCURRENCY = 5;

/** Default runner concurrency (sequential execution). */
export const DEFAULT_RUNNER_CONCURRENCY = 1;

/**
 * Run async tasks with a concurrency limit.
 *
 * Note: if a factory throws, remaining in-flight workers are NOT cancelled.
 * Callers that need graceful shutdown should catch inside each factory.
 *
 * @param factories - Array of zero-argument async functions to execute.
 * @param limit - Max concurrent tasks. 1 = sequential, 0 = unlimited, N = bounded.
 * @returns Results in the same order as the input factories.
 */
export async function withConcurrencyLimit<T>(
  factories: Array<() => Promise<T>>,
  limit = DEFAULT_CONCURRENCY,
): Promise<T[]> {
  if (factories.length === 0) return [];

  if (limit < 0) {
    throw new RangeError(`Concurrency limit must be >= 0, got ${limit}`);
  }

  // Handle unlimited: if limit === 0, run all at once
  const effectiveLimit = limit === 0 ? factories.length : limit;

  const results: T[] = new Array(factories.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < factories.length) {
      // Safe: JS is single-threaded; `next++` is atomic relative to the event loop.
      const idx = next++;
      results[idx] = await factories[idx]();
    }
  }

  const workers = Array.from(
    { length: Math.min(effectiveLimit, factories.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
