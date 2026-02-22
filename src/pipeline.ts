/**
 * Evaluation pipeline orchestrator.
 *
 * Coordinates the full evaluation flow:
 * parse tasks → setup skills → run agent → score → report → check thresholds
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { parseEvalFile } from './parser.js';
import { SkillEvalRunner } from './runner/runner.js';
import { setupLocalSkills, cleanupLocalSkills } from './runner/skill-setup.js';
import { scoreAll, type ScorerOptions } from './scorer/scorer.js';
import { SessionLogger } from './session/session-logger.js';
import { generateReport, generateJsonResults, computeSummary } from './report/report.js';
import { generateGitHubSummary, writeGitHubSummary } from './report/github-summary.js';
import { loadConfig, type EvalConfig } from './config.js';
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

  // 2. Setup local skills if skills directory provided
  let skillsSetup = false;
  if (options.skillsDir) {
    console.log(`Setting up local skills from: ${options.skillsDir}`);
    const skillNames = await setupLocalSkills(options.skillsDir, cwd);
    skillsSetup = true;
    console.log(`Skills configured: ${skillNames.join(', ')}`);
  }

  try {
    // 3. Run agent against tasks
    console.log('\n--- Running Tasks ---\n');
    const runner = new SkillEvalRunner({
      cwd,
      model: config.defaultAgentModel,
      parallel: false,
      allowedWriteDirs: config.allowedWriteDirs,
    });

    const logDir = path.join(config.outputDir, 'logs');
    const results = await runner.runAll(
      evaluation,
      (task: EvalTask) => new SessionLogger(task.id, logDir)
    );

    // 4. Score results
    console.log('\n--- Scoring ---\n');
    const scorerOptions: ScorerOptions = {
      noDeterministic: options.noDeterministic,
      noJudge: options.noJudge,
      judgeOptions: { model: config.defaultJudgeModel },
    };
    const scores = await scoreAll(evaluation.tasks, results, scorerOptions);

    // 5. Generate reports
    console.log('\n--- Generating Reports ---\n');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportBaseName = `${evaluation.skillName}-${timestamp}`;
    const reportPath = path.join(config.outputDir, `${reportBaseName}.md`);
    const jsonPath = path.join(config.outputDir, `${reportBaseName}.json`);

    const metadata: ReportMetadata = {
      skillPath: options.tasksFile,
      agentModel: config.defaultAgentModel,
      judgeModel: config.defaultJudgeModel,
    };

    await generateReport(evaluation, results, scores, reportPath, metadata);
    const report = await generateJsonResults(evaluation, results, scores, jsonPath, metadata);

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
