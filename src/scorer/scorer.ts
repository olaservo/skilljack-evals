/**
 * Scoring orchestrator that combines deterministic and LLM-as-judge scoring.
 *
 * Deterministic scoring runs first (free, fast), then LLM judge if configured.
 * Results are merged with deterministic taking precedence for discovery.
 */

import type {
  EvalTask,
  TaskResult,
  CombinedScore,
  DeterministicResult,
  JudgeScore,
  FailureCategory,
} from '../types.js';
import { scoreDeterministic } from './deterministic.js';
import { SkillJudge } from './judge.js';
import type { JudgeOptions } from '../types.js';
import { loadConfigSync, getDefaultWeights } from '../config.js';

export interface ScorerOptions {
  /** Skip deterministic scoring */
  noDeterministic?: boolean;
  /** Skip LLM judge scoring */
  noJudge?: boolean;
  /** Judge options */
  judgeOptions?: JudgeOptions;
}

/**
 * Score a single task result using both deterministic and LLM judge methods.
 */
export async function scoreTask(
  task: EvalTask,
  result: TaskResult,
  options: ScorerOptions = {}
): Promise<CombinedScore> {
  const config = loadConfigSync();
  const weights = getDefaultWeights(config);

  // Run deterministic scoring
  let deterministicResult: DeterministicResult | null = null;
  if (!options.noDeterministic && task.deterministic) {
    deterministicResult = scoreDeterministic(task, result);
  }

  // Run LLM judge scoring
  let judgeResult: JudgeScore | null = null;
  if (!options.noJudge && task.criteria.length > 0) {
    const judge = new SkillJudge(options.judgeOptions);
    judgeResult = await judge.judgeResult(task, result);
  }

  const isNegativeTest = task.expectedSkillLoad === 'none';
  return mergeScores(task.id, deterministicResult, judgeResult, weights, isNegativeTest);
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

/**
 * Merge deterministic and judge scores into a combined score.
 *
 * Merge rules:
 * - Discovery: deterministic is authoritative (checks actual tool calls)
 * - Adherence/output: from judge; if no judge, map deterministic pass→5, fail→1
 * - Failure category: determined from available evidence
 */
function mergeScores(
  taskId: string,
  det: DeterministicResult | null,
  judge: JudgeScore | null,
  weights: Map<string, number>,
  isNegativeTest = false
): CombinedScore {
  // For negative tests (expectedSkillLoad === 'none'):
  // discovery = 1 means correctly did NOT activate (good)
  // discovery = 0 means incorrectly activated (false positive)
  const computeDiscovery = (activated: boolean) =>
    isNegativeTest ? (activated ? 0 : 1) : (activated ? 1 : 0);

  // Case 1: Both available — merge
  if (det && judge) {
    const discovery = computeDiscovery(det.skillActivated);
    const adherence = judge.adherence;
    const outputQuality = judge.outputQuality;

    const adherenceNorm = (adherence - 1) / 4;
    const outputNorm = (outputQuality - 1) / 4;
    const weightedScore =
      (weights.get('discovery') ?? 0.3) * discovery +
      (weights.get('adherence') ?? 0.4) * adherenceNorm +
      (weights.get('output') ?? 0.3) * outputNorm;

    // Determine failure category
    let failureCategory = judge.failureCategory;
    if (!det.passed && det.skillActivated === false) {
      failureCategory = 'discovery_failure';
    }
    // Check for false positive via deterministic
    if (det.skillActivated && det.details.some((d) => d.includes('false positive'))) {
      failureCategory = 'false_positive';
    }

    const reasons: string[] = [];
    if (det.details.length > 0) reasons.push(`Deterministic: ${det.details.join('; ')}`);
    if (judge.reasoning) reasons.push(`Judge: ${judge.reasoning}`);

    return {
      taskId,
      deterministic: det,
      judge,
      discovery,
      adherence,
      outputQuality,
      weightedScore,
      failureCategory,
      reasoning: reasons.join(' | '),
    };
  }

  // Case 2: Deterministic only
  if (det) {
    const discovery = computeDiscovery(det.skillActivated);
    const adherence = det.passed ? 5 : 1;
    const outputQuality = det.passed ? 5 : 1;

    const adherenceNorm = (adherence - 1) / 4;
    const outputNorm = (outputQuality - 1) / 4;
    const weightedScore =
      (weights.get('discovery') ?? 0.3) * discovery +
      (weights.get('adherence') ?? 0.4) * adherenceNorm +
      (weights.get('output') ?? 0.3) * outputNorm;

    let failureCategory: FailureCategory = 'none';
    if (!det.skillActivated && det.details.some((d) => d.includes('Expected skill activation'))) {
      failureCategory = 'discovery_failure';
    }
    if (det.details.some((d) => d.includes('false positive'))) {
      failureCategory = 'false_positive';
    }

    return {
      taskId,
      deterministic: det,
      judge: null,
      discovery,
      adherence,
      outputQuality,
      weightedScore,
      failureCategory,
      reasoning: `Deterministic only: ${det.details.join('; ')}`,
    };
  }

  // Case 3: Judge only
  if (judge) {
    return {
      taskId,
      deterministic: null,
      judge,
      discovery: judge.discovery,
      adherence: judge.adherence,
      outputQuality: judge.outputQuality,
      weightedScore: judge.weightedScore,
      failureCategory: judge.failureCategory,
      reasoning: judge.reasoning,
    };
  }

  // Case 4: No scoring available
  return {
    taskId,
    deterministic: null,
    judge: null,
    discovery: 0,
    adherence: 1,
    outputQuality: 1,
    weightedScore: 0,
    failureCategory: 'agent_error',
    reasoning: 'No scoring method available (no deterministic check or LLM judge criteria defined)',
  };
}
