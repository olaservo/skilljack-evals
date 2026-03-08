#!/usr/bin/env node

/**
 * CLI for skill evaluation framework.
 *
 * Primary command: `skilljack-evals run` — runs the full evaluation pipeline.
 * Also supports: score, report, create-eval, validate.
 */

import 'dotenv/config';
import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseEvalFile, createEvalTemplate, validateEvalFile } from './parser.js';
import { runPipeline, scorePipeline } from './pipeline.js';
import { generateReport, generateJsonResults } from './report/report.js';
import { SkillJudge } from './scorer/judge.js';
import type { EvalTask, TaskResult, JudgeScore, SkillEvaluation, CombinedScore } from './types.js';
import { validateFeedback } from './feedback.js';
import { VALID_RUNNER_TYPES } from './config.js';
import type { EvalConfig, RunnerType } from './config.js';

const program = new Command();

program
  .name('skilljack-evals')
  .description('Skill evaluation CLI — run evaluations, score results, generate reports')
  .version('1.0.0');

// ============================================
// Primary command: run
// ============================================

program
  .command('run')
  .description('Run the full evaluation pipeline: execute tasks → score → report')
  .argument('<tasks>', 'Path to tasks YAML file')
  .option('--runner <type>', 'Runner type: claude-sdk, vercel-ai, openai-agents (default: claude-sdk)')
  .option('--model <model>', 'Agent model (default: sonnet)')
  .option('--judge-model <model>', 'Judge model (default: haiku)')
  .option('--config <path>', 'Path to eval.config.yaml')
  .option('--output-dir <dir>', 'Output directory for results')
  .option('--timeout <ms>', 'Per-task timeout in milliseconds')
  .option('--tasks <ids>', 'Comma-separated task IDs to run')
  .option('--skills-dir <path>', 'Path to skills directory for local setup')
  .option('--cwd <path>', 'Working directory for agent execution')
  .option('--threshold-discovery <rate>', 'Min discovery rate (0-1)')
  .option('--threshold-score <score>', 'Min avg score (1-5)')
  .option('--no-judge', 'Skip LLM judge scoring (deterministic only)')
  .option('--no-deterministic', 'Skip deterministic scoring (LLM judge only)')
  .option('--runs <number>', 'Number of times to run each task (default: 3)')
  .option('--generate-feedback <path>', 'Generate feedback template JSON with task IDs after run')
  .option('--feedback <path>', 'Path to human review feedback JSON for judge prompt enrichment')
  .option('--github-summary', 'Write GitHub Actions step summary')
  .option('--verbose', 'Enable verbose output')
  .option('--compare', 'Run with and without skill to measure skill impact')
  .option('--compare-skill <path>', 'Compare current skill against a previous version')
  .action(async (tasksFile: string, options: {
    runner?: string;
    model?: string;
    judgeModel?: string;
    config?: string;
    outputDir?: string;
    timeout?: string;
    tasks?: string;
    skillsDir?: string;
    cwd?: string;
    thresholdDiscovery?: string;
    thresholdScore?: string;
    judge?: boolean;
    deterministic?: boolean;
    runs?: string;
    generateFeedback?: string;
    feedback?: string;
    githubSummary?: boolean;
    verbose?: boolean;
    compare?: boolean;
    compareSkill?: string;
  }) => {
    try {
      if (options.runner && !VALID_RUNNER_TYPES.includes(options.runner as RunnerType)) {
        console.error(`Error: Invalid runner "${options.runner}". Valid options: ${VALID_RUNNER_TYPES.join(', ')}`);
        process.exit(1);
      }

      const configOverrides: Partial<EvalConfig> = {};
      if (options.runner) configOverrides.runnerType = options.runner as RunnerType;
      if (options.model) configOverrides.defaultAgentModel = options.model;
      if (options.judgeModel) configOverrides.defaultJudgeModel = options.judgeModel;
      if (options.outputDir) configOverrides.outputDir = options.outputDir;
      if (options.timeout) configOverrides.taskTimeoutMs = parseInt(options.timeout, 10);
      if (options.thresholdDiscovery) configOverrides.discoveryThreshold = parseFloat(options.thresholdDiscovery);
      if (options.thresholdScore) configOverrides.scoreThreshold = parseFloat(options.thresholdScore);
      if (options.githubSummary) configOverrides.githubSummary = true;

      const result = await runPipeline({
        tasksFile,
        configPath: options.config,
        configOverrides,
        cwd: options.cwd,
        skillsDir: options.skillsDir,
        taskFilter: options.tasks,
        noJudge: options.judge === false,
        noDeterministic: options.deterministic === false,
        numRuns: options.runs ? parseInt(options.runs, 10) : undefined,
        generateFeedbackPath: options.generateFeedback,
        feedbackPath: options.feedback,
        verbose: options.verbose,
        compare: options.compare || !!options.compareSkill,
        compareSkillPath: options.compareSkill,
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
  .description('Score existing results JSON (no runner)')
  .argument('<results>', 'Path to results JSON file')
  .option('--judge-model <model>', 'Judge model')
  .option('--config <path>', 'Path to eval.config.yaml')
  .option('--no-judge', 'Skip LLM judge')
  .option('--no-deterministic', 'Skip deterministic checks')
  .option('--feedback <path>', 'Path to human review feedback JSON for judge prompt enrichment')
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
        noJudge: options.judge === false,
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
  .action(async (options: {
    results: string;
    output?: string;
    json?: string;
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
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================
// Create eval template
// ============================================

program
  .command('create-eval')
  .description('Create an evaluation template for a skill')
  .argument('<skill_name>', 'Name of the skill')
  .option('-o, --output <path>', 'Output path for template')
  .option('-n, --num-tasks <number>', 'Total number of tasks to generate (includes 1 false-positive)', '10')
  .action(async (skillName: string, options: {
    output?: string;
    numTasks: string;
  }) => {
    const outputPath = options.output || path.join(process.cwd(), 'evals', skillName, 'tasks.yaml');
    const numTasks = parseInt(options.numTasks, 10);
    if (isNaN(numTasks) || numTasks < 1) {
      console.error('Error: --num-tasks must be a positive integer');
      process.exit(1);
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const template = createEvalTemplate(skillName, numTasks);
    await fs.writeFile(outputPath, template);

    const numPositive = Math.max(1, numTasks - 1);
    console.log(`Created evaluation template: ${outputPath} (${numPositive} positive tasks + 1 false-positive)`);
    console.log();
    console.log('Next steps:');
    console.log(`1. Edit ${outputPath} to add real evaluation tasks`);
    console.log(`2. Run: skilljack-evals run ${outputPath}`);
  });

// ============================================
// Parse (legacy, for interop)
// ============================================

program
  .command('parse')
  .description('Parse tasks YAML and output JSON')
  .argument('<skill_name>', 'Name of the skill')
  .option('-f, --eval-file <path>', 'Path to evaluation YAML file')
  .option('-o, --output <path>', 'Output JSON file (default: stdout)')
  .action(async (skillName: string, options: {
    evalFile?: string;
    output?: string;
  }) => {
    const baseDir = path.join(process.cwd(), 'evals', skillName);
    const evalFile = options.evalFile || path.join(baseDir, 'tasks.yaml');

    try {
      await fs.access(evalFile);
    } catch {
      console.error(`Error: Evaluation file not found: ${evalFile}`);
      process.exit(1);
    }

    const evaluation = await parseEvalFile(evalFile);
    const json = JSON.stringify(evaluation, null, 2);

    if (options.output) {
      await fs.writeFile(options.output, json);
      console.error(`Parsed ${evaluation.tasks.length} tasks to: ${options.output}`);
    } else {
      console.log(json);
    }
  });

// ============================================
// Validate
// ============================================

program
  .command('validate')
  .description('Validate a tasks YAML file')
  .argument('<file>', 'Path to tasks YAML file')
  .action(async (file: string) => {
    const errors = await validateEvalFile(file);

    if (errors.length === 0) {
      const evaluation = await parseEvalFile(file);
      console.log(`Valid: ${evaluation.tasks.length} task(s) for skill '${evaluation.skillName}'`);
    } else {
      console.error(`Validation errors in ${file}:`);
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }
  });

// ============================================
// Judge (legacy single-task scoring)
// ============================================

program
  .command('judge')
  .description('Score a single task result using LLM judge')
  .requiredOption('--task-id <id>', 'Task ID')
  .requiredOption('--prompt <text>', 'Original task prompt')
  .requiredOption('--expected-skill <name>', 'Expected skill to be loaded')
  .requiredOption('--output <text>', 'Agent output to judge')
  .option('--skill-loads <skills>', 'Comma-separated list of skills loaded', '')
  .option('--checklist <items>', 'Comma-separated golden checklist items', '')
  .option('--model <model>', 'Judge model (default: haiku)')
  .option('--feedback <text>', 'Human review feedback text for this task')
  .option('-o, --output-file <path>', 'Output JSON file (default: stdout)')
  .action(async (options: {
    taskId: string;
    prompt: string;
    expectedSkill: string;
    output: string;
    skillLoads: string;
    checklist: string;
    model?: string;
    feedback?: string;
    outputFile?: string;
  }) => {
    const task: EvalTask = {
      id: options.taskId,
      prompt: options.prompt,
      expectedSkillLoad: options.expectedSkill,
      criteria: [
        { dimension: 'discovery', weight: 0.3, description: 'Skill discovery' },
        { dimension: 'adherence', weight: 0.4, description: 'Instruction adherence' },
        { dimension: 'output', weight: 0.3, description: 'Output quality' },
      ],
      goldenChecklist: options.checklist ? options.checklist.split(',').map(s => s.trim()) : [],
    };

    const result: TaskResult = {
      taskId: options.taskId,
      prompt: options.prompt,
      output: options.output,
      durationMs: 0,
      numTurns: 0,
      costUsd: 0,
      skillLoads: options.skillLoads ? options.skillLoads.split(',').map(s => s.trim()) : [],
      toolCalls: [],
      isError: false,
      errorMessage: '',
    };

    const judge = new SkillJudge({ model: options.model });
    console.error(`Judging task ${options.taskId}...`);
    const score = await judge.judgeResult(task, result, options.feedback);

    const json = JSON.stringify(score, null, 2);
    if (options.outputFile) {
      await fs.writeFile(options.outputFile, json);
      console.error(`Score saved to: ${options.outputFile}`);
    } else {
      console.log(json);
    }
  });

program.parse();
