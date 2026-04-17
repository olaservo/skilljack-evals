/**
 * Evaluation pipeline orchestrator.
 *
 * Coordinates the full evaluation flow:
 * parse tasks → setup skills → run agent → score → report → check thresholds
 *
 * In comparison mode (--compare), runs each task with AND without the skill,
 * then computes delta metrics showing the skill's impact.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { formatDelta, pct } from './utils/format.js';
import { parseEvalFile } from './parser.js';
import { setupLocalSkills, cleanupLocalSkills } from './runner/skill-setup.js';
import { createRunner } from './runner/runner-factory.js';
import { scoreAll, type ScorerOptions } from './scorer/scorer.js';
import { SessionLogger } from './session/session-logger.js';
import { generateReport, generateJsonResults, computeSummary, type ReportOptions } from './report/report.js';
import { generateHtmlReport } from './report/html-report.js';
import { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';
import { loadConfig, type EvalConfig } from './config.js';
import { aggregateResults, aggregateScores } from './scorer/aggregator.js';
import { loadPreviousReport, compareResults, formatComparisonConsole } from './report/comparison.js';
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
import { ResponseCache } from './cache/response-cache.js';

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
  /** Path to tasks YAML file */
  tasksFile: string;
  /** Path to eval.config.yaml */
  configPath?: string;
  /** Config overrides from CLI flags */
  configOverrides?: Partial<EvalConfig>;
  /** Working directory for agent execution */
  cwd?: string;
  /** Path to skills directory (for local skill setup) */
  skillsDir?: string;
  /** Comma-separated task IDs to run (empty = all) */
  taskFilter?: string;
  /** Skip deterministic scoring */
  noDeterministic?: boolean;
  /** Skip LLM judge scoring */
  noJudge?: boolean;
  /** Number of times to run each task (default: 3) */
  numRuns?: number;
  /** Path to previous JSON results for comparison */
  compareResultsPath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Path to write feedback template JSON after run */
  generateFeedbackPath?: string;
  /** Path to feedback JSON for judge prompt enrichment */
  feedbackPath?: string;
  /** Enable comparison mode: run with AND without skill */
  compare?: boolean;
  /** Path to alternative skill for comparison (instead of no-skill baseline) */
  compareSkillPath?: string;
  /** Custom label for the baseline in comparison reports */
  compareLabel?: string;
  /** Run blind A/B comparison alongside --compare */
  blindCompare?: boolean;
  /** Skip reading from cache (still writes new results) */
  skipCache?: boolean;
  /** Skip both reading and writing cache */
  bustCache?: boolean;
}

export interface PipelineResult {
  passed: boolean;
  failureReasons: string[];
  evaluation: SkillEvaluation;
  results: TaskResult[];
  scores: CombinedScore[];
  report: EvaluationReport;
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
  skillsHash: string;
  skipCache?: boolean;
}

/**
 * Run a single evaluation phase (with or without skills).
 *
 * Encapsulates: create runner → run N times → score → aggregate.
 * When cacheOptions is provided, individual task results are cached
 * so unchanged executions replay from cache.
 */
