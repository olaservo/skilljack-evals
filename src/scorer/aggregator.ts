/**
 * Aggregation utilities for multi-run evaluation.
 *
 * Merges N independent runs per task into single averaged results and scores.
 */

import type { TaskResult, CombinedScore, FailureCategory } from '../types.js';

/**
 * Aggregate multiple runs of TaskResult[] into a single TaskResult per task.
 *
 * For each task position, picks the "representative" run (closest to median
 * weighted score) for output/toolCalls, and sums duration/cost across all runs.
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

    // Find the representative run (closest to mean weighted score)
    const meanWeighted = scores.reduce((sum, s) => sum + s.weightedScore, 0) / numRuns;
    let repIdx = 0;
    let minDist = Infinity;
    for (let r = 0; r < numRuns; r++) {
      const dist = Math.abs(scores[r].weightedScore - meanWeighted);
      if (dist < minDist) {
        minDist = dist;
        repIdx = r;
      }
    }

    const rep = runs[repIdx];
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
    });
  }

  return aggregated;
}

/**
 * Aggregate multiple runs of CombinedScore[] into a single CombinedScore per task.
 *
 * Averages all numeric scores across runs.
 */
export function aggregateScores(allScores: CombinedScore[][]): CombinedScore[] {
  const numRuns = allScores.length;
  if (numRuns === 0) return [];
  if (numRuns === 1) return allScores[0];

  const numTasks = allScores[0].length;
  const aggregated: CombinedScore[] = [];

  for (let t = 0; t < numTasks; t++) {
    const scores = allScores.map((s) => s[t]);

    const avgDiscovery = scores.reduce((sum, s) => sum + s.discovery, 0) / numRuns;
    const avgAdherence = scores.reduce((sum, s) => sum + s.adherence, 0) / numRuns;
    const avgOutput = scores.reduce((sum, s) => sum + s.outputQuality, 0) / numRuns;
    const avgWeighted = scores.reduce((sum, s) => sum + s.weightedScore, 0) / numRuns;

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

    const discoveryCount = scores.filter((s) => s.discovery >= 1).length;

    aggregated.push({
      taskId: scores[0].taskId,
      deterministic: null,
      judge: null,
      discovery: avgDiscovery,
      adherence: avgAdherence,
      outputQuality: avgOutput,
      weightedScore: avgWeighted,
      failureCategory: modeCategory,
      reasoning: `Aggregated over ${numRuns} runs: discovery ${discoveryCount}/${numRuns}, mean adherence ${avgAdherence.toFixed(1)}, mean output ${avgOutput.toFixed(1)}`,
    });
  }

  return aggregated;
}
