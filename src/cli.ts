#!/usr/bin/env node

/**
 * CLI for skill evaluation framework.
 */

import 'dotenv/config';
import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseEvalFile, createEvalTemplate } from './parser.js';
import { SkillJudge } from './judge.js';
import { generateReport, generateJsonResults } from './report.js';
import type { EvalTask, TaskResult, JudgeScore, SkillEvaluation } from './types.js';
import type { SkillMetadata } from './report.js';

const program = new Command();

program
  .name('skill-evals')
  .description('Skill evaluation utilities - parse tasks, judge results, generate reports')
  .version('0.1.0');

program
  .command('create-eval')
  .description('Create an evaluation template for a skill')
  .argument('<skill_name>', 'Name of the skill')
  .option('-o, --output <path>', 'Output path for template')
  .option('-n, --num-tasks <number>', 'Number of placeholder tasks', '10')
  .action(async (skillName: string, options: {
    output?: string;
    numTasks: string;
  }) => {
    const outputPath = options.output || path.join(process.cwd(), 'evals', skillName, 'tasks.xml');
    const numTasks = parseInt(options.numTasks, 10);

    // Create directory if needed
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    // Generate template
    const template = createEvalTemplate(skillName, numTasks);
    await fs.writeFile(outputPath, template);

    console.log(`Created evaluation template: ${outputPath}`);
    console.log();
    console.log('Next steps:');
    console.log(`1. Edit ${outputPath} to add real evaluation tasks`);
    console.log(`2. Run: skill-evals run ${skillName}`);
  });

// ============================================
// Commands for Claude Code mode
// ============================================

program
  .command('parse')
  .description('Parse tasks.xml and output JSON (for Claude Code mode)')
  .argument('<skill_name>', 'Name of the skill')
  .option('-f, --eval-file <path>', 'Path to evaluation XML file')
  .option('-o, --output <path>', 'Output JSON file (default: stdout)')
  .action(async (skillName: string, options: {
    evalFile?: string;
    output?: string;
  }) => {
    const baseDir = path.join(process.cwd(), 'evals', skillName);
    const evalFile = options.evalFile || path.join(baseDir, 'tasks.xml');

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

program
  .command('judge')
  .description('Score a single task result (for Claude Code mode)')
  .requiredOption('--task-id <id>', 'Task ID')
  .requiredOption('--prompt <text>', 'Original task prompt')
  .requiredOption('--expected-skill <name>', 'Expected skill to be loaded')
  .requiredOption('--output <text>', 'Agent output to judge')
  .option('--skill-loads <skills>', 'Comma-separated list of skills that were loaded', '')
  .option('--checklist <items>', 'Comma-separated golden checklist items', '')
  .option('--model <model>', 'Judge model (default: haiku)')
  .option('-o, --output-file <path>', 'Output JSON file (default: stdout)')
  .action(async (options: {
    taskId: string;
    prompt: string;
    expectedSkill: string;
    output: string;
    skillLoads: string;
    checklist: string;
    model?: string;
    outputFile?: string;
  }) => {
    // Build task object
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

    // Build result object
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

    // Judge
    const judge = new SkillJudge({ model: options.model });
    console.error(`Judging task ${options.taskId}...`);
    const score = await judge.judgeResult(task, result);

    const json = JSON.stringify(score, null, 2);
    if (options.outputFile) {
      await fs.writeFile(options.outputFile, json);
      console.error(`Score saved to: ${options.outputFile}`);
    } else {
      console.log(json);
    }
  });

program
  .command('report')
  .description('Generate report from results JSON (for Claude Code mode)')
  .requiredOption('-r, --results <path>', 'Path to results JSON file')
  .option('-o, --output <path>', 'Output markdown file')
  .option('--json <path>', 'Also output JSON report')
  .action(async (options: {
    results: string;
    output?: string;
    json?: string;
  }) => {
    // Read results file
    const resultsData = await fs.readFile(options.results, 'utf-8');
    const data = JSON.parse(resultsData) as {
      skillName: string;
      tasks: EvalTask[];
      results: TaskResult[];
      scores: JudgeScore[];
      metadata?: SkillMetadata;
    };

    const evaluation: SkillEvaluation = {
      skillName: data.skillName,
      tasks: data.tasks,
    };

    // Generate markdown report
    const report = await generateReport(
      evaluation,
      data.results,
      data.scores,
      options.output,
      data.metadata
    );

    if (!options.output) {
      console.log(report);
    }

    // Generate JSON report if requested
    if (options.json) {
      await generateJsonResults(
        evaluation,
        data.results,
        data.scores,
        options.json,
        data.metadata
      );
    }
  });

program.parse();
