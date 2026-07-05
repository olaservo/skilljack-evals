/**
 * Build and persist the machine-readable run summary (summary.json).
 *
 * Derives reward-authoritative metrics from per-trial results/scores without
 * re-scoring, and collects concrete failure evidence per failing trial.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CombinedScore, DeterministicResult, EvalTask, TaskResult } from '../types.js';
import type { EvalConfig } from '../config.js';
import {
  binomialCI,
  groupMetrics,
  macroSkillLift,
  passAtK,
  resolutionRate,
  skillInvocationRate,
  skillLift,
} from '../score/metrics.js';
import type {
  ConditionStats,
  RunSummary,
  RunSummaryThresholds,
  TaskRunSummary,
  TrialFailure,
} from './types.js';

/** Per-phase trial data, indexed [run][task]. */
export interface PhaseTrialData {
  allResults: TaskResult[][];
  allScores: CombinedScore[][];
}

export interface BuildRunSummaryOptions {
  tasks: EvalTask[];
  skillName: string;
  withSkill: PhaseTrialData;
  baseline?: PhaseTrialData;
  baselineLabel?: string;
  config: EvalConfig;
  nudge: string;
  trials: number;
  judgeEnabled: boolean;
  timestamp?: string;
}

/** Max characters of verifier stderr carried into summary.json. */
const VERIFIER_STDERR_EXCERPT = 400;

/**
 * Failure-detail prefixes emitted by scoreDeterministic. Details are only
 * emitted with these prefixes when the corresponding check failed, so a
 * prefix filter yields exactly the failing evidence strings.
 */
const FAILURE_DETAIL_PREFIXES = [
  'Expected skill activation',
  'Wrong skill activated',
  'Unexpected skill activation',
  'Marker not found',
  'Missing expected tool calls',
  'Forbidden tools were called',
  'Expected substrings not found',
  'Forbidden substrings found',
  'Regex patterns not matched',
  'JavaScript assertion returned',
  'JavaScript assertion error',
  'Expected files not found',
  'Working directory does not exist',
  'Verifier failed',
  'Task errored',
];

/** Extract the failing-check evidence strings from a deterministic result. */
export function collectFailedChecks(det: DeterministicResult | null): string[] {
  if (!det) return [];
  return det.details.filter((d) => FAILURE_DETAIL_PREFIXES.some((p) => d.startsWith(p)));
}

/** Per-trial (result, score) pairs for one task within one condition. */
function taskTrials(phase: PhaseTrialData, taskIndex: number): Array<{ result: TaskResult; score: CombinedScore }> {
  return phase.allResults.map((runResults, run) => ({
    result: runResults[taskIndex],
    score: phase.allScores[run][taskIndex],
  }));
}

function conditionStats(trials: Array<{ score: CombinedScore }>): ConditionStats {
  const passed = trials.map((t) => t.score.passed);
  return {
    passed,
    rewards: trials.map((t) => t.score.reward),
    resolutionRate: resolutionRate(passed),
    passAtK: passAtK(passed),
  };
}

function trialFailures(
  trials: Array<{ result: TaskResult; score: CombinedScore }>,
  condition: 'with-skill' | 'baseline',
): TrialFailure[] {
  const failures: TrialFailure[] = [];
  for (let i = 0; i < trials.length; i++) {
    const { result, score } = trials[i];
    if (score.passed) continue;
    const failure: TrialFailure = {
      trial: i + 1,
      condition,
      failedChecks: collectFailedChecks(score.deterministic),
    };
    if (result.verifier && !result.verifier.passed) {
      failure.verifierStatus = result.verifier.status;
      if (result.verifier.stderr) {
        failure.verifierStderr = result.verifier.stderr.slice(0, VERIFIER_STDERR_EXCERPT);
      }
    }
    if (result.isError && result.errorMessage) {
      failure.errorMessage = result.errorMessage;
    }
    if (score.failureCategory && score.failureCategory !== 'none') {
      failure.failureCategory = score.failureCategory;
    }
    if (score.judge?.reasoning) {
      failure.judgeNotes = score.judge.reasoning;
    }
    failures.push(failure);
  }
  return failures;
}

/** Evaluate the pass/fail gates for a run. */
export function evaluateThresholds(
  resolution: number,
  config: EvalConfig,
  lift?: number,
): RunSummaryThresholds {
  const resolutionPassed = resolution >= config.resolutionThreshold;
  const liftPassed = config.liftThreshold !== undefined && lift !== undefined
    ? lift >= config.liftThreshold
    : undefined;
  return {
    resolution: config.resolutionThreshold,
    lift: config.liftThreshold,
    resolutionPassed,
    liftPassed,
    passed: resolutionPassed && liftPassed !== false,
  };
}

