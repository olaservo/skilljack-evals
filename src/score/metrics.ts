/**
 * Reward-authoritative metrics over per-task trial outcomes.
 *
 * Pure functions — no I/O, no config. These implement the SkillsBench-shaped
 * headline metrics: resolution rate, pass@k, skill lift, skill invocation
 * rate, binomial confidence intervals, and grouped aggregations.
 */

import type { ResolutionCI } from '../types.js';

/** Mean pass rate over a task's trials. Returns 0 for an empty trial list. */
export function resolutionRate(passedFlags: boolean[]): number {
  if (passedFlags.length === 0) return 0;
  return passedFlags.filter(Boolean).length / passedFlags.length;
}

/** Pass@k: true when any trial passed. */
export function passAtK(passedFlags: boolean[]): boolean {
  return passedFlags.some(Boolean);
}

/**
 * 95% binomial (Wald) confidence interval: p ± 1.96·sqrt(p(1−p)/n),
 * clamped to [0, 1]. With no observations the interval is maximally wide.
 */
export function binomialCI(p: number, n: number): ResolutionCI {
  if (n <= 0) return { low: 0, high: 1 };
  const halfWidth = 1.96 * Math.sqrt((p * (1 - p)) / n);
  return {
    low: Math.max(0, p - halfWidth),
    high: Math.min(1, p + halfWidth),
  };
}

/** Per-task skill lift: with-skill resolution rate minus baseline resolution rate. */
export function skillLift(withSkillRate: number, baselineRate: number): number {
  return withSkillRate - baselineRate;
}

/** Macro-average skill lift over per-task lifts. Returns 0 for an empty list. */
export function macroSkillLift(perTaskLifts: number[]): number {
  if (perTaskLifts.length === 0) return 0;
  return perTaskLifts.reduce((sum, v) => sum + v, 0) / perTaskLifts.length;
}

/**
 * Skill Invocation Rate: share of with-skill trials where the expected skill
 * was invoked. Callers must pre-filter to trials of tasks that expect an
 * invocation (expectedSkillLoad !== 'none'); anti-trigger tasks are excluded.
 * Returns undefined when there are no eligible trials.
 */
export function skillInvocationRate(invokedFlags: boolean[]): number | undefined {
  if (invokedFlags.length === 0) return undefined;
  return invokedFlags.filter(Boolean).length / invokedFlags.length;
}

/** Metrics for one group (difficulty, category, or tag bucket). */
export interface GroupMetrics {
  /** Number of tasks in the group. */
  tasks: number;
  /** Mean per-task resolution rate within the group. */
  resolutionRate: number;
  /** Share of tasks in the group with at least one passing trial. */
  passAtK: number;
}

/** A task's trial outcomes plus the group key(s) it belongs to. */
export interface GroupedTaskTrials {
  /** Group key(s) — e.g. difficulty, category, or tags. Tasks without keys are skipped. */
  keys: Array<string | undefined>;
  passed: boolean[];
}

/**
 * Aggregate per-task trial outcomes into per-group metrics. A task counts
 * toward every non-empty key it carries (single key for difficulty/category,
 * multiple for tags).
 */
export function groupMetrics(tasks: GroupedTaskTrials[]): Record<string, GroupMetrics> {
  const buckets = new Map<string, { rates: number[]; anyPass: number }>();
  for (const task of tasks) {
    const keys = [...new Set(task.keys.filter((k): k is string => !!k))];
    for (const key of keys) {
      const bucket = buckets.get(key) ?? { rates: [], anyPass: 0 };
      bucket.rates.push(resolutionRate(task.passed));
      if (passAtK(task.passed)) bucket.anyPass++;
      buckets.set(key, bucket);
    }
  }

  const out: Record<string, GroupMetrics> = {};
  for (const [key, bucket] of buckets) {
    out[key] = {
      tasks: bucket.rates.length,
      resolutionRate: bucket.rates.reduce((s, v) => s + v, 0) / bucket.rates.length,
      passAtK: bucket.anyPass / bucket.rates.length,
    };
  }
  return out;
}
