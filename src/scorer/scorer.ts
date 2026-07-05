/**
 * Scoring orchestrator: deterministic reward is authoritative, the LLM judge
 * is an opt-in diagnostics layer.
 *
 * Deterministic scoring produces the trial's passed/reward outcome. When the
 * judge is enabled (--judge) it adds adherence/output-quality ratings,
 * assertion grading with evidence, and failure-category attribution — none of
 * which affect passed, rewards, or thresholds.
 */

import type {
  EvalTask,
  TaskResult,
  CombinedScore,
  DeterministicResult,
  JudgeScore,
  FailureCategory,
  HumanFeedback,
} from '../types.js';
import { scoreDeterministic } from './deterministic.js';
import { SkillJudge } from './judge.js';
import type { JudgeOptions } from '../types.js';
import { getFeedbackForTask } from '../feedback.js';

export interface ScorerOptions {
  /** Skip deterministic scoring (used by `score` re-runs on retained results). */
  noDeterministic?: boolean;
  /** Enable LLM judge diagnostics (off by default). */
  judgeEnabled?: boolean;
  /** Judge options */
  judgeOptions?: JudgeOptions;
  /** Human review feedback keyed by task ID (judge-scoped) */
  humanFeedback?: HumanFeedback;
  /** True for no-skill baseline evaluation — skips activation checks, adjusts judge prompt */
  isBaseline?: boolean;
  /** Working directory for file-based assertions (files_exist) */
  cwd?: string;
}

/**
 * Score a single task result: deterministic reward plus optional judge diagnostics.
 */
export async function scoreTask(
  task: EvalTask,
  result: TaskResult,
  options: ScorerOptions = {}
): Promise<CombinedScore> {
  // Run deterministic scoring (reward-authoritative)
  let deterministicResult: DeterministicResult | null = null;
  if (!options.noDeterministic && task.deterministic) {
    // File-based assertions resolve against the trial workspace when present.
    deterministicResult = scoreDeterministic(task, result, {
      cwd: task.workspaceDir ?? options.cwd,
      ignoreActivation: options.isBaseline,
    });
  }

  // Run LLM judge diagnostics (opt-in)
  let judgeResult: JudgeScore | null = null;
  if (options.judgeEnabled && task.criteria.length > 0) {
    const judgeOpts = { ...options.judgeOptions, isBaseline: options.isBaseline };
    const judge = new SkillJudge(judgeOpts);
    const taskFeedback = getFeedbackForTask(options.humanFeedback, task.id);
    judgeResult = await judge.judgeResult(task, result, taskFeedback);
  }

  return mergeScores(task, result, deterministicResult, judgeResult, options.isBaseline ?? false);
}

/**
 * Score all task results.
 */
export async function scoreAll(
  tasks: EvalTask[],
  results: TaskResult[],
  options: ScorerOptions = {}
): Promise<CombinedScore[]> {
  const scores: CombinedScore[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = results[i];
    console.log(`Scoring task ${task.id}...`);
    const score = await scoreTask(task, result, options);
    scores.push(score);
  }

  return scores;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Merge deterministic reward and judge diagnostics into a combined score.
 *
 * Rules:
 * - passed/reward come exclusively from the deterministic result (+ agent error)
 * - discovery is deterministic (tool-call evidence) — never from the judge
 * - adherence/outputQuality/assertion grading come from the judge when it ran
 * - failure category: judge-sourced when available, else derived minimally
 */
function mergeScores(
  task: EvalTask,
  result: TaskResult,
  det: DeterministicResult | null,
  judge: JudgeScore | null,
  isBaseline: boolean,
): CombinedScore {
  const taskId = task.id;
  const isNegativeTest = task.expectedSkillLoad === 'none';

  // For negative tests (expectedSkillLoad === 'none'):
  // discovery = 1 means correctly did NOT activate (good)
  // discovery = 0 means incorrectly activated (false positive)
  const computeDiscovery = (activated: boolean) =>
    isNegativeTest ? (activated ? 0 : 1) : (activated ? 1 : 0);

  // Trial reward decomposition:
  // - Agent error/timeout always yields reward 0.
  // - Non-verifier deterministic checks gate the reward: if any of them
  //   failed, reward is 0 — a passing verifier cannot rescue a trial that
  //   failed an activation/output check.
  // - When the other checks pass, the verifier (when present) contributes
  //   its (possibly partial) reward; without a verifier the deterministic
  //   outcome is binary.
  // - With no deterministic checks (score re-runs with --no-deterministic),
  //   there is nothing to fail: the agent error status decides.
  // Invariant: on non-error trials, passed === (reward >= 1).
  const hasVerifier = !!result.verifier;
  const checksPassedExVerifier = det ? det.checksPassed : true;
  const reward = result.isError
    ? 0
    : !checksPassedExVerifier
      ? 0
      : hasVerifier
        ? clamp01(result.verifier!.reward)
        : det
          ? (det.passed ? 1 : 0)
          : 1;
  const passed = !result.isError && reward >= 1 && (det ? det.passed : true);

  const discovery = det ? computeDiscovery(det.skillActivated) : 0;
  // Invocation signal feeds skillInvocationRate: only meaningful for
  // with-skill trials of tasks that expect an invocation.
  const invocation = !isBaseline && !isNegativeTest && det
    ? (det.skillActivated ? 1 : 0)
    : undefined;

  // Failure category: judge-sourced when available, else derived minimally.
  let failureCategory: FailureCategory = judge?.failureCategory ?? 'none';
  if (result.isError) {
    failureCategory = 'agent_error';
  } else if (det) {
    if (!det.passed && !det.skillActivated && det.details.some((d) => d.includes('Expected skill activation'))) {
      failureCategory = 'discovery_failure';
    } else if (det.details.some((d) => d.includes('false positive'))) {
      failureCategory = 'false_positive';
    } else if (!det.passed && !judge) {
      failureCategory = 'agent_error';
    }
  }
  if (passed && !judge) {
    failureCategory = 'none';
  }

  const reasons: string[] = [];
  if (result.isError && result.errorMessage) reasons.push(`Agent error: ${result.errorMessage}`);
  if (det && det.details.length > 0) reasons.push(`Deterministic: ${det.details.join('; ')}`);
  if (judge?.reasoning) reasons.push(`Judge: ${judge.reasoning}`);

  return {
    taskId,
    deterministic: det,
    judge,
    passed,
    reward,
    discovery,
    invocation,
    adherence: judge?.adherence,
    outputQuality: judge?.outputQuality,
    failureCategory,
    reasoning: reasons.join(' | ') || 'No scoring detail available',
    checklistResults: judge?.checklistResults ?? [],
  };
}
