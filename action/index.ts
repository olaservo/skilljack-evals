/**
 * GitHub Action entry point for skill evaluation.
 *
 * Reads inputs from the action.yml, runs the evaluation pipeline,
 * and sets outputs + job summary.
 */

import * as core from '@actions/core';
import { runPipeline } from '../src/pipeline.js';
import { VALID_RUNNER_TYPES } from '../src/config.js';
import type { EvalConfig, RunnerType } from '../src/config.js';

async function run(): Promise<void> {
  try {
    // Read inputs
    const tasks = core.getInput('tasks', { required: true });
    const runnerInput = core.getInput('runner') || 'claude-sdk';
    if (!VALID_RUNNER_TYPES.includes(runnerInput as RunnerType)) {
      core.setFailed(`Invalid runner "${runnerInput}". Valid options: ${VALID_RUNNER_TYPES.join(', ')}`);
      return;
    }
    const runner = runnerInput as RunnerType;
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
    const generateFeedbackPath = core.getInput('generate-feedback') || undefined;
    const feedbackPath = core.getInput('feedback') || undefined;
    const compare = core.getInput('compare') === 'true';
    const compareSkillPath = core.getInput('compare-skill') || undefined;

    // Handle API keys
    const anthropicKey = core.getInput('anthropic-api-key') || process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      process.env.ANTHROPIC_API_KEY = anthropicKey;
      core.setSecret(anthropicKey);
    }

    const openaiKey = core.getInput('openai-api-key') || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      process.env.OPENAI_API_KEY = openaiKey;
      core.setSecret(openaiKey);
    }

    const googleKey = core.getInput('google-api-key') || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (googleKey) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = googleKey;
      core.setSecret(googleKey);
    }

    const openrouterKey = core.getInput('openrouter-api-key') || process.env.OPENROUTER_API_KEY;
    if (openrouterKey) {
      process.env.OPENROUTER_API_KEY = openrouterKey;
      core.setSecret(openrouterKey);
    }

    // Build config overrides
    const configOverrides: Partial<EvalConfig> = {
      runnerType: runner,
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
      generateFeedbackPath,
      feedbackPath,
      compare: compare || !!compareSkillPath,
      compareSkillPath,
    });

    // Set outputs
    core.setOutput('passed', String(result.passed));
    core.setOutput('discovery-rate', String(result.report.summary.discoveryAccuracy));
    core.setOutput('avg-score', String(result.report.summary.avgWeightedScore));
    core.setOutput('report-path', result.reportPath || '');
    core.setOutput('json-path', result.jsonPath || '');
    core.setOutput('feedback-template-path', result.feedbackTemplatePath || '');

    // Set comparison outputs
    if (result.comparison) {
      core.setOutput('adherence-delta', String(result.comparison.summary.delta.avgAdherenceDelta));
      core.setOutput('output-delta', String(result.comparison.summary.delta.avgOutputQualityDelta));
      core.setOutput('score-delta', String(result.comparison.summary.delta.avgWeightedScoreDelta));
    }

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
