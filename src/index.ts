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
  RunnerOptions,
  FailureCategory,
  JudgeScore,
  JudgeOptions,
  CombinedScore,
  SessionLogEntry,
  MetricsData,
  SessionLog,
  EvaluationSummary,
  FailureBreakdown,
  ReportMetadata,
  EvaluationReport,
} from './types.js';

// Config
export { loadConfig, loadConfigSync, getDefaultWeights, DEFAULT_CONFIG } from './config.js';
export type { EvalConfig, RunnerType as ConfigRunnerType } from './config.js';

// Parser
export { parseEvalFile, createEvalTemplate, validateEvalFile } from './parser.js';

// Runner
export { SkillEvalRunner } from './runner/runner.js';
export { ClaudeSdkRunner } from './runner/claude-sdk-runner.js';
export type { AgentRunner, AgentRunnerOptions } from './runner/agent-runner.js';
export { createRunner } from './runner/runner-factory.js';
export type { RunnerType } from './runner/runner-factory.js';
export { setupLocalSkills, cleanupLocalSkills } from './runner/skill-setup.js';
export { createToolPolicy } from './runner/security.js';

// Scorer
export { scoreTask, scoreAll } from './scorer/scorer.js';
export { scoreDeterministic } from './scorer/deterministic.js';
export { SkillJudge } from './scorer/judge.js';
export { aggregateResults, aggregateScores } from './scorer/aggregator.js';

// Session
export { SessionLogger } from './session/session-logger.js';

// Report
export { generateReport, generateJsonResults, computeSummary, computeFailureBreakdown } from './report/report.js';
export { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';

// Pipeline
export { runPipeline, scorePipeline } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';
