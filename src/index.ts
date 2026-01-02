/**
 * Skill evaluation framework utilities.
 *
 * For automated evaluation using Claude Agent SDK, see the agent-sdk-runner.ts
 * template in the skill-eval-guide skill.
 *
 * @packageDocumentation
 */

// Types
export type {
  EvalCriteria,
  EvalTask,
  SkillEvaluation,
  ToolCallRecord,
  TaskResult,
  RunnerOptions,
  FailureCategory,
  JudgeScore,
  JudgeOptions,
  EvaluationSummary,
  FailureBreakdown,
  EvaluationReport,
} from './types.js';

// Parser
export { parseEvalFile, createEvalTemplate } from './parser.js';

// Judge
export { SkillJudge } from './judge.js';

// Report
export { generateReport, generateJsonResults } from './report.js';
