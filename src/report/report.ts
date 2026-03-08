/**
 * Report generation for skill evaluation results.
 *
 * Generates markdown and JSON reports from combined evaluation scores.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  SkillEvaluation,
  TaskResult,
  CombinedScore,
  EvaluationReport,
  EvaluationSummary,
  FailureBreakdown,
  FailureCategory,
  ReportMetadata,
} from '../types.js';
import { loadConfigSync } from '../config.js';
import { computeStddev, FLAKY_STDDEV_THRESHOLD } from '../scorer/aggregator.js';

/**
 * Generate a markdown report from evaluation results.
 */
export async function generateReport(
  evaluation: SkillEvaluation,
  results: TaskResult[],
  scores: CombinedScore[],
  outputPath?: string,
  metadata?: ReportMetadata,
  numRuns = 1,
  runDetails?: Array<{ result: TaskResult; score: CombinedScore }>[]
): Promise<string> {
  const config = loadConfigSync();
  const totalTasks = evaluation.tasks.length;
  const summary = computeSummary(results, scores, numRuns);
  const failureBreakdown = computeFailureBreakdown(scores);

  // Determine pass/fail
  const discoveryPassed = summary.discoveryAccuracy >= config.discoveryThreshold;
  const scorePassed = summary.avgAdherence >= config.scoreThreshold && summary.avgOutputQuality >= config.scoreThreshold;
  const passed = discoveryPassed && scorePassed;

  // Build metadata section
  let metaSection = '';
  if (metadata) {
    const metaLines = [`**Skill Path:** \`${metadata.skillPath}\``];
    if (metadata.gitCommit) {
      metaLines.push(`**Git:** ${metadata.gitBranch}@${metadata.gitCommit}`);
    }
    if (metadata.version) metaLines.push(`**Version:** ${metadata.version}`);
    metaLines.push(`**Agent Model:** ${metadata.agentModel}`);
    metaLines.push(`**Judge Model:** ${metadata.judgeModel}`);
    metaSection = metaLines.join('\n') + '\n';
  }

  // Build report
  const runsLine = numRuns > 1 ? `**Runs per Task:** ${numRuns}\n` : '';

  let report = `# Skill Evaluation Report: ${evaluation.skillName}

**Generated:** ${new Date().toISOString()}
**Total Tasks:** ${totalTasks}
${runsLine}**Result:** ${passed ? 'PASS' : 'FAIL'}
${metaSection}
---

## Summary

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| **Discovery Accuracy** | ${(summary.discoveryAccuracy * 100).toFixed(1)}%${summary.stddev ? ` \u00B1 ${(summary.stddev.discovery * 100).toFixed(1)}%` : ''} | ${(config.discoveryThreshold * 100).toFixed(0)}% | ${discoveryPassed ? 'PASS' : 'FAIL'} |
| **Avg Adherence Score** | ${summary.avgAdherence.toFixed(2)}/5.0${summary.stddev ? ` \u00B1 ${summary.stddev.adherence.toFixed(2)}` : ''} | ${config.scoreThreshold.toFixed(1)} | ${summary.avgAdherence >= config.scoreThreshold ? 'PASS' : 'FAIL'} |
| **Avg Output Quality** | ${summary.avgOutputQuality.toFixed(2)}/5.0${summary.stddev ? ` \u00B1 ${summary.stddev.outputQuality.toFixed(2)}` : ''} | ${config.scoreThreshold.toFixed(1)} | ${summary.avgOutputQuality >= config.scoreThreshold ? 'PASS' : 'FAIL'} |
| **Avg Weighted Score** | ${summary.avgWeightedScore.toFixed(2)}${summary.stddev ? ` \u00B1 ${summary.stddev.weightedScore.toFixed(2)}` : ''} | | |
| **Total Duration** | ${(summary.totalDurationMs / 1000).toFixed(1)}s | | |
| **Total Cost** | $${summary.totalCostUsd.toFixed(4)} | | |

## Failure Analysis

| Category | Count | Percentage |
|----------|-------|------------|
`;

  for (const fb of failureBreakdown) {
    const displayCat = fb.category === 'none' ? 'No Failure' : formatCategory(fb.category);
    report += `| ${displayCat} | ${fb.count} | ${fb.percentage.toFixed(1)}% |\n`;
  }

  report += `\n---\n\n## Task Details\n\n`;

  for (let i = 0; i < evaluation.tasks.length; i++) {
    const task = evaluation.tasks[i];
    const result = results[i];
    const score = scores[i];

    const loadedSkills = result.skillLoads.length > 0
      ? result.skillLoads.map((s) => `\`${s}\``).join(', ')
      : 'None';

    report += `### Task ${i + 1}: ${task.id}

**Prompt:** ${task.prompt}

**Expected Skill:** \`${task.expectedSkillLoad}\`
**Loaded Skills:** ${loadedSkills}

#### Scores

| Dimension | Score | Status |
|-----------|-------|--------|
| Discovery | ${Math.round(score.discovery)}${score.stddev ? ` \u00B1 ${score.stddev.discovery.toFixed(2)}` : ''} | ${score.discovery >= 1 ? 'PASS' : 'FAIL'} |
| Adherence | ${score.adherence.toFixed(1)}/5${score.stddev ? ` \u00B1 ${score.stddev.adherence.toFixed(1)}` : ''} | ${score.adherence >= 4 ? 'PASS' : 'FAIL'} |
| Output Quality | ${score.outputQuality.toFixed(1)}/5${score.stddev ? ` \u00B1 ${score.stddev.outputQuality.toFixed(1)}` : ''} | ${score.outputQuality >= 4 ? 'PASS' : 'FAIL'} |
| **Weighted** | **${score.weightedScore.toFixed(2)}${score.stddev ? ` \u00B1 ${score.stddev.weightedScore.toFixed(2)}` : ''}** | |
${score.stddev && (score.stddev.adherence > FLAKY_STDDEV_THRESHOLD || score.stddev.outputQuality > FLAKY_STDDEV_THRESHOLD) ? `\n> **Warning: Potentially Flaky** \u2014 High variance across runs (adherence \u03C3=${score.stddev.adherence.toFixed(2)}, output \u03C3=${score.stddev.outputQuality.toFixed(2)})\n` : ''}
**Failure Category:** ${formatCategory(score.failureCategory)}
`;

    // Show deterministic results if available
    if (score.deterministic) {
      report += `\n**Deterministic Check:** ${score.deterministic.passed ? 'PASS' : 'FAIL'}\n`;
      for (const detail of score.deterministic.details) {
        report += `- ${detail}\n`;
      }
    }

    report += `\n**Reasoning:** ${score.reasoning || 'No reasoning provided'}

<details>
<summary>Agent Output (click to expand)</summary>

\`\`\`
${result.output.slice(0, config.reportOutputTruncation) || '(no output)'}
\`\`\`

</details>

**Metrics:** Duration: ${(result.durationMs / 1000).toFixed(1)}s | Turns: ${result.numTurns} | Cost: $${result.costUsd.toFixed(4)}
`;

    // Per-run breakdown
    if (runDetails && runDetails[i] && runDetails[i].length > 1) {
      report += `
<details>
<summary>Per-run breakdown (${runDetails[i].length} runs)</summary>

| Run | Discovery | Adherence | Output | Weighted | Skills Loaded |
|-----|-----------|-----------|--------|----------|---------------|
`;
      for (let r = 0; r < runDetails[i].length; r++) {
        const rd = runDetails[i][r];
        const skills = rd.result.skillLoads.length > 0 ? rd.result.skillLoads.join(', ') : 'none';
        report += `| ${r + 1} | ${rd.score.discovery} | ${rd.score.adherence}/5 | ${rd.score.outputQuality}/5 | ${rd.score.weightedScore.toFixed(2)} | ${skills} |\n`;
      }
      report += `\n</details>\n`;
    }

    report += `\n---\n\n`;
  }

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, report);
    console.log(`Report saved to: ${outputPath}`);
  }

  return report;
}

