/**
 * Machine-readable run summary (summary.json) — the stable contract for CI
 * gating, cross-run comparison, and external optimizers (GEPA-style loops):
 * scores + failures + actionable side information.
 */

import type {
  ChecklistItemResult,
  FailureCategory,
  ResolutionCI,
  TaskDifficulty,
  VerifierStatus,
} from '../types.js';
import type { GroupMetrics } from '../score/metrics.js';

/** Per-condition trial outcomes for one task. */
export interface ConditionStats {
  /** Per-trial pass flags, in trial order. */
  passed: boolean[];
  /** Per-trial rewards in [0, 1]. */
  rewards: number[];
  /** Mean of passed. */
  resolutionRate: number;
  /** True when any trial passed. */
  passAtK: boolean;
}

/** Evidence for a single failed trial — actionable side information. */
export interface TrialFailure {
  /** 1-based trial index. */
  trial: number;
  condition: 'with-skill' | 'baseline';
  /** Failing deterministic check evidence strings (check name + expected/actual). */
  failedChecks: string[];
  verifierStatus?: VerifierStatus;
  /** Excerpt of the verifier's stderr, when it failed. */
  verifierStderr?: string;
  /** Agent error message, when the trial errored. */
  errorMessage?: string;
  failureCategory?: FailureCategory;
  /** Judge reasoning for the trial, when the judge ran. */
  judgeNotes?: string;
}

/** Per-task section of the run summary. */
export interface TaskRunSummary {
  id: string;
  difficulty?: TaskDifficulty;
  category?: string;
  tags?: string[];
  expectedSkill: string;
  withSkill: ConditionStats;
  baseline?: ConditionStats;
  /** Skill lift: withSkill.resolutionRate − baseline.resolutionRate. */
  lift?: number;
  /** Expected-skill invocation rate across with-skill trials (invocation-expecting tasks only). */
  invocationRate?: number;
  failures: TrialFailure[];
  /** Judge assertion grading with evidence, when the judge ran. */
  assertions?: ChecklistItemResult[];
}

export interface RunSummaryMetrics {
  /** Mean per-task with-skill resolution rate. */
  resolutionRate: number;
  /** 95% binomial CI on the resolution rate (n = total with-skill trials). */
  ci: ResolutionCI;
  /** Share of tasks with at least one passing with-skill trial. */
  passAtK: number;
  /** Macro-average skill lift; present only when the baseline condition ran. */
  skillLift?: number;
  /** Skill Invocation Rate over invocation-expecting tasks' with-skill trials. */
  skillInvocationRate?: number;
  byDifficulty: Record<string, GroupMetrics>;
  byCategory: Record<string, GroupMetrics>;
  byTag: Record<string, GroupMetrics>;
  totalDurationMs: number;
  totalCostUsd: number;
  totalTokens?: number;
}

export interface RunSummaryThresholds {
  /** Minimum with-skill resolution rate (0-1). */
  resolution: number;
  /** Minimum macro skill lift; unset = not gated. */
  lift?: number;
  resolutionPassed: boolean;
  /** Undefined when lift is not gated (no threshold or no baseline). */
  liftPassed?: boolean;
  passed: boolean;
}

export interface RunSummaryInfo {
  timestamp: string;
  skillName: string;
  runner: string;
  model: string;
  nudge: string;
  /** Trials per task per condition (k). */
  trials: number;
  /** True when the paired baseline condition ran. */
  baseline: boolean;
  baselineLabel?: string;
  /** True when judge diagnostics were collected. */
  judge: boolean;
}

/** Top-level summary.json shape. */
export interface RunSummary {
  version: 2;
  run: RunSummaryInfo;
  metrics: RunSummaryMetrics;
  thresholds: RunSummaryThresholds;
  tasks: TaskRunSummary[];
}
