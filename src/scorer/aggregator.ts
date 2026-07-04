/**
 * Aggregation utilities for multi-trial evaluation.
 *
 * Merges N independent trials per task into single aggregated results and
 * scores, preserving per-trial pass/reward outcomes for the metrics layer.
 */

import type { TaskResult, CombinedScore, FailureCategory, ScoreStddev } from '../types.js';

/**
 * Stddev threshold (on the 1-5 scale) above which judge diagnostics are
 * flagged as "potentially flaky."
 */
export const FLAKY_STDDEV_THRESHOLD = 1.0;

/**
 * Check whether a score's variance indicates flaky (inconsistent) results.
 *
 * A task is flaky when its trials disagree on pass/fail (reward stddev > 0),
 * or — when judge diagnostics are present — when adherence/output quality
 * vary beyond FLAKY_STDDEV_THRESHOLD on the 1-5 scale.
 */
export function isFlaky(stddev: ScoreStddev | undefined): boolean {
  if (!stddev) return false;
  if (stddev.reward > 0) return true;
  return (stddev.adherence ?? 0) > FLAKY_STDDEV_THRESHOLD
    || (stddev.outputQuality ?? 0) > FLAKY_STDDEV_THRESHOLD;
}

/**
 * Compute sample standard deviation (N-1 denominator).
 * Returns 0 when fewer than 2 values are provided.
 *
 * @param values - Array of numeric values
 * @param mean - Pre-computed arithmetic mean of `values`. If provided, it must
 *               be the true mean of the given values; an incorrect value will
 *               produce an incorrect result. When omitted, the mean is computed
 *               internally.
 */
export function computeStddev(values: number[], mean?: number): number {
  if (values.length < 2) return 0;
  const m = mean ?? values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Find the index of the trial closest to the mean reward.
 */
function findRepresentativeIndex(scores: CombinedScore[]): number {
  const mean = scores.reduce((sum, s) => sum + s.reward, 0) / scores.length;
  let repIdx = 0;
  let minDist = Infinity;
  for (let r = 0; r < scores.length; r++) {
    const dist = Math.abs(scores[r].reward - mean);
    if (dist < minDist) {
      minDist = dist;
      repIdx = r;
    }
  }
  return repIdx;
}

/** Average the defined values; undefined when none are defined. */
function meanOfDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  if (defined.length === 0) return undefined;
  return defined.reduce((sum, v) => sum + v, 0) / defined.length;
}

/**
 * Aggregate multiple runs of TaskResult[] into a single TaskResult per task.
 *
 * For each task position, picks the "representative" run (closest to mean
 * reward) for output/toolCalls, and sums duration/cost across all runs.
 */
export function aggregateResults(
  allResults: TaskResult[][],
  allScores: CombinedScore[][]
): TaskResult[] {
  const numRuns = allResults.length;
  if (numRuns === 0) return [];
  if (numRuns === 1) return allResults[0];

  const numTasks = allResults[0].length;
  const aggregated: TaskResult[] = [];

  for (let t = 0; t < numTasks; t++) {
    const runs = allResults.map((r) => r[t]);
    const scores = allScores.map((s) => s[t]);

    const repIdx = findRepresentativeIndex(scores);
    const rep = runs[repIdx];
    // Partial data is misleading — omit tokens if any run couldn't report them.
    let allHaveTokens = true;
    let tInput = 0, tOutput = 0, tCacheRead = 0, tCacheCreation = 0, tTotal = 0;
    for (const r of runs) {
      if (!r.tokens) { allHaveTokens = false; break; }
      tInput += r.tokens.input;
      tOutput += r.tokens.output;
      tCacheRead += r.tokens.cacheRead;
      tCacheCreation += r.tokens.cacheCreation;
      tTotal += r.tokens.total;
    }
    const tokens = allHaveTokens
      ? { input: tInput, output: tOutput, cacheRead: tCacheRead, cacheCreation: tCacheCreation, total: tTotal }
      : undefined;
    aggregated.push({
      taskId: rep.taskId,
      prompt: rep.prompt,
      output: rep.output,
      durationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
      numTurns: runs.reduce((sum, r) => sum + r.numTurns, 0),
      costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
      skillLoads: [...new Set(runs.flatMap((r) => r.skillLoads))],
      toolCalls: rep.toolCalls,
      isError: runs.some((r) => r.isError),
      errorMessage: runs.filter((r) => r.isError).map((r) => r.errorMessage).join('; '),
      tokens,
      verifier: rep.verifier,
    });
  }

  return aggregated;
}

/**
 * Aggregate multiple trials of CombinedScore[] into a single CombinedScore per task.
 *
 * The aggregate keeps per-trial pass/reward arrays (for pass@k and CI math),
 * averages reward/discovery/invocation and judge diagnostics, and marks the
 * task as passed only when every trial passed.
 */
export function aggregateScores(allScores: CombinedScore[][]): CombinedScore[] {
  const numRuns = allScores.length;
  if (numRuns === 0) return [];
  if (numRuns === 1) return allScores[0];

  const numTasks = allScores[0].length;
  const aggregated: CombinedScore[] = [];

  for (let t = 0; t < numTasks; t++) {
    const scores = allScores.map((s) => s[t]);

    const trialPassed = scores.map((s) => s.passed);
    const trialRewards = scores.map((s) => s.reward);
    const passCount = trialPassed.filter(Boolean).length;

    const avgReward = trialRewards.reduce((sum, v) => sum + v, 0) / numRuns;
    const avgDiscovery = scores.reduce((sum, s) => sum + s.discovery, 0) / numRuns;
    const avgInvocation = meanOfDefined(scores.map((s) => s.invocation));
    const avgAdherence = meanOfDefined(scores.map((s) => s.adherence));
    const avgOutput = meanOfDefined(scores.map((s) => s.outputQuality));

    // Compute sample standard deviations
    const stddev: ScoreStddev = {
      reward: computeStddev(trialRewards, avgReward),
      discovery: computeStddev(scores.map(s => s.discovery), avgDiscovery),
    };
    if (avgAdherence !== undefined) {
      stddev.adherence = computeStddev(
        scores.map((s) => s.adherence).filter((v): v is number => v !== undefined),
        avgAdherence,
      );
    }
    if (avgOutput !== undefined) {
      stddev.outputQuality = computeStddev(
        scores.map((s) => s.outputQuality).filter((v): v is number => v !== undefined),
        avgOutput,
      );
    }

    // Mode of failure categories
    const catCounts = new Map<FailureCategory, number>();
    for (const s of scores) {
      catCounts.set(s.failureCategory, (catCounts.get(s.failureCategory) || 0) + 1);
    }
    let modeCategory: FailureCategory = 'none';
    let maxCount = 0;
    for (const [cat, count] of catCounts) {
      if (count > maxCount) {
        maxCount = count;
        modeCategory = cat;
      }
    }

    const repIdx = findRepresentativeIndex(scores);

    aggregated.push({
      taskId: scores[0].taskId,
      deterministic: scores[repIdx].deterministic,
      judge: scores[repIdx].judge,
      passed: passCount === numRuns,
      reward: avgReward,
      discovery: avgDiscovery,
      invocation: avgInvocation,
      adherence: avgAdherence,
      outputQuality: avgOutput,
      failureCategory: modeCategory,
      reasoning: `Aggregated over ${numRuns} trials: passed ${passCount}/${numRuns}, mean reward ${avgReward.toFixed(2)}`,
      checklistResults: scores[repIdx].checklistResults ?? [],
      trials: { passed: trialPassed, rewards: trialRewards },
      stddev,
    });
  }

  return aggregated;
}
