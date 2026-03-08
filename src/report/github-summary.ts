/**
 * GitHub Actions job summary generation.
 *
 * Produces condensed markdown suitable for $GITHUB_STEP_SUMMARY.
 */

import * as fs from 'fs/promises';
import type {
  EvaluationReport,
  EvaluationSummary,
  FailureBreakdown,
  CombinedScore,
} from '../types.js';
import { FLAKY_STDDEV_THRESHOLD } from '../scorer/aggregator.js';

/**
 * Generate a condensed summary for GitHub Actions.
 */
export function generateGitHubSummary(report: EvaluationReport): string {
  const { summary, failureBreakdown, tasks } = report;
  const lines: string[] = [];

  const icon = report.passed ? ':white_check_mark:' : ':x:';
  const runsLabel = summary.numRuns > 1 ? ` (${summary.numRuns} runs)` : '';
  lines.push(`## ${icon} Skill Evaluation: ${report.skillName}${runsLabel}`);
  lines.push('');

  // Summary table
  lines.push('| Metric | Value | Status |');
  lines.push('|--------|-------|--------|');
  lines.push(`| Discovery Rate | ${(summary.discoveryAccuracy * 100).toFixed(0)}%${summary.stddev ? ` \u00B1 ${(summary.stddev.discovery * 100).toFixed(0)}%` : ''} (${Math.round(summary.discoveryAccuracy * summary.totalTasks)}/${summary.totalTasks}) | ${summary.discoveryAccuracy >= 0.8 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Avg Adherence | ${summary.avgAdherence.toFixed(1)}/5${summary.stddev ? ` \u00B1 ${summary.stddev.adherence.toFixed(1)}` : ''} | ${summary.avgAdherence >= 4.0 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Avg Output Quality | ${summary.avgOutputQuality.toFixed(1)}/5${summary.stddev ? ` \u00B1 ${summary.stddev.outputQuality.toFixed(1)}` : ''} | ${summary.avgOutputQuality >= 4.0 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Weighted Score | ${summary.avgWeightedScore.toFixed(2)}${summary.stddev ? ` \u00B1 ${summary.stddev.weightedScore.toFixed(2)}` : ''} | |`);
  lines.push(`| Duration | ${(summary.totalDurationMs / 1000).toFixed(1)}s | |`);
  lines.push(`| Cost | $${summary.totalCostUsd.toFixed(4)} | |`);
  lines.push('');

  // Failures
  const failures = tasks.filter((t) => t.score.failureCategory !== 'none');
  if (failures.length > 0) {
    lines.push(`### Failures (${failures.length})`);
    lines.push('');
    lines.push('| Task | Category | Details |');
    lines.push('|------|----------|---------|');
    for (const f of failures) {
      const cat = formatCategory(f.score.failureCategory);
      const reason = f.score.reasoning.slice(0, 80) + (f.score.reasoning.length > 80 ? '...' : '');
      lines.push(`| ${f.task.id} | ${cat} | ${reason} |`);
    }
    lines.push('');
  }

  // Per-task details in collapsible
  const isMultiRun = summary.numRuns > 1;
  lines.push('<details><summary>All task results</summary>');
  lines.push('');
  if (isMultiRun) {
    lines.push('| Task | Discovery | Adherence | Output | Weighted | Variance | Status |');
    lines.push('|------|-----------|-----------|--------|----------|----------|--------|');
  } else {
    lines.push('| Task | Discovery | Adherence | Output | Weighted | Status |');
    lines.push('|------|-----------|-----------|--------|----------|--------|');
  }
  for (const t of tasks) {
    const s = t.score;
    const status = s.failureCategory === 'none' ? 'PASS' : 'FAIL';
    if (isMultiRun) {
      // Only check adherence and outputQuality against the threshold since they
      // use the 1-5 scale. Discovery (0/1) and weightedScore (0-1) cannot exceed 1.0.
      const varianceLabel = s.stddev
        ? (s.stddev.adherence > FLAKY_STDDEV_THRESHOLD || s.stddev.outputQuality > FLAKY_STDDEV_THRESHOLD ? ':warning: High' : 'Low')
        : 'N/A';
      lines.push(`| ${t.task.id} | ${(s.discovery * 100).toFixed(0)}% | ${s.adherence.toFixed(1)}/5 | ${s.outputQuality.toFixed(1)}/5 | ${s.weightedScore.toFixed(2)} | ${varianceLabel} | ${status} |`);
    } else {
      lines.push(`| ${t.task.id} | ${s.discovery} | ${s.adherence}/5 | ${s.outputQuality}/5 | ${s.weightedScore.toFixed(2)} | ${status} |`);
    }
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');

  if (!report.passed && report.failureReasons.length > 0) {
    lines.push(`**Failure reasons:** ${report.failureReasons.join('; ')}`);
  }

  return lines.join('\n');
}

/**
 * Write summary to $GITHUB_STEP_SUMMARY if available.
 */
export async function writeGitHubSummary(report: EvaluationReport): Promise<boolean> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return false;

  const summary = generateGitHubSummary(report);
  await fs.appendFile(summaryPath, summary + '\n');
  return true;
}

function formatCategory(cat: string): string {
  if (cat === 'none') return 'No Failure';
  return cat
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
