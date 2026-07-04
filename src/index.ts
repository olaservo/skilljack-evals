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
  TaskDifficulty,
  VerifierOutcome,
  VerifierStatus,
  ToolCallRecord,
  TaskResult,
  TokenUsage,
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
  ScoreSnapshot,
  SummarySnapshot,
  TaskDelta,
  SummaryDelta,
  ComparisonResult,
  BlindOutputScore,
  BlindTaskComparison,
  BlindComparisonData,
} from './types.js';

// Config
export { loadConfig, loadConfigSync, DEFAULT_CONFIG, VALID_RUNNER_TYPES } from './config.js';
export type { EvalConfig, RunnerType } from './config.js';

// Task packages
export { loadTaskPackages, validateTaskPackages } from './task/load.js';
export type { LoadedSuite, LoadedTask, LoadTaskOptions, TaskValidationResult } from './task/load.js';
export type { TaskFrontmatter, TaskChecks, VerifierFrontmatter } from './task/schema.js';
export { scaffoldTaskPackage } from './task/scaffold.js';

// Workspaces
export { createTrialWorkspace, applyCleanupPolicy, copyDir, DEFAULT_SKILLS_MOUNT_PATH } from './run/workspace.js';
export type { TrialWorkspace, CreateTrialWorkspaceOptions, WorkspaceCleanupPolicy } from './run/workspace.js';

// Verifier
export { runVerifier, executeVerifier, resolveInterpreter, DEFAULT_VERIFIER_TIMEOUT_MS } from './score/verifier.js';
export type { RunVerifierOptions, ExecuteVerifierOptions, InterpreterResolution, VerifierInvocation } from './score/verifier.js';

// Runner
export { ClaudeSdkRunner } from './runner/claude-sdk-runner.js';
export { ClaudeCodeRunner, CLAUDE_CLI_INSTALL_HINT } from './runner/claude-code-runner.js';
export type { AgentRunner, AgentRunnerOptions } from './runner/agent-runner.js';
export { createRunner } from './runner/runner-factory.js';
export { createToolPolicy, createPreToolUseHook } from './runner/security.js';

// Harness subprocess utilities
export { runCliJsonl, detectCli, killProcessTree } from './harness/subprocess.js';
export type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from './harness/subprocess.js';

// Skill nudge
export { buildNudge, buildNudgeForSkillsDir, NUDGE_LEVELS } from './run/nudge.js';
export type { NudgeLevel, NudgeSkill } from './run/nudge.js';

// Scorer
export { scoreTask, scoreAll } from './scorer/scorer.js';
export { scoreDeterministic } from './scorer/deterministic.js';
export type { DeterministicOptions } from './scorer/deterministic.js';
export { SkillJudge, blindCompareAll, BLIND_BIAS_THRESHOLD } from './scorer/judge.js';
export { DEFAULT_CONCURRENCY, DEFAULT_RUNNER_CONCURRENCY, withConcurrencyLimit } from './utils/concurrency.js';
export type { BlindCompareOptions } from './scorer/judge.js';
export { aggregateResults, aggregateScores, computeStddev, FLAKY_STDDEV_THRESHOLD, isFlaky } from './scorer/aggregator.js';

// Session
export { SessionLogger } from './session/session-logger.js';

// Report
export { generateReport, generateJsonResults, computeSummary, computeFailureBreakdown } from './report/report.js';
export type { ReportOptions } from './report/report.js';
export { generateHtmlReport } from './report/html-report.js';
export { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';
export { loadPreviousReport, compareResults, formatComparisonMarkdown, formatComparisonConsole } from './report/comparison.js';
export { formatDelta, formatCategory, pct } from './utils/format.js';

// Feedback
export { generateFeedbackTemplate, writeFeedbackTemplate, loadFeedback, validateFeedback, getFeedbackForTask } from './feedback.js';

// Pipeline
export { runPipeline, scorePipeline } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';

// Cache
export { ResponseCache, isTaskCacheable } from './cache/response-cache.js';
export type { CacheConfig, CacheEntry, CacheKeyParams, CacheKeyInputs, TaskCacheabilityContext } from './cache/response-cache.js';
