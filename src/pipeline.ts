/**
 * Evaluation pipeline orchestrator.
 *
 * Coordinates the full evaluation flow:
 * load task packages → per-trial workspace → run agent → verifier → score → summary.json → report → thresholds
 *
 * The paired baseline condition is the default when tasks have skills: each
 * task runs with AND without the skill so Skill Lift can be measured. The LLM
 * judge is opt-in diagnostics (--judge) and never affects pass/fail.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { formatDelta, pct } from './utils/format.js';
import { resolutionRate } from './score/metrics.js';
import { loadTaskPackages } from './task/load.js';
import type { LoadedSuite, LoadedTask } from './task/load.js';
import { createRunner } from './runner/runner-factory.js';
import { scoreAll, type ScorerOptions } from './scorer/scorer.js';
import { SessionLogger } from './session/session-logger.js';
import { generateReport, generateJsonResults, computeSummary, trialFlags, type ReportOptions } from './report/report.js';
import { generateHtmlReport } from './report/html-report.js';
import { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';
import { loadConfig, type EvalConfig } from './config.js';
import { aggregateResults, aggregateScores } from './scorer/aggregator.js';
import { loadPreviousRunSummary, compareRunSummaries, formatComparisonConsole } from './report/comparison.js';
import { buildRunSummary, writeRunSummary } from './results/summary.js';
import type { PhaseTrialData } from './results/summary.js';
import type { RunSummary } from './results/types.js';
import { createTrialWorkspace, applyCleanupPolicy } from './run/workspace.js';
import type { TrialWorkspace, WorkspaceCleanupPolicy } from './run/workspace.js';
import { buildNudgeForSkillsDir } from './run/nudge.js';
import type { NudgeLevel } from './run/nudge.js';
import { resolveSkillsDirLayout } from './runner/skill-discovery.js';
import { runVerifier } from './score/verifier.js';
import type {
  SkillEvaluation,
  TaskResult,
  CombinedScore,
  ComparisonResult,
  EvaluationReport,
  EvaluationSummary,
  ReportMetadata,
  EvalTask,
  HumanFeedback,
  ComparisonData,
  ComparisonSummary,
  TaskComparison,
  BlindComparisonData,
} from './types.js';
import { loadFeedback, writeFeedbackTemplate } from './feedback.js';
import { SkillJudge, blindCompareAll } from './scorer/judge.js';
import { ResponseCache, isTaskCacheable } from './cache/response-cache.js';
import { withConcurrencyLimit } from './utils/concurrency.js';

/**
 * Load human feedback from a file, validating against known task IDs.
 */
async function loadHumanFeedback(
  feedbackPath: string | undefined,
  tasks: EvalTask[]
): Promise<HumanFeedback | undefined> {
  if (!feedbackPath) return undefined;
  const taskIds = new Set(tasks.map(t => t.id));
  const feedback = await loadFeedback(feedbackPath, taskIds);
  const count = Object.keys(feedback).length;
  if (count === 0) {
    console.log(`Feedback file loaded from ${feedbackPath} but no non-empty entries found — skipping`);
    return undefined;
  }
  console.log(`Loaded human feedback for ${count} task(s) from: ${feedbackPath}`);
  return feedback;
}

/**
 * Derive a readable label from a skill path using the last two path components.
 * Avoids ambiguity when multiple paths share the same basename.
 */
export function smartLabel(skillPath: string): string {
  const parts = path.normalize(skillPath).split(path.sep).filter(Boolean);
  return parts.length >= 2
    ? parts.slice(-2).join('/')
    : parts[parts.length - 1] || skillPath;
}

export interface PipelineOptions {
  /** Path to a task-package dir or a suite dir of task packages */
  tasksPath: string;
  /** Path to eval.config.yaml */
  configPath?: string;
  /** Config overrides from CLI flags */
  configOverrides?: Partial<EvalConfig>;
  /**
   * Base directory the pipeline resolves against (default: process.cwd()):
   * relative tasksPath, outputDir (results/, workspaces, logs), and cache dir
   * resolve here, and the runner gets it as the fallback cwd (per-trial
   * workspaces still take precedence).
   */
  cwd?: string;
  /** Skills directory override applied to ALL tasks (candidate injection) */
  skillsDir?: string;
  /** Comma-separated task IDs to run (empty = all) */
  taskFilter?: string;
  /** Enable LLM judge diagnostics (overrides config.judgeEnabled) */
  judge?: boolean;
  /** Number of trials per task per condition (default: 3) */
  numRuns?: number;
  /** Path to a previous run's summary.json for cross-iteration comparison */
  compareResultsPath?: string;
  /** Path to write feedback template JSON after run */
  generateFeedbackPath?: string;
  /** Path to feedback JSON for judge prompt enrichment (requires judge) */
  feedbackPath?: string;
  /**
   * Paired baseline condition: run each task with AND without the skill.
   * Defaults to ON when tasks have skills resolved, OFF when none.
   */
  baseline?: boolean;
  /** Path to alternative skill for comparison (instead of no-skill baseline); implies baseline */
  compareSkillPath?: string;
  /** Custom label for the baseline in comparison reports */
  compareLabel?: string;
  /** Run blind A/B comparison (requires --compare-skill and --judge) */
  blindCompare?: boolean;
  /** Skip reading from cache (still writes new results) */
  skipCache?: boolean;
  /** Skip both reading and writing cache */
  bustCache?: boolean;
  /** Workspace retention policy after scoring (default: failures) */
  keepWorkspaces?: WorkspaceCleanupPolicy;
  /** Skill nudge level appended to with-skill prompts (overrides config.nudge) */
  nudge?: NudgeLevel;
}