/**
 * Generate JSON report for programmatic analysis.
 */
export async function generateJsonResults(
  evaluation: SkillEvaluation,
  results: TaskResult[],
  scores: CombinedScore[],
  outputPath?: string,
  metadata?: ReportMetadata,
  numRuns = 1,
  runDetails?: Array<{ result: TaskResult; score: CombinedScore }>[]
): Promise<EvaluationReport> {
  const config = loadConfigSync();
  const summary = computeSummary(results, scores, numRuns);
  const failureBreakdown = computeFailureBreakdown(scores);

  const discoveryPassed = summary.discoveryAccuracy >= config.discoveryThreshold;
  const scorePassed = summary.avgAdherence >= config.scoreThreshold && summary.avgOutputQuality >= config.scoreThreshold;
  const passed = discoveryPassed && scorePassed;

  const failureReasons: string[] = [];
  if (!discoveryPassed) {
    failureReasons.push(
      `Discovery rate ${(summary.discoveryAccuracy * 100).toFixed(1)}% below threshold ${(config.discoveryThreshold * 100).toFixed(0)}%`
    );
  }
  if (summary.avgAdherence < config.scoreThreshold) {
    failureReasons.push(
      `Avg adherence ${summary.avgAdherence.toFixed(2)} below threshold ${config.scoreThreshold}`
    );
  }
  if (summary.avgOutputQuality < config.scoreThreshold) {
    failureReasons.push(
      `Avg output quality ${summary.avgOutputQuality.toFixed(2)} below threshold ${config.scoreThreshold}`
    );
  }

  const report: EvaluationReport = {
    skillName: evaluation.skillName,
    timestamp: new Date().toISOString(),
    passed,
    failureReasons,
    metadata: metadata ? {
      skillPath: metadata.skillPath,
      gitCommit: metadata.gitCommit,
      gitBranch: metadata.gitBranch,
      version: metadata.version,
      runnerType: metadata.runnerType,
      agentModel: metadata.agentModel,
      judgeModel: metadata.judgeModel,
    } : undefined,
    summary,
    failureBreakdown,
    tasks: evaluation.tasks.map((task, i) => ({
      task,
      result: results[i],
      score: scores[i],
      runDetails: runDetails?.[i],
    })),
  };

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`JSON results saved to: ${outputPath}`);
  }

  return report;
}

