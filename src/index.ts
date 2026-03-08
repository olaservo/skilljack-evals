/**
 * Skill evaluation framework.
 *
 * Provides tools for evaluating AI agent skill discoverability,
 * adherence, and output quality.
 *
 * @packageDocumentation
 */

// Types
export type {
  EvalCriteria,
  EvalTask,
  EvalDefaults,
  SkillEvaluation,
  DeterministicCheck,
  DeterministicResult,
  FixtureConfig,
  ToolCallRecord,
  TaskResult,
  FailureCategory,
  ChecklistItemResult,
  JudgeScore,
  JudgeOptions,
  CombinedScore,
  ScoreStddev,
  SessionLogEntry,
  MetricsData,
  SessionLog,
  EvaluationSummary,
  FailureBreakdown,
  ReportMetadata,
  EvaluationReport,
  HumanFeedback,
  TaskComparisonDelta,
  TaskComparison,
  ComparisonSummary,
  ComparisonData,
} from './types.js';

// Config
export { loadConfig, loadConfigSync, getDefaultWeights, DEFAULT_CONFIG, VALID_RUNNER_TYPES } from './config.js';
export type { EvalConfig, RunnerType } from './config.js';

// Parser
export { parseEvalFile, createEvalTemplate, validateEvalFile } from './parser.js';

// Runner
export { ClaudeSdkRunner } from './runner/claude-sdk-runner.js';
export type { AgentRunner, AgentRunnerOptions } from './runner/agent-runner.js';
export { createRunner } from './runner/runner-factory.js';
export { setupLocalSkills, cleanupLocalSkills } from './runner/skill-setup.js';
export { createToolPolicy } from './runner/security.js';

// Scorer
export { scoreTask, scoreAll } from './scorer/scorer.js';
export { scoreDeterministic } from './scorer/deterministic.js';
export { SkillJudge } from './scorer/judge.js';
export { aggregateResults, aggregateScores, computeStddev, FLAKY_STDDEV_THRESHOLD } from './scorer/aggregator.js';

// Session
export { SessionLogger } from './session/session-logger.js';

// Report
export { generateReport, generateJsonResults, computeSummary, computeFailureBreakdown } from './report/report.js';
export type { ReportOptions } from './report/report.js';
export { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';

// Feedback
export { generateFeedbackTemplate, writeFeedbackTemplate, loadFeedback, validateFeedback, getFeedbackForTask } from './feedback.js';

// Pipeline
export { runPipeline, scorePipeline } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';
