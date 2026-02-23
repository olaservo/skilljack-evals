/**
 * Evaluation pipeline orchestrator.
 *
 * Coordinates the full evaluation flow:
 * parse tasks → setup skills → run agent → score → report → check thresholds
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { parseEvalFile } from './parser.js';
import { setupLocalSkills, cleanupLocalSkills } from './runner/skill-setup.js';
import { createRunner } from './runner/runner-factory.js';
import { scoreAll, type ScorerOptions } from './scorer/scorer.js';
import { SessionLogger } from './session/session-logger.js';
import { generateReport, generateJsonResults, computeSummary } from './report/report.js';
import { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';
import { loadConfig, type EvalConfig } from './config.js';
import { aggregateResults, aggregateScores } from './scorer/aggregator.js';
import type {
  SkillEvaluation,
  TaskResult,
  CombinedScore,
  EvaluationReport,
  ReportMetadata,
  EvalTask,
} from './types.js';

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
  /** Enable verbose logging */
  verbose?: boolean;
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
}

/**
 * Run the full evaluation pipeline.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const config = await loadConfig(options.configPath, options.configOverrides);
  const cwd = options.cwd || process.cwd();

  // 1. Parse tasks
  console.log(`Parsing tasks from: ${options.tasksFile}`);
  let evaluation = await parseEvalFile(options.tasksFile);

  // Filter tasks if specified
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

  console.log(`Running ${evaluation.tasks.length} task(s) for skill: ${evaluation.skillName}`);

  // 2. Setup local skills
  // Auto-detect skills/ directory relative to tasks file if not explicitly provided
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
      // No skills/ directory found, that's fine
    }
  }

  // 2b. Setup local skills (Claude SDK copies to .claude/skills/; others pass skillsDir to runner)
  let skillsSetup = false;
  if (skillsDir && config.runnerType === 'claude-sdk') {
    console.log(`Setting up local skills from: ${skillsDir}`);
    const skillNames = await setupLocalSkills(skillsDir, cwd);
    skillsSetup = true;
    console.log(`Skills configured: ${skillNames.join(', ')}`);
  } else if (skillsDir) {
    console.log(`Skills directory: ${skillsDir} (${config.runnerType} handles discovery natively)`);
  }

  try {
    // 3. Run agent against tasks (N times)
    const numRuns = options.numRuns ?? 3;
    const runner = await createRunner(config.runnerType, {
      cwd,
      model: config.defaultAgentModel,
      parallel: false,
      allowedWriteDirs: config.allowedWriteDirs,
      skillsDir,
    });

    const logDir = path.join(config.outputDir, 'logs');
    const scorerOptions: ScorerOptions = {
      noDeterministic: options.noDeterministic,
      noJudge: options.noJudge,
      judgeOptions: { model: config.defaultJudgeModel },
    };

    const allResults: TaskResult[][] = [];
    const allScores: CombinedScore[][] = [];

    for (let run = 0; run < numRuns; run++) {
      if (numRuns > 1) {
        console.log(`\n--- Run ${run + 1}/${numRuns} (${config.runnerType}) ---\n`);
      } else {
        console.log(`\n--- Running Tasks (${config.runnerType}) ---\n`);
      }

      const runLogDir = numRuns > 1 ? path.join(logDir, `run-${run + 1}`) : logDir;
      const results = await runner.runAll(
        evaluation,
        (task: EvalTask) => new SessionLogger(task.id, runLogDir)
      );
      allResults.push(results);

      // Score this run
      if (numRuns > 1) {
        console.log(`\n--- Scoring Run ${run + 1}/${numRuns} ---\n`);
      } else {
        console.log('\n--- Scoring ---\n');
      }
      const scores = await scoreAll(evaluation.tasks, results, scorerOptions);
      allScores.push(scores);
    }

    // Aggregate across runs
    const results = aggregateResults(allResults, allScores);
    const scores = aggregateScores(allScores);

    // Build per-run details for the report
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

    // 5. Generate reports
    console.log('\n--- Generating Reports ---\n');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportBaseName = `${evaluation.skillName}-${timestamp}`;
    const reportPath = path.join(config.outputDir, `${reportBaseName}.md`);
    const jsonPath = path.join(config.outputDir, `${reportBaseName}.json`);

    const metadata: ReportMetadata = {
      skillPath: options.tasksFile,
      runnerType: config.runnerType,
      agentModel: config.defaultAgentModel,
      judgeModel: config.defaultJudgeModel,
    };

    await generateReport(evaluation, results, scores, reportPath, metadata, numRuns, runDetails);
    const report = await generateJsonResults(evaluation, results, scores, jsonPath, metadata, numRuns, runDetails);

    // 6. GitHub summary
    if (config.githubSummary) {
      const wrote = await writeGitHubSummary(report);
      if (wrote) {
        console.log('GitHub step summary written');
      }
    }

    const markdownSummary = generateGitHubSummary(report);

    // 7. Print summary
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
  } finally {
    // Cleanup local skills
    if (skillsSetup) {
      await cleanupLocalSkills(cwd);
    }
  }
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
  } = {}
): Promise<PipelineResult> {
  const config = await loadConfig(options.configPath, options.configOverrides);

  const data = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
  const evaluation: SkillEvaluation = {
    skillName: data.skillName,
    tasks: data.tasks,
  };
  const results: TaskResult[] = data.results;

  const scorerOptions: ScorerOptions = {
    noDeterministic: options.noDeterministic,
    noJudge: options.noJudge,
    judgeOptions: { model: config.defaultJudgeModel },
  };

  console.log(`Scoring ${results.length} result(s)...`);
  const scores = await scoreAll(evaluation.tasks, results, scorerOptions);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportBaseName = `${evaluation.skillName}-scored-${timestamp}`;
  const reportPath = path.join(config.outputDir, `${reportBaseName}.md`);
  const jsonPath = path.join(config.outputDir, `${reportBaseName}.json`);

  const metadata: ReportMetadata = {
    skillPath: resultsPath,
    agentModel: data.metadata?.agentModel || config.defaultAgentModel,
    judgeModel: config.defaultJudgeModel,
  };

  await generateReport(evaluation, results, scores, reportPath, metadata);
  const report = await generateJsonResults(evaluation, results, scores, jsonPath, metadata);

  const markdownSummary = generateGitHubSummary(report);
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

function printSummary(report: EvaluationReport): void {
  const s = report.summary;
  console.log('\n' + '='.repeat(50));
  console.log(`  Skill Evaluation: ${report.skillName}`);
  console.log('='.repeat(50));
  console.log(`  Result: ${report.passed ? 'PASS' : 'FAIL'}`);
  if (s.numRuns > 1) {
    console.log(`  Runs: ${s.numRuns}`);
  }
  console.log(`  Discovery: ${(s.discoveryAccuracy * 100).toFixed(0)}%`);
  console.log(`  Avg Adherence: ${s.avgAdherence.toFixed(2)}/5`);
  console.log(`  Avg Output Quality: ${s.avgOutputQuality.toFixed(2)}/5`);
  console.log(`  Weighted Score: ${s.avgWeightedScore.toFixed(2)}`);
  console.log(`  Duration: ${(s.totalDurationMs / 1000).toFixed(1)}s | Cost: $${s.totalCostUsd.toFixed(4)}`);
  if (!report.passed && report.failureReasons.length > 0) {
    console.log(`\n  Failures:`);
    for (const reason of report.failureReasons) {
      console.log(`    - ${reason}`);
    }
  }
  console.log('='.repeat(50));
}