export interface PipelineResult {
  passed: boolean;
  failureReasons: string[];
  evaluation: SkillEvaluation;
  results: TaskResult[];
  scores: CombinedScore[];
  report: EvaluationReport;
  /** Machine-readable run summary — the stable programmatic contract. */
  runSummary: RunSummary;
  summaryJsonPath: string;
  reportPath?: string;
  jsonPath?: string;
  markdownSummary: string;
  feedbackTemplatePath?: string;
  comparison?: ComparisonData;
  blindComparison?: BlindComparisonData;
  crossIterationComparison?: ComparisonResult;
}

/** Internal result from a single evaluation phase. */
interface PhaseResult {
  results: TaskResult[];
  scores: CombinedScore[];
  allResults: TaskResult[][];
  allScores: CombinedScore[][];
  summary: EvaluationSummary;
  runDetails: Array<{ result: TaskResult; score: CombinedScore }>[];
}

/** Cache options passed into runPhase. */
interface PhaseCacheOptions {
  cache: ResponseCache;
  skipCache?: boolean;
}

/**
 * Skills selection for a phase: 'task' mounts each task's resolved skills dir,
 * 'none' mounts no skills (baseline), a string mounts that directory for all tasks.
 */
type PhaseSkills = 'task' | 'none' | { dir: string };

function phaseSkillsDirFor(lt: LoadedTask, phaseSkills: PhaseSkills): string | undefined {
  if (phaseSkills === 'task') return lt.skillsDir;
  if (phaseSkills === 'none') return undefined;
  return phaseSkills.dir;
}

interface PhaseEnvOptions {
  workspaceBaseDir: string;
  keepWorkspaces: WorkspaceCleanupPolicy;
  phaseSkills: PhaseSkills;
  /**
   * Skill nudge appended to task prompts. The no-skill baseline passes 'off';
   * a --compare-skill baseline passes the configured level (nudge text is
   * built from that phase's effective skills dir, i.e. the compare dir).
   */
  nudgeLevel: NudgeLevel;
  /** Fallback runner cwd (per-trial workspaceDir takes precedence). */
  runnerCwd: string;
}

/**
 * Per-pipeline-run memoization: skills/environment content hashes and nudge
 * text are pure functions of (dir contents, level) for the duration of one
 * run, so each is computed once per distinct input instead of once per trial.
 * Deliberately NOT module-global — watch mode and repeated runPipeline calls
 * in tests get a fresh memo, so content changes between runs are never stale.
 */
interface PipelineMemo {
  hashes: Map<string, Promise<string>>;
  nudges: Map<string, Promise<string>>;
}

function createPipelineMemo(): PipelineMemo {
  return { hashes: new Map(), nudges: new Map() };
}

function memoized(map: Map<string, Promise<string>>, key: string, compute: () => Promise<string>): Promise<string> {
  let entry = map.get(key);
  if (!entry) {
    entry = compute();
    map.set(key, entry);
  }
  return entry;
}

function memoHashSkillsDir(memo: PipelineMemo, dir: string | undefined): Promise<string> {
  if (!dir) return Promise.resolve('no-skills');
  return memoized(memo.hashes, path.resolve(dir), () => ResponseCache.hashSkillsDir(dir));
}

async function memoHashEnvironment(memo: PipelineMemo, seedDir: string | undefined): Promise<string> {
  if (!seedDir) return 'no-environment';
  const hash = await memoHashSkillsDir(memo, seedDir);
  return hash === 'no-skills' ? 'no-environment' : hash;
}

function memoNudge(memo: PipelineMemo, level: NudgeLevel, skillsDir: string | undefined): Promise<string> {
  if (level === 'off' || !skillsDir) return Promise.resolve('');
  const key = `${level}\0${path.resolve(skillsDir)}`;
  return memoized(memo.nudges, key, () => buildNudgeForSkillsDir(level, skillsDir));
}

/** Per-trial outcome returned by each task factory (no side-channel arrays). */
interface TrialOutcome {
  result: TaskResult;
  /**
   * The task the trial actually executed and must be scored against: nudged
   * prompt on BOTH the cache-hit and miss paths (a cached output answered the
   * nudged prompt), plus workspaceDir on the miss path.
   */
  effectiveTask: EvalTask;
  /** Undefined on cache hits — no workspace was created. */
  workspace?: TrialWorkspace;
}

/**
 * Run a single evaluation phase (with or without skills).
 *
 * Encapsulates: create runner → per-trial workspace → run N times → verifier →
 * score → cleanup workspaces → aggregate. When cacheOptions is provided,
 * cacheable task results replay from cache without creating a workspace.
 */
