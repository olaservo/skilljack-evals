/**
 * GitHub Actions job summary generation.
 *
 * Produces condensed markdown suitable for $GITHUB_STEP_SUMMARY.
 */

import * as fs from 'fs/promises';
import { formatDelta, formatCategory } from '../utils/format.js';
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
      const reason = (f.score.reasoning.slice(0, 80) + (f.score.reasoning.length > 80 ? '...' : '')).replace(/\|/g, '\\|');
      const taskId = f.task.id.replace(/\|/g, '\\|');
      lines.push(`| ${taskId} | ${cat} | ${reason} |`);
    }
    lines.push('');
  }

  // Human review feedback note
  if (report.humanFeedback && Object.keys(report.humanFeedback).length > 0) {
    const feedbackCount = Object.keys(report.humanFeedback).length;
    lines.push(`> :memo: Human review feedback provided for ${feedbackCount} task(s)`);
    lines.push('');
  }

  // Cross-iteration comparison section
  if (report.crossIterationComparison) {
    const c = report.crossIterationComparison;
    const sd = c.summaryDelta.delta;
    const arrow = (v: number) => v > 0.001 ? ':arrow_up:' : v < -0.001 ? ':arrow_down:' : '';
    lines.push('### Comparison vs. Previous');
    lines.push('');
    lines.push('| Metric | Delta | |');
    lines.push('|--------|-------|-|');
    lines.push(`| Discovery | ${formatDelta(sd.discoveryAccuracy * 100)}% | ${arrow(sd.discoveryAccuracy)} |`);
    lines.push(`| Adherence | ${formatDelta(sd.avgAdherence)} | ${arrow(sd.avgAdherence)} |`);
    lines.push(`| Output Quality | ${formatDelta(sd.avgOutputQuality)} | ${arrow(sd.avgOutputQuality)} |`);
    lines.push(`| Weighted Score | ${formatDelta(sd.avgWeightedScore)} | ${arrow(sd.avgWeightedScore)} |`);
    lines.push('');

    const regressions = c.taskDeltas.filter((t) => t.significantChange === 'regressed');
    const improvements = c.taskDeltas.filter((t) => t.significantChange === 'improved');
    if (regressions.length > 0) {
      lines.push(`:warning: **${regressions.length} task(s) regressed:** ${regressions.map((t) => t.taskId).join(', ')}`);
    }
    if (improvements.length > 0) {
      lines.push(`:sparkles: **${improvements.length} task(s) improved:** ${improvements.map((t) => t.taskId).join(', ')}`);
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
    const taskId = t.task.id.replace(/\|/g, '\\|');
    if (isMultiRun) {
      // Only check adherence and outputQuality against the threshold since they
      // use the 1-5 scale. Discovery (0/1) and weightedScore (0-1) cannot exceed 1.0.
      const varianceLabel = s.stddev
        ? (s.stddev.adherence > FLAKY_STDDEV_THRESHOLD || s.stddev.outputQuality > FLAKY_STDDEV_THRESHOLD ? ':warning: High' : 'Low')
        : 'N/A';
      lines.push(`| ${taskId} | ${(s.discovery * 100).toFixed(0)}% | ${s.adherence.toFixed(1)}/5 | ${s.outputQuality.toFixed(1)}/5 | ${s.weightedScore.toFixed(2)} | ${varianceLabel} | ${status} |`);
    } else {
      lines.push(`| ${taskId} | ${(s.discovery * 100).toFixed(0)}% | ${s.adherence.toFixed(1)}/5 | ${s.outputQuality.toFixed(1)}/5 | ${s.weightedScore.toFixed(2)} | ${status} |`);
    }
  }
  // Per-task checklist summaries
  const tasksWithChecklist = tasks.filter(
    (t) => (t.score.checklistResults ?? []).length > 0
  );
  if (tasksWithChecklist.length > 0) {
    lines.push('');
    for (const t of tasksWithChecklist) {
      const results = t.score.checklistResults ?? [];
      const passed = results.filter((cr) => cr.passed).length;
      lines.push(`**${t.task.id} checklist:** ${passed}/${results.length}`);
      for (const cr of results) {
        const safeItem = cr.item.replace(/\|/g, '\\|');
        const line = `- ${cr.passed ? 'PASS' : 'FAIL'}: ${safeItem}`;
        const safeEvidence = cr.evidence?.trim().replace(/[|_*`]/g, '\\$&');
        lines.push(!cr.passed && safeEvidence ? `${line} — ${safeEvidence}` : line);
      }
      lines.push('');
    }
  }

  lines.push('');
  lines.push('</details>');
  lines.push('');

  // Comparison section
  if (report.comparison) {
    const d = report.comparison.summary.delta;
    const ws = report.comparison.summary.withSkill;
    const bs = report.comparison.summary.withoutSkill;
    lines.push(`### Skill Impact (vs ${report.comparison.summary.baselineLabel})`);
    lines.push('');
    lines.push('| Metric | With Skill | Baseline | Delta |');
    lines.push('|--------|-----------|----------|-------|');
    lines.push(`| Discovery | ${(ws.discoveryAccuracy * 100).toFixed(0)}% | ${(bs.discoveryAccuracy * 100).toFixed(0)}% | **${formatDelta(d.discoveryAccuracyDelta * 100, 0)}%** |`);
    lines.push(`| Adherence | ${ws.avgAdherence.toFixed(1)}/5 | ${bs.avgAdherence.toFixed(1)}/5 | **${formatDelta(d.avgAdherenceDelta)}** |`);
    lines.push(`| Output Quality | ${ws.avgOutputQuality.toFixed(1)}/5 | ${bs.avgOutputQuality.toFixed(1)}/5 | **${formatDelta(d.avgOutputQualityDelta)}** |`);
    lines.push(`| Weighted Score | ${ws.avgWeightedScore.toFixed(2)} | ${bs.avgWeightedScore.toFixed(2)} | **${formatDelta(d.avgWeightedScoreDelta)}** |`);
    lines.push('');
  }

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

