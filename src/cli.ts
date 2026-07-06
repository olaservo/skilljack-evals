#!/usr/bin/env node

/**
 * CLI for skill evaluation framework.
 *
 * Primary command: `skilljack-evals run` — runs the full evaluation pipeline
 * against a task package (or suite of task packages).
 * Also supports: score, report, create-task, validate, cache.
 */

import 'dotenv/config';
import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { validateTaskPackages } from './task/load.js';
import { scaffoldTaskPackage } from './task/scaffold.js';
import { runPipeline, scorePipeline } from './pipeline.js';
import { generateReport, generateJsonResults } from './report/report.js';
import { generateHtmlReport } from './report/html-report.js';
import type { EvalTask, TaskResult, SkillEvaluation, CombinedScore } from './types.js';
import { validateFeedback } from './feedback.js';
import { VALID_RUNNER_TYPES, SANDBOX_MODES, loadConfig } from './config.js';
import type { EvalConfig, RunnerType, SandboxMode } from './config.js';
import { importSkillsBenchTask } from './task/import-skillsbench.js';
import { exportSkillsBenchTask } from './task/export-skillsbench.js';
import { ResponseCache } from './cache/response-cache.js';
import type { WorkspaceCleanupPolicy } from './run/workspace.js';
import { NUDGE_LEVELS } from './run/nudge.js';
import type { NudgeLevel } from './run/nudge.js';
import { runOracleGate } from './score/oracle-gate.js';
import { RUNNER_SKILLS_MOUNT_PATHS } from './runner/runner-factory.js';

const program = new Command();

program
  .name('skilljack-evals')
  .description('Skill evaluation CLI — run evaluations, score results, generate reports')
  .version('2.0.0-alpha.1');

// ============================================
// Primary command: run
// ============================================