async function runPhase(
  phaseLabel: string,
  suiteTasks: LoadedTask[],
  config: EvalConfig,
  numRuns: number,
  scorerOptions: ScorerOptions,
  logBaseDir: string,
  env: PhaseEnvOptions,
  memo: PipelineMemo,
  cacheOptions?: PhaseCacheOptions,
): Promise<PhaseResult> {
  const runner = await createRunner(config.runnerType, {
    cwd: env.runnerCwd,
    model: config.defaultAgentModel,
    allowedWriteDirs: config.allowedWriteDirs,
  }, config);

  const allResults: TaskResult[][] = [];
  const allScores: CombinedScore[][] = [];

  try {
    for (let run = 0; run < numRuns; run++) {
      if (numRuns > 1) {
        console.log(`\n--- ${phaseLabel}: Trial ${run + 1}/${numRuns} (${config.runnerType}) ---\n`);
      } else {
        console.log(`\n--- ${phaseLabel}: Running Tasks (${config.runnerType}) ---\n`);
      }

      const runLogDir = numRuns > 1 ? path.join(logBaseDir, `run-${run + 1}`) : logBaseDir;

      // Per-task execution with optional cache support, bounded by config.concurrency.
      // Tasks with verifiers, workspace seeds, or expectFileExists bypass the cache:
      // their success depends on filesystem state that a cached TaskResult cannot represent.
      let cacheHits = 0;
      const cacheConcurrent = config.concurrency ?? 1;

      // Workspaces created this trial run, with the latest trialFailed status.
      // Cleanup runs in `finally` so an aborted run (factory or scoreAll threw)
      // still applies the retention policy to whatever was created; unscored
      // trials count as failed so 'failures' keeps them for debugging.
      const createdWorkspaces = new Map<TrialWorkspace, boolean>();

      try {
        const factories = suiteTasks.map((lt) => async (): Promise<TrialOutcome> => {
          const task = lt.task;
          const effSkillsDir = phaseSkillsDirFor(lt, env.phaseSkills);

          // Finalize the prompt before cache-key computation so the nudge text is
          // naturally part of the cache key (which hashes the prompt).
          const nudgeText = await memoNudge(memo, env.nudgeLevel, effSkillsDir);
          const effectivePrompt = task.prompt + nudgeText;

          const hasVerifier = !!(lt.verifierScript || lt.verifierCommand);
          const cacheable = cacheOptions && isTaskCacheable(task, {
            hasVerifier,
            hasWorkspaceSeed: !!lt.workspaceSeedDir,
          });

          let cacheKey: string | null = null;
          let skillsHash: string | undefined;
          if (cacheable && cacheOptions) {
            skillsHash = await memoHashSkillsDir(memo, effSkillsDir);
            const environmentHash = await memoHashEnvironment(memo, lt.workspaceSeedDir);
            cacheKey = ResponseCache.computeCacheKey({
              taskId: task.id,
              prompt: effectivePrompt,
              model: config.defaultAgentModel,
              runnerType: config.runnerType,
              skillsHash,
              environmentHash,
              taskTimeoutMs: task.timeoutMs ?? config.taskTimeoutMs,
              allowedWriteDirs: config.allowedWriteDirs,
              runIndex: numRuns > 1 ? run : undefined,
            });

            if (!cacheOptions.skipCache) {
              const cached = await cacheOptions.cache.get(cacheKey);
              if (cached) {
                console.log(`Task ${task.id}: cache hit (hash ${cacheKey.substring(0, 8)})`);
                cacheHits++;
                // Same effectiveTask as the miss path (nudged prompt): the
                // cached output answered the NUDGED prompt, so scoring must
                // evaluate against it too. No workspace on this path.
                return { result: cached, effectiveTask: { ...task, prompt: effectivePrompt } };
              }
            }
          }

          // Create the per-trial workspace (seed files + skills mounted at the
          // runner's skill discovery path).
          const workspace = await createTrialWorkspace({
            baseDir: env.workspaceBaseDir,
            taskId: task.id,
            runIndex: run,
            seedDir: lt.workspaceSeedDir,
            skillsDir: effSkillsDir,
            skillsMountPath: runner.skillsMountPath,
          });
          createdWorkspaces.set(workspace, true);

          const effectiveTask: EvalTask = { ...task, prompt: effectivePrompt, workspaceDir: workspace.dir };

          console.log(`Running task ${task.id}: ${task.prompt.length > 60 ? task.prompt.slice(0, 60) + '...' : task.prompt}`);
          const logger = new SessionLogger(task.id, runLogDir);
          const result = await runner.runTaskWithTimeout(effectiveTask, undefined, logger);

          if (result.isError) {
            console.error(`  Task ${task.id} ERROR: ${result.errorMessage}`);
          } else {
            console.log(`  Task ${task.id}: Skills loaded: ${result.skillLoads.join(', ') || 'none'} | Duration: ${(result.durationMs / 1000).toFixed(1)}s | Cost: $${result.costUsd.toFixed(4)}`);
          }

          // Run the verifier when the task package has one (skipped on agent error).
          if (hasVerifier && !result.isError) {
            result.verifier = await runVerifier({
              scriptPath: lt.verifierScript,
              command: lt.verifierCommand,
              workspaceDir: workspace.dir,
              taskDir: lt.taskDir,
              output: result.output,
              toolCalls: result.toolCalls,
              timeoutMs: lt.verifierTimeoutMs,
              sandbox: config.sandbox,
            });
            console.log(`  Task ${task.id}: Verifier ${result.verifier.passed ? 'passed' : 'FAILED'} (reward ${result.verifier.reward}, status ${result.verifier.status})`);
          }

          if (cacheKey && cacheOptions && !result.isError) {
            await cacheOptions.cache.set(cacheKey, result, {
              taskId: task.id,
              cacheKeyPrefix: cacheKey.substring(0, 8),
              modelId: config.defaultAgentModel,
              runnerType: config.runnerType,
              // skillsHash was computed above when cacheKey was — reuse it.
              skillsHash: skillsHash!,
            });
          }

          return { result, effectiveTask, workspace };
        });

        const outcomes = await withConcurrencyLimit(factories, cacheConcurrent);

        if (cacheOptions && cacheHits > 0) {
          console.log(`\n${cacheHits} of ${suiteTasks.length} task(s) served from cache`);
        }

        const results = outcomes.map((o) => o.result);
        const effectiveTasks = outcomes.map((o) => o.effectiveTask);
        allResults.push(results);

        if (numRuns > 1) {
          console.log(`\n--- ${phaseLabel}: Scoring Trial ${run + 1}/${numRuns} ---\n`);
        } else {
          console.log(`\n--- ${phaseLabel}: Scoring ---\n`);
        }
        const scores = await scoreAll(effectiveTasks, results, scorerOptions);
        allScores.push(scores);

        // Record the real pass/fail per workspace for the cleanup policy.
        for (let t = 0; t < outcomes.length; t++) {
          const workspace = outcomes[t].workspace;
          if (workspace) createdWorkspaces.set(workspace, !scores[t].passed);
        }
      } finally {
        // Apply the workspace retention policy — on success AND on abort.
        for (const [workspace, trialFailed] of createdWorkspaces) {
          await applyCleanupPolicy(workspace, env.keepWorkspaces, trialFailed);
        }
      }
    }
  } finally {
    // Dispose runner resources (e.g., child processes) even when a trial threw.
    await runner.dispose?.();
  }

  const results = aggregateResults(allResults, allScores);
  const scores = aggregateScores(allScores);

  const runDetails: Array<{ result: TaskResult; score: CombinedScore }>[] = [];
  if (numRuns > 1) {
    for (let t = 0; t < suiteTasks.length; t++) {
      runDetails.push(
        allResults.map((r, run) => ({
          result: r[t],
          score: allScores[run][t],
        }))
      );
    }
  }

  const summary = computeSummary(results, scores, numRuns);

  return { results, scores, allResults, allScores, summary, runDetails };
}