/**
 * Compute summary statistics from combined scores.
 */
export function computeSummary(
  results: TaskResult[],
  scores: CombinedScore[],
  numRuns = 1
): EvaluationSummary {
  const totalTasks = scores.length;

  // With multi-run, discovery is a float (0-1) per task representing the rate.
  // Average across tasks to get overall discovery accuracy.
  const avgDiscovery = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.discovery, 0) / totalTasks
    : 0;

  const avgAdherence = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.adherence, 0) / totalTasks
    : 0;
  const avgOutputQuality = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.outputQuality, 0) / totalTasks
    : 0;
  const avgWeightedScore = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.weightedScore, 0) / totalTasks
    : 0;

  const summary: EvaluationSummary = {
    totalTasks,
    numRuns,
    discoveryAccuracy: avgDiscovery,
    avgAdherence,
    avgOutputQuality,
    avgWeightedScore,
    totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
  };

  // Compute summary-level stddev across per-task mean scores when multi-run.
  // Note: this measures variance across tasks (how spread are per-task averages),
  // whereas task-level stddev measures variance across runs for a single task.
  // With a single task, all stddev values will be 0 (no cross-task spread).
  if (numRuns >= 2) {
    summary.stddev = {
      discovery: computeStddev(scores.map(s => s.discovery), avgDiscovery),
      adherence: computeStddev(scores.map(s => s.adherence), avgAdherence),
      outputQuality: computeStddev(scores.map(s => s.outputQuality), avgOutputQuality),
      weightedScore: computeStddev(scores.map(s => s.weightedScore), avgWeightedScore),
    };
  }

  return summary;
}

/**
 * Compute failure category breakdown.
 */
export function computeFailureBreakdown(scores: CombinedScore[]): FailureBreakdown[] {
  const counts = new Map<string, number>();
  for (const score of scores) {
    const cat = score.failureCategory || 'none';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }

  const total = scores.length;
  return Array.from(counts.entries())
    .map(([category, count]) => ({
      category: category as FailureCategory,
      count,
      percentage: total > 0 ? (count / total) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

function formatCategory(cat: string): string {
  if (cat === 'none') return 'No Failure';
  return cat
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