program
  .command('run')
  .description('Run the full evaluation pipeline: execute tasks → score → report')
  .argument('<path>', 'Path to a task-package dir or suite dir of task packages')
  .option('--runner <type>', 'Runner type: claude-sdk | claude-code | codex | gemini (experimental) | opencode (default: claude-sdk)')
  .option('--model <model>', 'Agent model (default: sonnet)')
  .option('--judge-model <model>', 'Judge model (default: haiku)')
  .option('--config <path>', 'Path to eval.config.yaml')
  .option('--output-dir <dir>', 'Output directory for results')
  .option('--timeout <ms>', 'Per-task timeout in milliseconds')
  .option('--tasks <ids>', 'Comma-separated task IDs to run')
  .option('--skills-dir <path>', 'Skills directory override applied to all tasks')
  .option('--cwd <path>', 'Base directory for task resolution and outputs (relative tasks path, output dir, and cache dir resolve against it; default: current directory)')
  .option('--threshold-resolution <rate>', 'Min with-skill resolution rate (0-1, default: 0.8)')
  .option('--threshold-lift <delta>', 'Min macro skill lift (default: not gated)')
  .option('--threshold-discovery <rate>', '(removed) use --threshold-resolution')
  .option('--threshold-score <score>', '(removed) use --threshold-resolution / --threshold-lift')
  .option('--judge', 'Enable LLM judge diagnostics (off by default; never affects pass/fail)')
  .option('--no-judge', '(deprecated no-op) the judge is off by default')
  .option('--baseline', 'Run the paired no-skill baseline (default: on when tasks have skills)')
  .option('--no-baseline', 'Skip the paired baseline condition')
  .option('--concurrency <number>', 'Max concurrent tasks (1=sequential, 0=unlimited)')
  .option('-k, --trials <number>', 'Number of trials per task per condition (default: 3)')
  .option('--runs <number>', 'Alias of --trials')
  .option('--nudge <level>', 'Skill nudge appended to with-skill prompts: off|name|description|full (default: off)')
  .option('--sandbox <mode>', 'Verifier/oracle sandbox: host | docker (default: host). Docker containerizes the VERIFIER, not the agent.')
  .option('--keep-workspaces <policy>', 'Workspace retention: all|failures|none (default: failures)')
  .option('--generate-feedback <path>', 'Generate feedback template JSON with task IDs after run')
  .option('--feedback <path>', 'Path to human review feedback JSON for judge prompt enrichment (requires --judge)')
  .option('--github-summary', 'Write GitHub Actions step summary')
  .option('--html', 'Generate HTML report (default: true)')
  .option('--no-html', 'Skip HTML report generation')
  .option('--compare-results <path>', 'Path to a previous run summary.json for cross-iteration comparison')
  .option('--compare', '(deprecated alias of --baseline)')
  .option('--compare-skill <path>', 'Path to baseline skill directory (e.g., previous version) for A/B comparison; implies baseline mode')
  .option('--compare-label <label>', 'Custom label for the baseline in comparison reports')
  .option('--blind-compare', 'Run blind A/B comparison of two skill versions (requires --compare-skill and --judge)')
  .option('--skip-cache', 'Skip cached results and re-execute all tasks (cache writes still occur)')
  .option('--bust-cache', 'Disable caching entirely (skip both reads and writes)')
  .action(async (tasksPath: string, options: {
    runner?: string;
    model?: string;
    judgeModel?: string;
    config?: string;
    outputDir?: string;
    timeout?: string;
    tasks?: string;
    skillsDir?: string;
    cwd?: string;
    thresholdResolution?: string;
    thresholdLift?: string;
    thresholdDiscovery?: string;
    thresholdScore?: string;
    judge?: boolean;
    baseline?: boolean;
    concurrency?: string;
    trials?: string;
    runs?: string;
    nudge?: string;
    sandbox?: string;
    keepWorkspaces?: string;
    generateFeedback?: string;
    feedback?: string;
    githubSummary?: boolean;
    html?: boolean;
    compareResults?: string;
    compare?: boolean;
    compareSkill?: string;
    blindCompare?: boolean;
    compareLabel?: string;
    skipCache?: boolean;
    bustCache?: boolean;
  }) => {
    try {
      if (options.thresholdDiscovery !== undefined || options.thresholdScore !== undefined) {
        console.error('Error: --threshold-discovery and --threshold-score were removed. Use --threshold-resolution <0-1> (min with-skill resolution rate) and optionally --threshold-lift <delta>.');
        process.exit(1);
      }

      if (options.runner && !VALID_RUNNER_TYPES.includes(options.runner as RunnerType)) {
        console.error(`Error: Invalid runner "${options.runner}". Valid options: ${VALID_RUNNER_TYPES.join(', ')}`);
        process.exit(1);
      }

      if (options.keepWorkspaces && !['all', 'failures', 'none'].includes(options.keepWorkspaces)) {
        console.error('Error: --keep-workspaces must be one of: all, failures, none');
        process.exit(1);
      }

      if (options.nudge && !NUDGE_LEVELS.includes(options.nudge as NudgeLevel)) {
        console.error(`Error: --nudge must be one of: ${NUDGE_LEVELS.join(', ')}`);
        process.exit(1);
      }

      if (options.sandbox && !SANDBOX_MODES.includes(options.sandbox as SandboxMode)) {
        console.error(`Error: --sandbox must be one of: ${SANDBOX_MODES.join(', ')}`);
        process.exit(1);
      }

      // Deprecated flags: keep accepting them, print a note.
      if (options.judge === false) {
        console.log('Note: --no-judge is deprecated — the judge is off by default. Use --judge to enable diagnostics.');
      }
      if (options.compare) {
        console.log('Note: --compare is deprecated — the paired baseline is now the default when skills are present. Use --baseline / --no-baseline.');
      }

      const configOverrides: Partial<EvalConfig> = {};
      if (options.runner) configOverrides.runnerType = options.runner as RunnerType;
      if (options.model) configOverrides.defaultAgentModel = options.model;
      if (options.judgeModel) configOverrides.defaultJudgeModel = options.judgeModel;
      if (options.outputDir) configOverrides.outputDir = options.outputDir;
      if (options.timeout) configOverrides.taskTimeoutMs = parseInt(options.timeout, 10);
      if (options.thresholdResolution) configOverrides.resolutionThreshold = parseFloat(options.thresholdResolution);
      if (options.thresholdLift) configOverrides.liftThreshold = parseFloat(options.thresholdLift);
      if (options.sandbox) configOverrides.sandbox = options.sandbox as SandboxMode;
      if (options.githubSummary) configOverrides.githubSummary = true;
      if (options.html !== undefined) configOverrides.htmlReport = options.html;
      if (options.concurrency !== undefined) {
        const c = Number(options.concurrency);
        if (!Number.isInteger(c) || c < 0) {
          console.error('Error: --concurrency must be a non-negative integer');
          process.exit(1);
        }
        configOverrides.concurrency = c;
      }

      // --baseline / --no-baseline / deprecated --compare. Undefined = auto
      // (on when the tasks have skills resolved). --compare-skill implies baseline.
      let baseline: boolean | undefined = options.baseline;
      if (baseline === undefined && options.compare) baseline = true;

      const trialsRaw = options.trials ?? options.runs;

      const result = await runPipeline({
        tasksPath,
        configPath: options.config,
        configOverrides,
        cwd: options.cwd,
        skillsDir: options.skillsDir,
        taskFilter: options.tasks,
        judge: options.judge === true ? true : undefined,
        numRuns: trialsRaw ? parseInt(trialsRaw, 10) : undefined,
        nudge: options.nudge as NudgeLevel | undefined,
        keepWorkspaces: options.keepWorkspaces as WorkspaceCleanupPolicy | undefined,
        generateFeedbackPath: options.generateFeedback,
        feedbackPath: options.feedback,
        compareResultsPath: options.compareResults,
        baseline,
        compareSkillPath: options.compareSkill,
        compareLabel: options.compareLabel,
        blindCompare: options.blindCompare,
        skipCache: options.skipCache,
        bustCache: options.bustCache,
      });

      if (!result.passed) {
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================
// Score existing results
// ============================================

program
  .command('score')
  .description('Score existing results JSON (no runner); --judge adds diagnostics after the fact')
  .argument('<results>', 'Path to results JSON file')
  .option('--judge', 'Enable LLM judge diagnostics (off by default)')
  .option('--judge-model <model>', 'Judge model')
  .option('--config <path>', 'Path to eval.config.yaml')
  .option('--no-deterministic', 'Skip deterministic checks')
  .option('--feedback <path>', 'Path to human review feedback JSON for judge prompt enrichment (requires --judge)')
  .action(async (resultsFile: string, options: {
    judgeModel?: string;
    config?: string;
    judge?: boolean;
    deterministic?: boolean;
    feedback?: string;
  }) => {
    try {
      const configOverrides: Partial<EvalConfig> = {};
      if (options.judgeModel) configOverrides.defaultJudgeModel = options.judgeModel;

      const result = await scorePipeline(resultsFile, {
        configPath: options.config,
        configOverrides,
        judge: options.judge === true ? true : undefined,
        noDeterministic: options.deterministic === false,
        feedbackPath: options.feedback,
      });

      if (!result.passed) {
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================
// Report generation
// ============================================

program
  .command('report')
  .description('Generate report from results JSON')
  .requiredOption('-r, --results <path>', 'Path to results JSON file')
  .option('-o, --output <path>', 'Output markdown file')
  .option('--json <path>', 'Also output JSON report')
  .option('--html-output <path>', 'Also output HTML report')
  .action(async (options: {
    results: string;
    output?: string;
    json?: string;
    htmlOutput?: string;
  }) => {
    try {
      const resultsData = await fs.readFile(options.results, 'utf-8');
      const data = JSON.parse(resultsData) as {
        skillName: string;
        tasks: Array<{ task: EvalTask; result: TaskResult; score: CombinedScore }>;
        metadata?: { skillPath: string; agentModel: string; judgeModel: string };
        humanFeedback?: Record<string, string>;
      };

      const evaluation: SkillEvaluation = {
        skillName: data.skillName,
        tasks: data.tasks.map((t) => t.task),
      };
      const results = data.tasks.map((t) => t.result);
      const scores = data.tasks.map((t) => t.score);

      // Validate humanFeedback from loaded JSON (may have been hand-edited)
      let humanFeedback: Record<string, string> | undefined;
      if (data.humanFeedback) {
        const validated = validateFeedback(data.humanFeedback as Record<string, unknown>);
        humanFeedback = Object.keys(validated).length > 0 ? validated : undefined;
      }

      const reportOptions = {
        evaluation, results, scores, metadata: data.metadata,
        humanFeedback,
      };
      const report = await generateReport({ ...reportOptions, outputPath: options.output });

      if (!options.output) {
        console.log(report);
      }

      if (options.json) {
        await generateJsonResults({ ...reportOptions, outputPath: options.json });
      }

      if (options.htmlOutput) {
        await generateHtmlReport({ ...reportOptions, outputPath: options.htmlOutput });
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================
// Create task package
// ============================================

program
  .command('create-task')
  .description('Scaffold a new task package (task.md, verifier, oracle, skills dir)')
  .argument('<id>', 'Task id — becomes the package directory name')
  .option('-o, --output <dir>', 'Parent directory for the task package (default: ./evals)')
  .action(async (id: string, options: { output?: string }) => {
    try {
      const baseDir = options.output || path.join(process.cwd(), 'evals');
      const { taskDir, files } = await scaffoldTaskPackage(id, baseDir);

      console.log(`Created task package: ${taskDir}`);
      for (const file of files) {
        console.log(`  ${path.relative(process.cwd(), file)}`);
      }
      console.log();
      console.log('Next steps:');
      console.log(`1. Edit ${path.join(taskDir, 'task.md')} — write the prompt and checks`);
      console.log(`2. Add the skill under ${path.join(taskDir, 'environment', 'skills')} (or use a suite-level skills/ dir)`);
      console.log(`3. Flesh out verifier/verify.mjs and oracle/solve.mjs, then run: skilljack-evals validate ${taskDir}`);
      console.log(`4. Run: skilljack-evals run ${taskDir}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================
// Validate
// ============================================

program
  .command('validate')
  .description('Validate task package(s): schema checks, plus the oracle gate when oracle + verifier exist')
  .argument('<path>', 'Path to a task-package dir or suite dir')
  .option('--skills-dir <path>', 'Skills directory override applied to all tasks')
  .option('--config <path>', 'Path to eval.config.yaml')
  .option('--runner <type>', 'Runner whose skills mount path the oracle-gate workspace uses (default: from config)')
  .option('--sandbox <mode>', 'Oracle-gate verifier sandbox: host | docker (default: from config)')
  .option('--no-oracle', 'Skip the oracle gate (schema validation only)')
  .action(async (inputPath: string, options: {
    skillsDir?: string;
    config?: string;
    runner?: string;
    sandbox?: string;
    oracle?: boolean;
  }) => {
    try {
      if (options.runner && !VALID_RUNNER_TYPES.includes(options.runner as RunnerType)) {
        console.error(`Error: Invalid runner "${options.runner}". Valid options: ${VALID_RUNNER_TYPES.join(', ')}`);
        process.exit(1);
      }
      if (options.sandbox && !SANDBOX_MODES.includes(options.sandbox as SandboxMode)) {
        console.error(`Error: --sandbox must be one of: ${SANDBOX_MODES.join(', ')}`);
        process.exit(1);
      }

      const configOverrides: Partial<EvalConfig> = {};
      if (options.runner) configOverrides.runnerType = options.runner as RunnerType;
      if (options.sandbox) configOverrides.sandbox = options.sandbox as SandboxMode;
      const config = await loadConfig(options.config, configOverrides);

      const { errors, warnings, suite } = await validateTaskPackages(inputPath, {
        skillsDirOverride: options.skillsDir,
      });

      for (const warning of warnings) {
        console.warn(`Warning: ${warning}`);
      }

      if (errors.length > 0 || !suite) {
        console.error(`Validation errors in ${inputPath}:`);
        for (const error of errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }

      console.log(`Valid: ${suite.tasks.length} task(s) for skill '${suite.skillName}'`);

      if (options.oracle === false) {
        return;
      }

      // The oracle-gate workspace mounts skills where the SELECTED runner
      // discovers them (e.g. codex: .agents/skills), so oracles that read
      // skill files see the same layout `run` would produce.
      const skillsMountPath = RUNNER_SKILLS_MOUNT_PATHS[config.runnerType];

      let oracleFailures = 0;
      for (const lt of suite.tasks) {
        const hasVerifier = !!(lt.verifierScript || lt.verifierCommand);
        if (!lt.oracleScript) {
          console.log(`  ${lt.task.id}: no oracle — skipping oracle gate`);
          continue;
        }
        if (!hasVerifier) {
          console.warn(`  ${lt.task.id}: WARN — oracle present but no verifier to gate against`);
          continue;
        }

        const { ok, detail } = await runOracleGate(lt, { sandbox: config.sandbox, skillsMountPath });
        if (ok) {
          console.log(`  ${lt.task.id}: PASS — ${detail}`);
        } else {
          oracleFailures++;
          console.error(`  ${lt.task.id}: FAIL — ${detail}`);
        }
      }

      if (oracleFailures > 0) {
        console.error(`\n${oracleFailures} task(s) failed the oracle gate`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================
// SkillsBench/BenchFlow interop: import / export
// ============================================

program
  .command('import')
  .description('Import a SkillsBench-native task package into our task-package format (tolerant frontmatter mapping)')
  .argument('<dir>', 'Path to a SkillsBench task package directory (contains task.md)')
  .option('--out <evalsDir>', 'Parent directory for the imported package (default: ./evals)')
  .action(async (dir: string, options: { out?: string }) => {
    try {
      const { taskDir, warnings } = await importSkillsBenchTask(dir, { outDir: options.out });
      for (const warning of warnings) {
        console.warn(`Warning: ${warning}`);
      }
      console.log(`Imported task package: ${taskDir}`);
      console.log(`Validate it with: skilljack-evals validate ${path.relative(process.cwd(), taskDir)}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('Export one of our task packages as a BenchFlow/SkillsBench-native package (verifier/test.sh wrapper, Dockerfile stub)')
  .argument('<taskDir>', 'Path to a task-package directory (contains task.md)')
  .option('--out <dir>', 'Output directory (default: ./export/<task-id>)')
  .action(async (taskDir: string, options: { out?: string }) => {
    try {
      const { outDir, warnings } = await exportSkillsBenchTask(taskDir, { outDir: options.out });
      for (const warning of warnings) {
        console.warn(`Warning: ${warning}`);
      }
      console.log(`Exported BenchFlow-native package: ${outDir}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================
// Cache management
// ============================================

const cacheCommand = program
  .command('cache')
  .description('Manage the response cache');

cacheCommand
  .command('clear')
  .description('Clear all cached agent responses')
  .option('--config <path>', 'Path to eval.config.yaml')
  .action(async (options: { config?: string }) => {
    try {
      const config = await loadConfig(options.config);
      const cache = new ResponseCache(config.cache);
      const { deletedCount } = await cache.clear();
      console.log(`Cleared ${deletedCount} cached response(s) from ${config.cache.dir}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program.parse();