/**
 * Compute comparison data from with-skill and baseline phase results.
 */
function computeComparison(
  withPhase: PhaseResult,
  basePhase: PhaseResult,
  baselineLabel: string,
  evalTasks: EvalTask[],
  compareSkillPath?: string,
): ComparisonData {
  const tasks: TaskComparison[] = [];

  for (let i = 0; i < withPhase.results.length; i++) {
    const w = { result: withPhase.results[i], score: withPhase.scores[i] };
    const b = { result: basePhase.results[i], score: basePhase.scores[i] };

    tasks.push({
      taskId: w.result.taskId,
      originalPrompt: evalTasks[i].prompt,
      withSkill: w,
      withoutSkill: b,
      delta: {
        taskId: w.result.taskId,
        lift: resolutionRate(trialFlags(w.score)) - resolutionRate(trialFlags(b.score)),
        durationDeltaMs: w.result.durationMs - b.result.durationMs,
        costDeltaUsd: w.result.costUsd - b.result.costUsd,
        totalTokensDelta:
          w.result.tokens && b.result.tokens
            ? w.result.tokens.total - b.result.tokens.total
            : undefined,
      },
    });
  }

  const summary: ComparisonSummary = {
    withSkill: withPhase.summary,
    withoutSkill: basePhase.summary,
    delta: {
      resolutionRateDelta: withPhase.summary.resolutionRate - basePhase.summary.resolutionRate,
      passAtKDelta: withPhase.summary.passAtK - basePhase.summary.passAtK,
      totalDurationDeltaMs: withPhase.summary.totalDurationMs - basePhase.summary.totalDurationMs,
      totalCostDeltaUsd: withPhase.summary.totalCostUsd - basePhase.summary.totalCostUsd,
      totalTokensDelta:
        withPhase.summary.totalTokens !== undefined && basePhase.summary.totalTokens !== undefined
          ? withPhase.summary.totalTokens - basePhase.summary.totalTokens
          : undefined,
    },
    baselineLabel,
  };

  return {
    compareSkillPath,
    summary,
    tasks,
  };
}

