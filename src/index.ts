/**
 * Skill evaluation framework.
 *
 * Provides tools for evaluating AI agent skill discoverability,
 * adherence, and output quality.
 *
 * @packageDocumentation
 */

import { runPipeline as runPipelineFn } from './pipeline.js';
import type { PipelineOptions as PipelineOptionsType } from './pipeline.js';
import type { RunSummary as RunSummaryType } from './results/types.js';

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
  ResolutionCI,
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
export { loadConfig, loadConfigSync, DEFAULT_CONFIG, VALID_RUNNER_TYPES, SANDBOX_MODES } from './config.js';
export type { EvalConfig, RunnerType, SandboxMode } from './config.js';

// Task packages
export { loadTaskPackages, validateTaskPackages } from './task/load.js';
export type { LoadedSuite, LoadedTask, LoadTaskOptions, TaskValidationResult } from './task/load.js';
export type { TaskFrontmatter, TaskChecks, VerifierFrontmatter } from './task/schema.js';
export { scaffoldTaskPackage } from './task/scaffold.js';
export { importSkillsBenchTask } from './task/import-skillsbench.js';
export type { ImportOptions, ImportResult } from './task/import-skillsbench.js';
export { exportSkillsBenchTask } from './task/export-skillsbench.js';
export type { ExportOptions, ExportResult } from './task/export-skillsbench.js';

// Workspaces
export { createTrialWorkspace, applyCleanupPolicy, copyDir, DEFAULT_SKILLS_MOUNT_PATH } from './run/workspace.js';
export type { TrialWorkspace, CreateTrialWorkspaceOptions, WorkspaceCleanupPolicy } from './run/workspace.js';

// Verifier
export { runVerifier, executeVerifier, resolveInterpreter, DEFAULT_VERIFIER_TIMEOUT_MS } from './score/verifier.js';
export type { RunVerifierOptions, ExecuteVerifierOptions, InterpreterResolution, VerifierInvocation } from './score/verifier.js';

// Runner
export { ClaudeSdkRunner } from './runner/claude-sdk-runner.js';
export { ClaudeCodeRunner, CLAUDE_CLI_INSTALL_HINT } from './runner/claude-code-runner.js';
export { CodexRunner, CODEX_CLI_INSTALL_HINT, skillNameFromCommand } from './runner/codex-runner.js';
export { GeminiRunner, GEMINI_CLI_INSTALL_HINT } from './runner/gemini-runner.js';
export { OpenCodeRunner, OPENCODE_CLI_INSTALL_HINT } from './runner/opencode-runner.js';
export type { AgentRunner, AgentRunnerOptions } from './runner/agent-runner.js';
export { createRunner } from './runner/runner-factory.js';
export { createToolPolicy, createPreToolUseHook } from './runner/security.js';

// Docker sandbox (verifier/oracle containerization — the agent runs on the host)
export { runVerifierInDocker, resolveContainerInterpreter, dockerImageTag, DEFAULT_DOCKER_IMAGE, DOCKER_UNAVAILABLE_HINT } from './sandbox/docker.js';
export type { RunVerifierInDockerOptions, DockerExecFn, DockerExecResult } from './sandbox/docker.js';

// Harness subprocess utilities
export { runCliJsonl, detectCli, killProcessTree } from './harness/subprocess.js';
export type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from './harness/subprocess.js';

// Skill nudge
export { buildNudge, buildNudgeForSkillsDir, NUDGE_LEVELS } from './run/nudge.js';
export type { NudgeLevel, NudgeSkill } from './run/nudge.js';

// Scorer
export { scoreTask, scoreAll } from './scorer/scorer.js';
export type { ScorerOptions } from './scorer/scorer.js';
export { scoreDeterministic } from './scorer/deterministic.js';
export type { DeterministicOptions } from './scorer/deterministic.js';

// Metrics (reward-authoritative)
export {
  resolutionRate,
  passAtK,
  binomialCI,
  skillLift,
  macroSkillLift,
  skillInvocationRate,
  groupMetrics,
} from './score/metrics.js';
export type { GroupMetrics, GroupedTaskTrials } from './score/metrics.js';

// Run summary (summary.json contract)
export { buildRunSummary, writeRunSummary, evaluateThresholds, collectFailedChecks } from './results/summary.js';
export type { BuildRunSummaryOptions, PhaseTrialData } from './results/summary.js';
export type {
  RunSummary,
  RunSummaryInfo,
  RunSummaryMetrics,
  RunSummaryThresholds,
  TaskRunSummary,
  ConditionStats,
  TrialFailure,
} from './results/types.js';
export { SkillJudge, blindCompareAll, BLIND_BIAS_THRESHOLD } from './scorer/judge.js';
export { DEFAULT_CONCURRENCY, DEFAULT_RUNNER_CONCURRENCY, withConcurrencyLimit } from './utils/concurrency.js';
export type { BlindCompareOptions } from './scorer/judge.js';
export { aggregateResults, aggregateScores, computeStddev, FLAKY_STDDEV_THRESHOLD, isFlaky } from './scorer/aggregator.js';

// Session
export { SessionLogger } from './session/session-logger.js';

// Report
export { generateReport, generateJsonResults, computeSummary, computeFailureBreakdown, evaluatePassFail, computeFailureReasons, trialFlags } from './report/report.js';
export type { ReportOptions, PassFailResult } from './report/report.js';
export { generateHtmlReport } from './report/html-report.js';
export { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';
export { loadPreviousRunSummary, compareRunSummaries, formatComparisonMarkdown, formatComparisonConsole, SIGNIFICANCE_THRESHOLD_RESOLUTION } from './report/comparison.js';
export { formatDelta, formatCategory, pct } from './utils/format.js';

// Feedback
export { generateFeedbackTemplate, writeFeedbackTemplate, loadFeedback, validateFeedback, getFeedbackForTask } from './feedback.js';

// Pipeline
export { runPipeline, scorePipeline } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';

/**
 * Stable programmatic API: run an evaluation and return the machine-readable
 * RunSummary (scores + failures + actionable side information). Designed to
 * be called per candidate from an external optimizer (GEPA-style loops).
 */
export async function runEvaluation(options: PipelineOptionsType): Promise<RunSummaryType> {
  const result = await runPipelineFn(options);
  return result.runSummary;
}

// Cache
export { ResponseCache, isTaskCacheable } from './cache/response-cache.js';
export type { CacheConfig, CacheEntry, CacheKeyParams, CacheKeyInputs, TaskCacheabilityContext } from './cache/response-cache.js';