/**
 * Build the RunSummary from per-trial results/scores.
 */
export function buildRunSummary(options: BuildRunSummaryOptions): RunSummary {
  const { tasks, config } = options;

  const taskSummaries: TaskRunSummary[] = [];
  const perTaskLifts: number[] = [];
  const invokedFlags: boolean[] = [];

  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let tokenSum = 0;
  let hasAllTokens = true;
  let totalWithSkillTrials = 0;

  const phases: Array<{ data: PhaseTrialData; condition: 'with-skill' | 'baseline' }> = [
    { data: options.withSkill, condition: 'with-skill' },
    ...(options.baseline ? [{ data: options.baseline, condition: 'baseline' as const }] : []),
  ];

  // Cost/duration/tokens totals cover ALL trials in the run (both conditions).
  for (const phase of phases) {
    for (const runResults of phase.data.allResults) {
      for (const result of runResults) {
        totalDurationMs += result.durationMs;
        totalCostUsd += result.costUsd;
        if (result.tokens) tokenSum += result.tokens.total;
        else hasAllTokens = false;
      }
    }
  }

  for (let t = 0; t < tasks.length; t++) {
    const task = tasks[t];
    const withTrials = taskTrials(options.withSkill, t);
    const withStats = conditionStats(withTrials);
    totalWithSkillTrials += withTrials.length;

    const summary: TaskRunSummary = {
      id: task.id,
      difficulty: task.difficulty,
      category: task.category,
      tags: task.tags,
      expectedSkill: task.expectedSkillLoad,
      withSkill: withStats,
      failures: trialFailures(withTrials, 'with-skill'),
    };

    if (options.baseline) {
      const baseTrials = taskTrials(options.baseline, t);
      summary.baseline = conditionStats(baseTrials);
      summary.lift = skillLift(withStats.resolutionRate, summary.baseline.resolutionRate);
      perTaskLifts.push(summary.lift);
      summary.failures.push(...trialFailures(baseTrials, 'baseline'));
    }

    // Invocation is only meaningful for tasks that expect the skill to load.
    if (task.expectedSkillLoad !== 'none') {
      const taskInvoked = withTrials.map(({ score }) => (score.invocation ?? 0) >= 1);
      invokedFlags.push(...taskInvoked);
      summary.invocationRate = taskInvoked.filter(Boolean).length / Math.max(1, taskInvoked.length);
    }

    // Judge assertion grading (diagnostics) from the with-skill condition.
    if (options.judgeEnabled) {
      const withAssertions = withTrials.find(({ score }) => (score.checklistResults ?? []).length > 0);
      if (withAssertions) {
        summary.assertions = withAssertions.score.checklistResults;
      }
    }

    taskSummaries.push(summary);
  }

  const perTaskRates = taskSummaries.map((s) => s.withSkill.resolutionRate);
  const overallResolution = perTaskRates.length > 0
    ? perTaskRates.reduce((sum, v) => sum + v, 0) / perTaskRates.length
    : 0;
  const overallPassAtK = taskSummaries.length > 0
    ? taskSummaries.filter((s) => s.withSkill.passAtK).length / taskSummaries.length
    : 0;
  const lift = options.baseline ? macroSkillLift(perTaskLifts) : undefined;

  const grouped = (keyOf: (task: EvalTask) => Array<string | undefined>) =>
    groupMetrics(tasks.map((task, i) => ({
      keys: keyOf(task),
      passed: taskSummaries[i].withSkill.passed,
    })));

  const thresholds = evaluateThresholds(overallResolution, config, lift);

  return {
    version: 2,
    run: {
      timestamp: options.timestamp ?? new Date().toISOString(),
      skillName: options.skillName,
      runner: config.runnerType,
      model: config.defaultAgentModel,
      nudge: options.nudge,
      trials: options.trials,
      baseline: !!options.baseline,
      baselineLabel: options.baselineLabel,
      judge: options.judgeEnabled,
    },
    metrics: {
      resolutionRate: overallResolution,
      ci: binomialCI(overallResolution, totalWithSkillTrials),
      passAtK: overallPassAtK,
      skillLift: lift,
      skillInvocationRate: skillInvocationRate(invokedFlags),
      byDifficulty: grouped((task) => [task.difficulty]),
      byCategory: grouped((task) => [task.category]),
      byTag: grouped((task) => task.tags ?? []),
      totalDurationMs,
      totalCostUsd,
      totalTokens: hasAllTokens ? tokenSum : undefined,
    },
    thresholds,
    tasks: taskSummaries,
  };
}

/** Write summary.json to the output dir, returning its path. */
export async function writeRunSummary(summary: RunSummary, outputDir: string): Promise<string> {
  const summaryPath = path.join(outputDir, 'summary.json');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  return summaryPath;
}