/**
 * Run the full evaluation pipeline.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const loadedConfig = await loadConfig(options.configPath, options.configOverrides);

  // --cwd (default: process.cwd()) is the base directory the pipeline
  // resolves against: relative outputDir (results/, workspaces, logs) and
  // cache dir become absolute here; tasksPath resolves against it below; and
  // the runner receives it as the fallback cwd.
  const baseCwd = path.resolve(options.cwd ?? process.cwd());
  const config: EvalConfig = {
    ...loadedConfig,
    outputDir: path.resolve(baseCwd, loadedConfig.outputDir),
    cache: { ...loadedConfig.cache, dir: path.resolve(baseCwd, loadedConfig.cache.dir) },
  };
  const tasksPath = path.resolve(baseCwd, options.tasksPath);

  const keepWorkspaces = options.keepWorkspaces ?? 'failures';
  const judgeEnabled = options.judge ?? config.judgeEnabled;

  if (options.blindCompare) {
    if (!options.compareSkillPath) {
      throw new Error('--blind-compare requires --compare-skill: blind comparison evaluates two skill VERSIONS against each other (per the agentskills authoring methodology), not with/without-skill.');
    }
    if (!judgeEnabled) {
      throw new Error('--blind-compare requires --judge (the blind comparison is an LLM-judge diagnostic).');
    }
  }

  // 1. Load task packages
  console.log(`Loading task packages from: ${tasksPath}`);
  const suite: LoadedSuite = await loadTaskPackages(tasksPath, {
    skillsDirOverride: options.skillsDir,
  });

  let suiteTasks = suite.tasks;
  if (options.taskFilter) {
    const filterIds = new Set(options.taskFilter.split(',').map((s) => s.trim()));
    suiteTasks = suiteTasks.filter((lt) => filterIds.has(lt.task.id));
    console.log(`Filtered to ${suiteTasks.length} task(s): ${options.taskFilter}`);
  }

  if (suiteTasks.length === 0) {
    throw new Error('No tasks to run');
  }

  const anySkills = suiteTasks.some((lt) => lt.skillsDir);

  // Paired baseline is the default whenever tasks have skills resolved.
  const baselineMode = options.compareSkillPath
    ? true
    : options.baseline ?? anySkills;

  if (baselineMode && !anySkills && !options.compareSkillPath) {
    throw new Error('--baseline requires skills but none were found. Add skills under environment/skills/ (or a suite-level skills/ dir), or use --compare-skill to specify a baseline skill path.');
  }

  if (options.compareLabel && !baselineMode) {
    console.warn('Warning: --compare-label has no effect without a baseline condition');
  }

  const evaluation: SkillEvaluation = {
    skillName: suite.skillName,
    tasks: suiteTasks.map((lt) => lt.task),
  };

  // Load human feedback if provided (judge-scoped)
  let humanFeedback: HumanFeedback | undefined;
  if (options.feedbackPath && !judgeEnabled) {
    console.log('Note: --feedback requires --judge (feedback enriches the judge prompt) — ignoring feedback file.');
  } else {
    humanFeedback = await loadHumanFeedback(options.feedbackPath, evaluation.tasks);
  }

  // Generate feedback template early (only needs task IDs, available even if run fails)
  let feedbackTemplatePath: string | undefined;
  if (options.generateFeedbackPath) {
    await writeFeedbackTemplate(evaluation.tasks, options.generateFeedbackPath);
    feedbackTemplatePath = options.generateFeedbackPath;
    console.log(`Feedback template written to: ${feedbackTemplatePath}`);
  }

  console.log(`Running ${evaluation.tasks.length} task(s) for skill: ${evaluation.skillName}`);

  // 1b. Validate comparison file early (before expensive pipeline run)
  let previousSummary: RunSummary | undefined;
  if (options.compareResultsPath) {
    console.log(`Validating comparison file: ${options.compareResultsPath}`);
    previousSummary = await loadPreviousRunSummary(options.compareResultsPath);
    console.log('Comparison file validated successfully');
  }

  // Validate compare-skill path and resolve the skill name(s) it mounts —
  // the baseline arm must score activation against the MOUNTED skill's name,
  // not the with-skill arm's expected name, or differently-named version
  // dirs would always fail with 'Wrong skill activated' and fabricate lift.
  let compareSkillNames: string[] | undefined;
  if (options.compareSkillPath) {
    let stat;
    try {
      stat = await fs.stat(options.compareSkillPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`--compare-skill path not found: ${options.compareSkillPath}`);
      }
      throw err;
    }
    if (!stat.isDirectory()) {
      throw new Error(`--compare-skill path is not a directory: ${options.compareSkillPath}`);
    }
    compareSkillNames = (await resolveSkillsDirLayout(options.compareSkillPath)).names;
    if (compareSkillNames.length === 0) {
      throw new Error(`--compare-skill path contains no skills (no SKILL.md found): ${options.compareSkillPath}`);
    }
  }

  const numRuns = options.numRuns ?? 3;
  const nudgeLevel: NudgeLevel = options.nudge ?? config.nudge;
  const logDir = path.join(config.outputDir, 'logs');
  const memo = createPipelineMemo();
  const scorerOptions: ScorerOptions = {
    judgeEnabled,
    judgeOptions: { model: config.defaultJudgeModel },
    humanFeedback,
    cwd: baseCwd,
  };

  // 2. Set up response cache
  const cacheEnabled = config.cache.enabled && !options.bustCache;
  const cacheOpts: PhaseCacheOptions | undefined = cacheEnabled
    ? { cache: new ResponseCache(config.cache), skipCache: options.skipCache }
    : undefined;

  // 3. Run evaluation phase(s)
  let primaryPhase: PhaseResult;
  let basePhase: PhaseResult | undefined;
  let baselineLabel: string | undefined;
  let comparison: ComparisonData | undefined;
  let blindComparison: BlindComparisonData | undefined;
  let crossIterationComparison: ComparisonResult | undefined;

  if (baselineMode) {
    // --- Paired conditions: with-skill + baseline ---
    const rawLabel = options.compareLabel?.trim();
    baselineLabel = (rawLabel && rawLabel.length > 0)
      ? rawLabel
      : (options.compareSkillPath
        ? smartLabel(options.compareSkillPath)
        : 'No Skill');

    console.log(`\nPaired baseline: running each task with skill AND "${baselineLabel}"`);
    console.log(`Total trials per task: ${numRuns * 2} (${numRuns} with skill + ${numRuns} baseline)\n`);

    // Phase 1: With Skill
    console.log('=== Phase 1/2: With Skill ===');
    const withPhase = await runPhase(
      'With Skill', suiteTasks, config, numRuns, scorerOptions,
      path.join(logDir, 'with-skill'),
      { workspaceBaseDir: config.outputDir, keepWorkspaces, phaseSkills: 'task', nudgeLevel, runnerCwd: baseCwd },
      memo,
      cacheOpts,
    );

    // Phase 2: Baseline
    console.log(`\n=== Phase 2/2: ${baselineLabel} ===`);

    // isBaseline (no-skill only): deterministic runs in baseline mode (no
    // activation gate) and the judge uses a prompt that doesn't penalize for
    // missing skill. Skill-version comparison keeps full scoring.
    const isNoSkillBaseline = !options.compareSkillPath;
    const baselineScorerOptions: ScorerOptions = {
      ...scorerOptions,
      isBaseline: isNoSkillBaseline,
    };

    // Skill-version comparison: the baseline arm mounts the compare dir, so
    // its activation check must expect the MOUNTED skill's resolved name.
    // Anti-trigger tasks (expectedSkillLoad 'none') keep 'none'.
    let baselineSuiteTasks = suiteTasks;
    if (options.compareSkillPath && compareSkillNames) {
      const names = compareSkillNames;
      baselineSuiteTasks = suiteTasks.map((lt) => {
        const expected = lt.task.expectedSkillLoad;
        if (!expected || expected === 'none') return lt;
        let overrideName: string;
        if (names.length === 1) {
          overrideName = names[0];
        } else if (names.includes(expected)) {
          // Same defaulting rule as the loader: an explicit expected name
          // wins when the dir offers multiple skills.
          overrideName = expected;
        } else {
          throw new Error(
            `--compare-skill dir contains multiple skills (${names.join(', ')}) and none matches task ${lt.task.id}'s expected skill '${expected}' — use a single-skill directory or align the skill names.`,
          );
        }
        if (overrideName === expected) return lt;
        return { ...lt, task: { ...lt.task, expectedSkillLoad: overrideName } };
      });
    }

    basePhase = await runPhase(
      baselineLabel, baselineSuiteTasks, config, numRuns, baselineScorerOptions,
      path.join(logDir, 'baseline'),
      {
        workspaceBaseDir: path.join(config.outputDir, 'baseline'),
        keepWorkspaces,
        phaseSkills: options.compareSkillPath ? { dir: options.compareSkillPath } : 'none',
        // Only the no-skill baseline gets the bare prompt. A skill-version
        // comparison applies the SAME nudge level to both arms — the nudge
        // text is built from the compare dir's skills via phaseSkillsDirFor.
        nudgeLevel: options.compareSkillPath ? nudgeLevel : 'off',
        runnerCwd: baseCwd,
      },
      memo,
      cacheOpts,
    );

    console.log('\n=== Computing Comparison Deltas ===\n');
    comparison = computeComparison(withPhase, basePhase, baselineLabel, evaluation.tasks, options.compareSkillPath);

    if (options.blindCompare) {
      console.log('\n=== Running Blind A/B Comparison ===\n');
      const blindJudge = new SkillJudge({ model: config.defaultJudgeModel });
      blindComparison = await blindCompareAll(comparison.tasks, blindJudge);
    }

    primaryPhase = withPhase;
  } else {
    // --- Single condition ---
    primaryPhase = await runPhase(
      'Evaluation', suiteTasks, config, numRuns, scorerOptions, logDir,
      { workspaceBaseDir: config.outputDir, keepWorkspaces, phaseSkills: 'task', nudgeLevel, runnerCwd: baseCwd },
      memo,
      cacheOpts,
    );
  }

  // 4. Build + write the machine-readable run summary (summary.json)
  const withTrialData: PhaseTrialData = {
    allResults: primaryPhase.allResults,
    allScores: primaryPhase.allScores,
  };
  const baseTrialData: PhaseTrialData | undefined = basePhase
    ? { allResults: basePhase.allResults, allScores: basePhase.allScores }
    : undefined;

  const runSummary = buildRunSummary({
    tasks: evaluation.tasks,
    skillName: evaluation.skillName,
    withSkill: withTrialData,
    baseline: baseTrialData,
    baselineLabel,
    config,
    nudge: nudgeLevel,
    trials: numRuns,
    judgeEnabled,
  });
  const summaryJsonPath = await writeRunSummary(runSummary, config.outputDir);
  console.log(`\nRun summary saved to: ${summaryJsonPath}`);

  // Compare with previous results if requested (cross-iteration comparison)
  if (previousSummary) {
    console.log('\n--- Comparing with Previous Results ---\n');
    if (previousSummary.run.skillName !== evaluation.skillName) {
      console.warn(`Warning: Skill name mismatch — current: "${evaluation.skillName}", previous: "${previousSummary.run.skillName}"`);
    }
    crossIterationComparison = compareRunSummaries(runSummary, previousSummary);

    if (crossIterationComparison.taskDeltas.length === 0 && runSummary.tasks.length > 0) {
      console.warn('Warning: No tasks matched between current and previous results. Comparison may not be meaningful.');
    }
    if (crossIterationComparison.tasksOnlyInCurrent.length > 0) {
      console.warn(`Warning: ${crossIterationComparison.tasksOnlyInCurrent.length} task(s) in current results not found in previous: ${crossIterationComparison.tasksOnlyInCurrent.join(', ')}`)
    }
    if (crossIterationComparison.tasksOnlyInPrevious.length > 0) {
      console.warn(`Warning: ${crossIterationComparison.tasksOnlyInPrevious.length} task(s) in previous results not found in current: ${crossIterationComparison.tasksOnlyInPrevious.join(', ')}`);
    }
  }

  // 5. Generate reports
  console.log('\n--- Generating Reports ---\n');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = comparison ? 'paired' : '';
  const reportBaseName = [evaluation.skillName, suffix, timestamp].filter(Boolean).join('-');
  const reportPath = path.join(config.outputDir, `${reportBaseName}.md`);
  const jsonPath = path.join(config.outputDir, `${reportBaseName}.json`);

  const metadata: ReportMetadata = {
    skillPath: options.tasksPath,
    runnerType: config.runnerType,
    agentModel: config.defaultAgentModel,
    judgeModel: config.defaultJudgeModel,
  };

  const reportOptions = {
    evaluation,
    results: primaryPhase.results,
    scores: primaryPhase.scores,
    metadata,
    numRuns,
    runDetails: primaryPhase.runDetails,
    humanFeedback,
    comparison,
    blindComparison,
    crossIterationComparison,
    config,
  };

  await generateReport({ ...reportOptions, outputPath: reportPath });
  const report = await generateJsonResults({ ...reportOptions, outputPath: jsonPath });

  await maybeGenerateHtmlReport(config, reportBaseName, reportOptions);

  if (config.githubSummary) {
    const wrote = await writeGitHubSummary(report, config);
    if (wrote) {
      console.log('GitHub step summary written');
    }
  }

  const markdownSummary = generateGitHubSummary(report, config);
  printSummary(report, runSummary);

  if (comparison) {
    printComparisonSummary(comparison);
  }
  if (blindComparison) {
    printBlindComparisonSummary(blindComparison);
  }
  if (crossIterationComparison) {
    console.log(formatComparisonConsole(crossIterationComparison));
  }

  return {
    passed: report.passed,
    failureReasons: report.failureReasons,
    evaluation,
    results: primaryPhase.results,
    scores: primaryPhase.scores,
    report,
    runSummary,
    summaryJsonPath,
    reportPath,
    jsonPath,
    markdownSummary,
    feedbackTemplatePath,
    comparison,
    blindComparison,
    crossIterationComparison,
  };
}

/**
 * Score existing results (no runner).
 */
