/**
 * GitHub Action entry point for skill evaluation.
 *
 * Reads inputs from the action.yml, runs the evaluation pipeline,
 * and sets outputs + job summary.
 */

import * as core from '@actions/core';
import { runPipeline } from '../src/pipeline.js';
import type { EvalConfig } from '../src/config.js';

async function run(): Promise<void> {
  try {
    // Read inputs
    const tasks = core.getInput('tasks', { required: true });
    const model = core.getInput('model') || 'sonnet';
    const judgeModel = core.getInput('judge-model') || 'haiku';
    const configPath = core.getInput('config') || undefined;
    const thresholdDiscovery = parseFloat(core.getInput('threshold-discovery') || '0.8');
    const thresholdScore = parseFloat(core.getInput('threshold-score') || '4.0');
    const timeout = parseInt(core.getInput('timeout') || '300000', 10);
    const tasksFilter = core.getInput('tasks-filter') || undefined;
    const skillsDir = core.getInput('skills-dir') || undefined;
    const cwd = core.getInput('working-directory') || process.cwd();
    const noJudge = core.getInput('no-judge') === 'true';
    const noDeterministic = core.getInput('no-deterministic') === 'true';
    const numRuns = parseInt(core.getInput('runs') || '3', 10);

    // Handle API key
    const apiKey = core.getInput('anthropic-api-key') || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      process.env.ANTHROPIC_API_KEY = apiKey;
      core.setSecret(apiKey);
    }

    // Build config overrides
    const configOverrides: Partial<EvalConfig> = {
      defaultAgentModel: model,
      defaultJudgeModel: judgeModel,
      discoveryThreshold: thresholdDiscovery,
      scoreThreshold: thresholdScore,
      taskTimeoutMs: timeout,
      githubSummary: true,
    };

    // Run pipeline
    const result = await runPipeline({
      tasksFile: tasks,
      configPath,
      configOverrides,
      cwd,
      skillsDir,
      taskFilter: tasksFilter,
      noJudge,
      noDeterministic,
      numRuns,
    });

    // Set outputs
    core.setOutput('passed', String(result.passed));
    core.setOutput('discovery-rate', String(result.report.summary.discoveryAccuracy));
    core.setOutput('avg-score', String(result.report.summary.avgWeightedScore));
    core.setOutput('report-path', result.reportPath || '');
    core.setOutput('json-path', result.jsonPath || '');

    // Write job summary
    await core.summary.addRaw(result.markdownSummary).write();

    // Set exit status
    if (!result.passed) {
      core.setFailed(
        `Evaluation below thresholds: ${result.failureReasons.join(', ')}`
      );
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
