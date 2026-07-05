/**
 * GitHub Action entry point for skill evaluation.
 *
 * Reads inputs from the action.yml, runs the evaluation pipeline,
 * and sets outputs + job summary. Gating reads the reward-authoritative
 * metrics from the run summary.
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
    const thresholdResolution = parseFloat(core.getInput('threshold-resolution') || '0.8');
    const thresholdLiftRaw = core.getInput('threshold-lift');
    const thresholdLift = thresholdLiftRaw ? parseFloat(thresholdLiftRaw) : undefined;
    if (core.getInput('threshold-discovery') || core.getInput('threshold-score')) {
      core.warning('threshold-discovery/threshold-score inputs were removed in v2 and are IGNORED — use threshold-resolution / threshold-lift');
    }
    const timeout = parseInt(core.getInput('timeout') || '300000', 10);
    const concurrencyRaw = core.getInput('concurrency') || '1';
    const concurrency = Number(concurrencyRaw);
    if (!Number.isInteger(concurrency) || concurrency < 0) {
      core.setFailed('concurrency input must be a non-negative integer');
      return;
    }
    const tasksFilter = core.getInput('tasks-filter') || undefined;
    const skillsDir = core.getInput('skills-dir') || undefined;
    const cwd = core.getInput('working-directory') || process.cwd();
    // baseline: 'false' disables the paired condition; anything else keeps the
    // default behavior (baseline on when tasks have skills resolved).
    const baseline = core.getInput('baseline') === 'false' ? false : undefined;
    const judge = core.getInput('judge') === 'true' ? true : undefined;
    const numRuns = parseInt(core.getInput('runs') || '3', 10);
    const generateFeedbackPath = core.getInput('generate-feedback') || undefined;
    const feedbackPath = core.getInput('feedback') || undefined;
    const compareSkillPath = core.getInput('compare-skill') || undefined;
    const compareLabel = core.getInput('compare-label') || undefined;
    const compareResultsPath = core.getInput('compare-results') || undefined;
    const blindCompare = core.getInput('blind-compare') === 'true';

    // Handle API keys
    const anthropicKey = core.getInput('anthropic-api-key') || process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      process.env.ANTHROPIC_API_KEY = anthropicKey;
      core.setSecret(anthropicKey);
    }

    // Build config overrides
    const configOverrides: Partial<EvalConfig> = {
      runnerType: runner,
      defaultAgentModel: model,
      defaultJudgeModel: judgeModel,
      resolutionThreshold: thresholdResolution,
      liftThreshold: thresholdLift,
      taskTimeoutMs: timeout,
      concurrency,
      githubSummary: true,
    };

    // Run pipeline
    const result = await runPipeline({
      tasksPath: tasks,
      configPath,
      configOverrides,
      cwd,
      skillsDir,
      taskFilter: tasksFilter,
      judge,
      baseline,
      numRuns,
      generateFeedbackPath,
      feedbackPath,
      compareSkillPath,
      compareLabel,
      compareResultsPath,
      blindCompare,
    });

    // Set outputs (reward-authoritative metrics from the run summary)
    const metrics = result.runSummary.metrics;
    core.setOutput('passed', String(result.passed));
    core.setOutput('resolution-rate', String(metrics.resolutionRate));
    core.setOutput('pass-at-k', String(metrics.passAtK));
    if (metrics.skillLift !== undefined) {
      core.setOutput('skill-lift', String(metrics.skillLift));
    }
    if (metrics.skillInvocationRate !== undefined) {
      core.setOutput('invocation-rate', String(metrics.skillInvocationRate));
    }
    core.setOutput('report-path', result.reportPath || '');
    core.setOutput('json-path', result.jsonPath || '');
    core.setOutput('summary-json-path', result.summaryJsonPath || '');
    core.setOutput('feedback-template-path', result.feedbackTemplatePath || '');
    core.setOutput('has-regressions', 'false');

    // Set blind comparison outputs (blind-compare mode)
    if (result.blindComparison) {
      core.setOutput('blind-with-skill-preferred', String(result.blindComparison.aggregate.withSkillPreferred));
      core.setOutput('blind-without-skill-preferred', String(result.blindComparison.aggregate.withoutSkillPreferred));
      core.setOutput('blind-bias-signals', String(result.blindComparison.aggregate.biasSignalCount));
    }

    // Set cross-iteration comparison outputs (compare-results mode)
    if (result.crossIterationComparison) {
      const hasRegressions = result.crossIterationComparison.taskDeltas.some((t) => t.significantChange === 'regressed');
      core.setOutput('has-regressions', String(hasRegressions));
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