export async function scorePipeline(
  resultsPath: string,
  options: {
    configPath?: string;
    configOverrides?: Partial<EvalConfig>;
    judge?: boolean;
    noDeterministic?: boolean;
    feedbackPath?: string;
    cwd?: string;
  } = {}
): Promise<Omit<PipelineResult, 'runSummary' | 'summaryJsonPath'>> {
  const config = await loadConfig(options.configPath, options.configOverrides);
  const judgeEnabled = options.judge ?? config.judgeEnabled;

  const data = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
  const evaluation: SkillEvaluation = {
    skillName: data.skillName,
    tasks: data.tasks,
  };
  const results: TaskResult[] = data.results;

  // Load human feedback if provided (judge-scoped)
  let humanFeedback: HumanFeedback | undefined;
  if (options.feedbackPath && !judgeEnabled) {
    console.log('Note: --feedback requires --judge (feedback enriches the judge prompt) — ignoring feedback file.');
  } else {
    humanFeedback = await loadHumanFeedback(options.feedbackPath, evaluation.tasks);
  }

  const scorerOptions: ScorerOptions = {
    noDeterministic: options.noDeterministic,
    judgeEnabled,
    judgeOptions: { model: config.defaultJudgeModel },
    humanFeedback,
    cwd: options.cwd,
  };

  console.log(`Scoring ${results.length} result(s)...`);
  const scores = await scoreAll(evaluation.tasks, results, scorerOptions);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportBaseName = `${evaluation.skillName}-scored-${timestamp}`;
  const reportPath = path.join(config.outputDir, `${reportBaseName}.md`);
  const jsonPath = path.join(config.outputDir, `${reportBaseName}.json`);

  const metadata: ReportMetadata = {
    skillPath: resultsPath,
    runnerType: data.metadata?.runnerType || config.runnerType,
    agentModel: data.metadata?.agentModel || config.defaultAgentModel,
    judgeModel: config.defaultJudgeModel,
  };

  const reportOptions = {
    evaluation, results, scores, metadata, humanFeedback, config,
  };
  await generateReport({ ...reportOptions, outputPath: reportPath });
  const report = await generateJsonResults({ ...reportOptions, outputPath: jsonPath });

  await maybeGenerateHtmlReport(config, reportBaseName, reportOptions);

  const markdownSummary = generateGitHubSummary(report, config);
  printSummary(report);

  return {
    passed: report.passed,
    failureReasons: report.failureReasons,
    evaluation,
    results,
    scores,
    report,
    reportPath,
    jsonPath,
    markdownSummary,
  };
}