async function runPhase(
  phaseLabel: string,
  evaluation: SkillEvaluation,
  config: EvalConfig,
  cwd: string,
  skillsDir: string | undefined,
  numRuns: number,
  scorerOptions: ScorerOptions,
  logBaseDir: string,
  cacheOptions?: PhaseCacheOptions,
): Promise<PhaseResult> {
  const runner = await createRunner(config.runnerType, {
    cwd,
    model: config.defaultAgentModel,
    concurrency: config.concurrency,
    allowedWriteDirs: config.allowedWriteDirs,
    skillsDir,
  }, config);

  const allResults: TaskResult[][] = [];
  const allScores: CombinedScore[][] = [];

  for (let run = 0; run < numRuns; run++) {
    if (numRuns > 1) {
      console.log(`\n--- ${phaseLabel}: Run ${run + 1}/${numRuns} (${config.runnerType}) ---\n`);
    } else {
      console.log(`\n--- ${phaseLabel}: Running Tasks (${config.runnerType}) ---\n`);
    }

    const runLogDir = numRuns > 1 ? path.join(logBaseDir, `run-${run + 1}`) : logBaseDir;

    // Per-task execution with cache support.
    // Tasks run sequentially (not via runAll) so each result can be cached individually.
    const results: TaskResult[] = [];
    let cacheHits = 0;
    for (const task of evaluation.tasks) {
      // Compute cache key if caching is available
      const cacheKey = cacheOptions
        ? ResponseCache.computeCacheKey({
            taskId: task.id,
            prompt: task.prompt,
            model: config.defaultAgentModel,
            runnerType: config.runnerType,
            skillsHash: cacheOptions.skillsHash,
            taskTimeoutMs: config.taskTimeoutMs,
            allowedWriteDirs: config.allowedWriteDirs,
            runIndex: numRuns > 1 ? run : undefined,
          })
        : null;

      // Attempt cache read
      let result: TaskResult | null = null;
      if (cacheKey && cacheOptions && !cacheOptions.skipCache) {
        result = await cacheOptions.cache.get(cacheKey);
        if (result) {
          console.log(`Task ${task.id}: cache hit (hash ${cacheKey.substring(0, 8)})`);
          cacheHits++;
        }
      }

      // Cache miss: run the task
      if (!result) {
        console.log(`Running task ${task.id}: ${task.prompt.length > 60 ? task.prompt.slice(0, 60) + '...' : task.prompt}`);
        const logger = new SessionLogger(task.id, runLogDir);
        result = await runner.runTaskWithTimeout(task, undefined, logger);

        if (result.isError) {
          console.error(`  ERROR: ${result.errorMessage}`);
        } else {
          console.log(`  Skills loaded: ${result.skillLoads.join(', ') || 'none'}`);
          console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s | Cost: $${result.costUsd.toFixed(4)}`);
        }

        // Write to cache (skip for errors)
        if (cacheKey && cacheOptions && !result.isError) {
          await cacheOptions.cache.set(cacheKey, result, {
            taskId: task.id,
            cacheKeyPrefix: cacheKey.substring(0, 8),
            modelId: config.defaultAgentModel,
            runnerType: config.runnerType,
            skillsHash: cacheOptions.skillsHash,
          });
        }
      }

      results.push(result);
    }

    if (cacheOptions && cacheHits > 0) {
      console.log(`\n${cacheHits} of ${evaluation.tasks.length} task(s) served from cache`);
    }

    allResults.push(results);

    if (numRuns > 1) {
      console.log(`\n--- ${phaseLabel}: Scoring Run ${run + 1}/${numRuns} ---\n`);
    } else {
      console.log(`\n--- ${phaseLabel}: Scoring ---\n`);
    }
    const scores = await scoreAll(evaluation.tasks, results, scorerOptions);
    allScores.push(scores);
  }

  // Dispose runner resources (e.g., child processes) after all runs complete
  await runner.dispose?.();

  const results = aggregateResults(allResults, allScores);
  const scores = aggregateScores(allScores);

  const runDetails: Array<{ result: TaskResult; score: CombinedScore }>[] = [];
  if (numRuns > 1) {
    for (let t = 0; t < evaluation.tasks.length; t++) {
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
 * Setup local skills for Claude SDK and Copilot SDK runners.
 * Returns true if skills were set up and need cleanup.
 */
async function setupSkills(
  skillsDir: string | undefined,
  config: EvalConfig,
  cwd: string,
): Promise<boolean> {
  if (!skillsDir) return false;
  if (config.runnerType === 'claude-sdk' || config.runnerType === 'copilot-sdk') {
    console.log(`Setting up local skills from: ${skillsDir}`);
    const skillNames = await setupLocalSkills(skillsDir, cwd);
    console.log(`Skills configured: ${skillNames.join(', ')}`);
    return true;
  }
  console.log(`Skills directory: ${skillsDir} (${config.runnerType} handles discovery natively)`);
  return false;
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
        discoveryDelta: w.score.discovery - b.score.discovery,
        adherenceDelta: w.score.adherence - b.score.adherence,
        outputQualityDelta: w.score.outputQuality - b.score.outputQuality,
        weightedScoreDelta: w.score.weightedScore - b.score.weightedScore,
        durationDeltaMs: w.result.durationMs - b.result.durationMs,
        costDeltaUsd: w.result.costUsd - b.result.costUsd,
      },
    });
  }

  const summary: ComparisonSummary = {
    withSkill: withPhase.summary,
    withoutSkill: basePhase.summary,
    delta: {
      discoveryAccuracyDelta: withPhase.summary.discoveryAccuracy - basePhase.summary.discoveryAccuracy,
      avgAdherenceDelta: withPhase.summary.avgAdherence - basePhase.summary.avgAdherence,
      avgOutputQualityDelta: withPhase.summary.avgOutputQuality - basePhase.summary.avgOutputQuality,
      avgWeightedScoreDelta: withPhase.summary.avgWeightedScore - basePhase.summary.avgWeightedScore,
      totalDurationDeltaMs: withPhase.summary.totalDurationMs - basePhase.summary.totalDurationMs,
      totalCostDeltaUsd: withPhase.summary.totalCostUsd - basePhase.summary.totalCostUsd,
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
  const config = await loadConfig(options.configPath, options.configOverrides);
  const cwd = options.cwd || process.cwd();
  const compareMode = options.compare || !!options.compareSkillPath;

  if (options.blindCompare && !compareMode) {
    throw new Error('--blind-compare requires --compare mode');
  }

  if (options.compareLabel && !compareMode) {
    console.warn('Warning: --compare-label has no effect without --compare or --compare-skill');
  }

  // 1. Parse tasks
  console.log(`Parsing tasks from: ${options.tasksFile}`);
  let evaluation = await parseEvalFile(options.tasksFile);

  if (options.taskFilter) {
    const filterIds = new Set(options.taskFilter.split(',').map((s) => s.trim()));
    evaluation = {
      ...evaluation,
      tasks: evaluation.tasks.filter((t) => filterIds.has(t.id)),
    };
    console.log(`Filtered to ${evaluation.tasks.length} task(s): ${options.taskFilter}`);
  }

  if (evaluation.tasks.length === 0) {
    throw new Error('No tasks to run');
  }

  // Load human feedback if provided
  const humanFeedback = await loadHumanFeedback(options.feedbackPath, evaluation.tasks);

  // Generate feedback template early (only needs task IDs, available even if run fails)
  let feedbackTemplatePath: string | undefined;
  if (options.generateFeedbackPath) {
    await writeFeedbackTemplate(evaluation.tasks, options.generateFeedbackPath);
    feedbackTemplatePath = options.generateFeedbackPath;
    console.log(`Feedback template written to: ${feedbackTemplatePath}`);
  }

  console.log(`Running ${evaluation.tasks.length} task(s) for skill: ${evaluation.skillName}`);

  // 1b. Validate comparison file early (before expensive pipeline run)
  let previousReport: Awaited<ReturnType<typeof loadPreviousReport>> | undefined;
  if (options.compareResultsPath) {
    console.log(`Validating comparison file: ${options.compareResultsPath}`);
    previousReport = await loadPreviousReport(options.compareResultsPath);
    console.log('Comparison file validated successfully');
  }

  // 2. Detect skills directory
  let skillsDir = options.skillsDir;
  if (!skillsDir) {
    const tasksDir = path.dirname(path.resolve(options.tasksFile));
    const autoSkillsDir = path.join(tasksDir, 'skills');
    try {
      const stat = await fs.stat(autoSkillsDir);
      if (stat.isDirectory()) {
        skillsDir = autoSkillsDir;
      }
    } catch {
      // No skills/ directory found
    }
  }

  // Validate compare-skill path
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
  }

  if (compareMode && !skillsDir) {
    throw new Error('--compare requires a skills directory but none was found. Provide a skill via the evaluation YAML or use --compare-skill to specify a baseline skill path.');
  }

  const numRuns = options.numRuns ?? 3;
  const logDir = path.join(config.outputDir, 'logs');
  const scorerOptions: ScorerOptions = {
    noDeterministic: options.noDeterministic,
    noJudge: options.noJudge,
    judgeOptions: { model: config.defaultJudgeModel },
    humanFeedback,
    cwd,
  };

  // 2b. Set up response cache
  const cacheEnabled = config.cache.enabled && !options.bustCache;
  const cache = cacheEnabled ? new ResponseCache(config.cache) : null;
  const skillsHash = cache ? await ResponseCache.hashSkillsDir(skillsDir) : '';
  const cacheOpts: PhaseCacheOptions | undefined = cache
    ? { cache, skillsHash, skipCache: options.skipCache }
    : undefined;

  // 3. Run evaluation phase(s)
  let primaryPhase: PhaseResult;
  let comparison: ComparisonData | undefined;
  let blindComparison: BlindComparisonData | undefined;
  let crossIterationComparison: ComparisonResult | undefined;

  let needsCleanup = false;
  try {
    if (compareMode && skillsDir) {
      // --- Comparison mode: two phases ---
      const rawLabel = options.compareLabel?.trim();
      const baselineLabel = (rawLabel && rawLabel.length > 0)
        ? rawLabel
        : (options.compareSkillPath
          ? smartLabel(options.compareSkillPath)
          : 'No Skill');

      console.log(`\nComparison mode: running each task with skill AND "${baselineLabel}"`);
      console.log(`Total runs per task: ${numRuns * 2} (${numRuns} with skill + ${numRuns} baseline)\n`);

      // Phase 1: With Skill
      console.log('=== Phase 1/2: With Skill ===');
      needsCleanup = await setupSkills(skillsDir, config, cwd);

      const withPhase = await runPhase(
        'With Skill', evaluation, config, cwd, skillsDir, numRuns, scorerOptions,
        path.join(logDir, 'with-skill'), cacheOpts,
      );

      // Clean up between phases
      if (needsCleanup) {
        await cleanupLocalSkills(cwd);
        needsCleanup = false;
      }

      // Phase 2: Baseline
      console.log(`\n=== Phase 2/2: ${baselineLabel} ===`);
      const baseSkillsDir = options.compareSkillPath;
      if (baseSkillsDir) {
        needsCleanup = await setupSkills(baseSkillsDir, config, cwd);
      }

      // Only skip deterministic for no-skill baseline; version comparison keeps it.
      // isBaseline tells the judge to use a prompt that doesn't penalize for missing skill.
      const isNoSkillBaseline = !options.compareSkillPath;
      const baselineScorerOptions: ScorerOptions = {
        ...scorerOptions,
        noDeterministic: isNoSkillBaseline ? true : scorerOptions.noDeterministic,
        isBaseline: isNoSkillBaseline,
      };

      // Recompute skills hash for baseline phase (different skill dir or no skills)
      const baseCacheOpts: PhaseCacheOptions | undefined = cache
        ? { cache, skillsHash: await ResponseCache.hashSkillsDir(baseSkillsDir), skipCache: options.skipCache }
        : undefined;

      const basePhase = await runPhase(
        baselineLabel, evaluation, config, cwd, baseSkillsDir, numRuns, baselineScorerOptions,
        path.join(logDir, 'baseline'), baseCacheOpts,
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
      // --- Normal mode: single phase ---
      needsCleanup = await setupSkills(skillsDir, config, cwd);
      primaryPhase = await runPhase('Evaluation', evaluation, config, cwd, skillsDir, numRuns, scorerOptions, logDir, cacheOpts);
    }

    // Compare with previous results if requested (cross-iteration comparison)
    if (previousReport) {
      console.log('\n--- Comparing with Previous Results ---\n');
      if (previousReport.skillName !== evaluation.skillName) {
        console.warn(`Warning: Skill name mismatch — current: "${evaluation.skillName}", previous: "${previousReport.skillName}"`);
      }
      const currentSummary = computeSummary(primaryPhase.results, primaryPhase.scores, numRuns);
      crossIterationComparison = compareResults(primaryPhase.scores, currentSummary, previousReport);

      if (crossIterationComparison.taskDeltas.length === 0 && primaryPhase.scores.length > 0) {
        console.warn('Warning: No tasks matched between current and previous results. Comparison may not be meaningful.');
      }
      if (crossIterationComparison.tasksOnlyInCurrent.length > 0) {
        console.warn(`Warning: ${crossIterationComparison.tasksOnlyInCurrent.length} task(s) in current results not found in previous: ${crossIterationComparison.tasksOnlyInCurrent.join(', ')}`)
      }
      if (crossIterationComparison.tasksOnlyInPrevious.length > 0) {
        console.warn(`Warning: ${crossIterationComparison.tasksOnlyInPrevious.length} task(s) in previous results not found in current: ${crossIterationComparison.tasksOnlyInPrevious.join(', ')}`);
      }
    }
  } finally {
    if (needsCleanup) {
      await cleanupLocalSkills(cwd);
    }
  }

  // 4. Generate reports
  console.log('\n--- Generating Reports ---\n');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = comparison ? 'comparison' : '';
  const reportBaseName = [evaluation.skillName, suffix, timestamp].filter(Boolean).join('-');
  const reportPath = path.join(config.outputDir, `${reportBaseName}.md`);
  const jsonPath = path.join(config.outputDir, `${reportBaseName}.json`);

  const metadata: ReportMetadata = {
    skillPath: options.tasksFile,
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
    comparison,
    blindComparison,
    crossIterationComparison,
    config,
  };

  await generateReport({ ...reportOptions, outputPath: reportPath });
  const report = await generateJsonResults({ ...reportOptions, outputPath: jsonPath });

  const htmlPath = await maybeGenerateHtmlReport(config, reportBaseName, reportOptions);

  if (config.githubSummary) {
    const wrote = await writeGitHubSummary(report, config);
    if (wrote) {
      console.log('GitHub step summary written');
    }
  }

  const markdownSummary = generateGitHubSummary(report, config);
  printSummary(report);

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
    reportPath,
    jsonPath,
    markdownSummary,
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
    noJudge?: boolean;
    noDeterministic?: boolean;
    feedbackPath?: string;
  } = {}
): Promise<PipelineResult> {
  const config = await loadConfig(options.configPath, options.configOverrides);

  const data = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
  const evaluation: SkillEvaluation = {
    skillName: data.skillName,
    tasks: data.tasks,
  };
  const results: TaskResult[] = data.results;

  // Load human feedback if provided
  const humanFeedback = await loadHumanFeedback(options.feedbackPath, evaluation.tasks);

  const scorerOptions: ScorerOptions = {
    noDeterministic: options.noDeterministic,
    noJudge: options.noJudge,
    judgeOptions: { model: config.defaultJudgeModel },
    humanFeedback,
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

  const htmlPath = await maybeGenerateHtmlReport(config, reportBaseName, reportOptions);

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

function printSummary(report: EvaluationReport): void {
  const s = report.summary;
  console.log('\n' + '='.repeat(50));
  console.log(`  Skill Evaluation: ${report.skillName}`);
  console.log('='.repeat(50));
  console.log(`  Result: ${report.passed ? 'PASS' : 'FAIL'}`);
  if (s.numRuns > 1) {
    console.log(`  Runs: ${s.numRuns}`);
  }
  console.log(`  Discovery: ${(s.discoveryAccuracy * 100).toFixed(0)}%${s.stddev ? ` (\u00B1 ${(s.stddev.discovery * 100).toFixed(1)}%)` : ''}`);
  console.log(`  Avg Adherence: ${s.avgAdherence.toFixed(2)}/5${s.stddev ? ` (\u00B1 ${s.stddev.adherence.toFixed(2)})` : ''}`);
  console.log(`  Avg Output Quality: ${s.avgOutputQuality.toFixed(2)}/5${s.stddev ? ` (\u00B1 ${s.stddev.outputQuality.toFixed(2)})` : ''}`);
  console.log(`  Weighted Score: ${s.avgWeightedScore.toFixed(2)}${s.stddev ? ` (\u00B1 ${s.stddev.weightedScore.toFixed(2)})` : ''}`);
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
  console.log(`  Discovery Delta: ${formatDelta(d.discoveryAccuracyDelta * 100, 0)}%`);
  console.log(`  Adherence Delta: ${formatDelta(d.avgAdherenceDelta)}`);
  console.log(`  Output Quality Delta: ${formatDelta(d.avgOutputQualityDelta)}`);
  console.log(`  Weighted Score Delta: ${formatDelta(d.avgWeightedScoreDelta, 2)}`);
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