/**
 * Generate the HTML report if enabled in config, returning the output path.
 * Logs a warning and returns undefined if generation fails.
 */
async function maybeGenerateHtmlReport(
  config: EvalConfig,
  reportBaseName: string,
  reportOptions: Omit<ReportOptions, 'outputPath'>,
): Promise<string | undefined> {
  if (!config.htmlReport) return undefined;
  try {
    const htmlPath = path.join(config.outputDir, `${reportBaseName}.html`);
    await generateHtmlReport({ ...reportOptions, outputPath: htmlPath });
    return htmlPath;
  } catch (err) {
    console.warn(`Warning: HTML report generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function printSummary(report: EvaluationReport, runSummary?: RunSummary): void {
  const s = report.summary;
  console.log('\n' + '='.repeat(50));
  console.log(`  Skill Evaluation: ${report.skillName}`);
  console.log('='.repeat(50));
  console.log(`  Result: ${report.passed ? 'PASS' : 'FAIL'}`);
  if (s.numRuns > 1) {
    console.log(`  Trials per task: ${s.numRuns}`);
  }
  console.log(`  Resolution Rate: ${(s.resolutionRate * 100).toFixed(0)}% (CI ${(s.resolutionCI.low * 100).toFixed(0)}-${(s.resolutionCI.high * 100).toFixed(0)}%)`);
  console.log(`  Pass@${s.numRuns}: ${(s.passAtK * 100).toFixed(0)}%`);
  if (runSummary?.metrics.skillLift !== undefined) {
    console.log(`  Skill Lift: ${formatDelta(runSummary.metrics.skillLift * 100, 1)}%`);
  }
  if (s.invocationRate !== undefined) {
    console.log(`  Skill Invocation Rate: ${(s.invocationRate * 100).toFixed(0)}%`);
  }
  if (s.avgAdherence !== undefined && s.avgOutputQuality !== undefined) {
    console.log(`  Judge diagnostics: adherence ${s.avgAdherence.toFixed(2)}/5, output ${s.avgOutputQuality.toFixed(2)}/5`);
  }
  console.log(`  Duration: ${(s.totalDurationMs / 1000).toFixed(1)}s | Cost: $${s.totalCostUsd.toFixed(4)}`);
  if (!report.passed && report.failureReasons.length > 0) {
    console.log(`\n  Failures:`);
    for (const reason of report.failureReasons) {
      console.log(`    - ${reason}`);
    }
  }
  console.log('='.repeat(50));
}

function printComparisonSummary(comparison: ComparisonData): void {
  const d = comparison.summary.delta;
  console.log('\n' + '-'.repeat(50));
  console.log(`  Skill Impact (vs ${comparison.summary.baselineLabel})`);
  console.log('-'.repeat(50));
  console.log(`  Skill Lift (resolution delta): ${formatDelta(d.resolutionRateDelta * 100, 1)}%`);
  console.log(`  Pass@k Delta: ${formatDelta(d.passAtKDelta * 100, 1)}%`);
  console.log(`  Duration Delta: ${formatDelta(d.totalDurationDeltaMs / 1000, 1)}s`);
  console.log(`  Cost Delta: $${formatDelta(d.totalCostDeltaUsd, 4)}`);
  console.log('-'.repeat(50));
}

function printBlindComparisonSummary(blind: BlindComparisonData): void {
  const a = blind.aggregate;
  const evaluated = blind.tasks.length - a.failedCount;
  console.log('\n' + '-'.repeat(50));
  console.log('  Blind A/B Comparison');
  console.log('-'.repeat(50));
  console.log(`  With-skill preferred: ${a.withSkillPreferred}/${evaluated} (${pct(a.withSkillPreferred, evaluated)}%)`);
  console.log(`  Without-skill preferred: ${a.withoutSkillPreferred}/${evaluated} (${pct(a.withoutSkillPreferred, evaluated)}%)`);
  console.log(`  Ties: ${a.ties}/${evaluated}`);
  if (a.biasSignalCount > 0) {
    console.log(`  Bias signals: ${a.biasSignalCount} (blind disagrees with standard scoring)`);
  }
  if (a.failedCount > 0) {
    console.log(`  Failed: ${a.failedCount} blind judge call(s) failed (excluded from counts)`);
  }
  console.log('-'.repeat(50));
}
