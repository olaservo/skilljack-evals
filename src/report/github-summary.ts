/**
 * GitHub Actions job summary generation.
 *
 * Produces condensed markdown suitable for $GITHUB_STEP_SUMMARY.
 */

import * as fs from 'fs/promises';
import { formatDelta, formatCategory, formatTokens, pct, ARROW_DIRECTION_EPSILON } from '../utils/format.js';
import type { EvaluationReport } from '../types.js';
import { loadConfigSync, type EvalConfig } from '../config.js';
import { isFlaky } from '../scorer/aggregator.js';
import { evaluatePassFail, trialFlags } from './report.js';

/**
 * Generate a condensed summary for GitHub Actions.
 */
export function generateGitHubSummary(report: EvaluationReport, config?: EvalConfig): string {
  const resolvedConfig = config ?? loadConfigSync();
  const { summary, tasks } = report;
  const skillLift = report.comparison?.summary.delta.resolutionRateDelta;
  const { resolutionPassed, liftPassed } = evaluatePassFail(summary, resolvedConfig, skillLift);
  const lines: string[] = [];

  const icon = report.passed ? ':white_check_mark:' : ':x:';
  const runsLabel = summary.numRuns > 1 ? ` (${summary.numRuns} trials)` : '';
  lines.push(`## ${icon} Skill Evaluation: ${report.skillName}${runsLabel}`);
  lines.push('');

  // Summary table
  const ci = summary.resolutionCI;
  lines.push('| Metric | Value | Threshold | Status |');
  lines.push('|--------|-------|-----------|--------|');
  lines.push(`| Resolution Rate | ${(summary.resolutionRate * 100).toFixed(0)}% (CI ${(ci.low * 100).toFixed(0)}–${(ci.high * 100).toFixed(0)}%) | ${(resolvedConfig.resolutionThreshold * 100).toFixed(0)}% | ${resolutionPassed ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Pass@${summary.numRuns} | ${(summary.passAtK * 100).toFixed(0)}% | | |`);
  if (skillLift !== undefined) {
    const liftThresholdCell = resolvedConfig.liftThreshold !== undefined
      ? `${formatDelta(resolvedConfig.liftThreshold * 100, 0)}%`
      : '';
    const liftStatus = liftPassed === undefined ? '' : liftPassed ? 'PASS' : 'FAIL';
    lines.push(`| Skill Lift | ${formatDelta(skillLift * 100, 0)}% | ${liftThresholdCell} | ${liftStatus} |`);
  }
  if (summary.invocationRate !== undefined) {
    lines.push(`| Invocation Rate | ${(summary.invocationRate * 100).toFixed(0)}% | | |`);
  }
  lines.push(`| Duration | ${(summary.totalDurationMs / 1000).toFixed(1)}s | | |`);
  lines.push(`| Cost | $${summary.totalCostUsd.toFixed(4)} | | |`);
  lines.push(`| Tokens | ${formatTokens(summary.totalTokens)} | | |`);
  lines.push('');

  // Failures
  const failures = tasks.filter((t) => !t.score.passed);
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
    const arrow = (v: number) => v > ARROW_DIRECTION_EPSILON ? ':arrow_up:' : v < -ARROW_DIRECTION_EPSILON ? ':arrow_down:' : '';
    lines.push('### Comparison vs. Previous');
    lines.push('');
    lines.push('| Metric | Delta | |');
    lines.push('|--------|-------|-|');
    lines.push(`| Resolution Rate | ${formatDelta(sd.resolutionRate * 100)}% | ${arrow(sd.resolutionRate)} |`);
    lines.push(`| Pass@k | ${formatDelta(sd.passAtK * 100)}% | ${arrow(sd.passAtK)} |`);
    if (sd.skillLift !== undefined) {
      lines.push(`| Skill Lift | ${formatDelta(sd.skillLift * 100)}% | ${arrow(sd.skillLift)} |`);
    }
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
    lines.push('| Task | Passed | Reward | Invoked | Variance | Status |');
    lines.push('|------|--------|--------|---------|----------|--------|');
  } else {
    lines.push('| Task | Passed | Reward | Invoked | Status |');
    lines.push('|------|--------|--------|---------|--------|');
  }
  for (const t of tasks) {
    const s = t.score;
    const flags = trialFlags(s);
    const passedCell = `${flags.filter(Boolean).length}/${flags.length}`;
    const status = s.passed ? 'PASS' : 'FAIL';
    const invoked = s.invocation !== undefined ? `${(s.invocation * 100).toFixed(0)}%` : 'n/a';
    const taskId = t.task.id.replace(/\|/g, '\\|');
    if (isMultiRun) {
      const varianceLabel = s.stddev
        ? (isFlaky(s.stddev) ? ':warning: High' : 'Low')
        : 'N/A';
      lines.push(`| ${taskId} | ${passedCell} | ${s.reward.toFixed(2)} | ${invoked} | ${varianceLabel} | ${status} |`);
    } else {
      lines.push(`| ${taskId} | ${passedCell} | ${s.reward.toFixed(2)} | ${invoked} | ${status} |`);
    }
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');

  // Judge diagnostics (only when the judge ran) — never affect pass/fail.
  const judgedTasks = tasks.filter((t) => t.score.judge);
  if (judgedTasks.length > 0) {
    lines.push('### Diagnostics (LLM judge)');
    lines.push('');
    lines.push('| Task | Adherence | Output Quality |');
    lines.push('|------|-----------|----------------|');
    for (const t of judgedTasks) {
      const taskId = t.task.id.replace(/\|/g, '\\|');
      const adh = t.score.adherence !== undefined ? `${t.score.adherence.toFixed(1)}/5` : 'n/a';
      const out = t.score.outputQuality !== undefined ? `${t.score.outputQuality.toFixed(1)}/5` : 'n/a';
      lines.push(`| ${taskId} | ${adh} | ${out} |`);
    }
    lines.push('');

    // Per-task assertion summaries
    const tasksWithChecklist = judgedTasks.filter(
      (t) => (t.score.checklistResults ?? []).length > 0
    );
    for (const t of tasksWithChecklist) {
      const results = t.score.checklistResults ?? [];
      const passedCount = results.filter((cr) => cr.passed).length;
      lines.push(`**${t.task.id} assertions:** ${passedCount}/${results.length}`);
      for (const cr of results) {
        const safeItem = cr.item.replace(/\|/g, '\\|');
        const line = `- ${cr.passed ? 'PASS' : 'FAIL'}: ${safeItem}`;
        const safeEvidence = cr.evidence?.trim().replace(/[|_*`]/g, '\\$&');
        lines.push(!cr.passed && safeEvidence ? `${line} — ${safeEvidence}` : line);
      }
      lines.push('');
    }
  }

  // Comparison section (primary data first)
  if (report.comparison) {
    const d = report.comparison.summary.delta;
    const ws = report.comparison.summary.withSkill;
    const bs = report.comparison.summary.withoutSkill;
    lines.push(`### Skill Impact (vs ${report.comparison.summary.baselineLabel})`);
    lines.push('');
    lines.push('| Metric | With Skill | Baseline | Delta |');
    lines.push('|--------|-----------|----------|-------|');
    lines.push(`| Resolution Rate | ${(ws.resolutionRate * 100).toFixed(0)}% | ${(bs.resolutionRate * 100).toFixed(0)}% | **${formatDelta(d.resolutionRateDelta * 100, 0)}%** |`);
    lines.push(`| Pass@k | ${(ws.passAtK * 100).toFixed(0)}% | ${(bs.passAtK * 100).toFixed(0)}% | **${formatDelta(d.passAtKDelta * 100, 0)}%** |`);
    if (d.totalTokensDelta !== undefined) {
      lines.push(`| Tokens | ${formatTokens(ws.totalTokens)} | ${formatTokens(bs.totalTokens)} | **${formatDelta(d.totalTokensDelta, 0)}** |`);
    }
    lines.push('');
  }

  // Blind comparison section (cross-validation, shown after primary comparison)
  if (report.blindComparison) {
    const ba = report.blindComparison.aggregate;
    const evaluated = report.blindComparison.tasks.length - ba.failedCount;
    lines.push('### Blind A/B Comparison');
    lines.push('');
    lines.push('| Preference | Count | % |');
    lines.push('|------------|-------|---|');
    lines.push(`| With-skill | ${ba.withSkillPreferred} | ${pct(ba.withSkillPreferred, evaluated)}% |`);
    lines.push(`| Without-skill | ${ba.withoutSkillPreferred} | ${pct(ba.withoutSkillPreferred, evaluated)}% |`);
    lines.push(`| Tie | ${ba.ties} | ${pct(ba.ties, evaluated)}% |`);
    lines.push('');
    if (ba.biasSignalCount > 0) {
      lines.push(`:warning: **${ba.biasSignalCount} bias signal(s):** blind comparison disagrees with standard scoring`);
      lines.push('');
    }
    if (ba.failedCount > 0) {
      lines.push(`:warning: **${ba.failedCount} blind judge call(s) failed** — excluded from preference counts`);
      lines.push('');
    }
  }

  if (!report.passed && report.failureReasons.length > 0) {
    lines.push(`**Failure reasons:** ${report.failureReasons.join('; ')}`);
  }

  return lines.join('\n');
}

/**
 * Write summary to $GITHUB_STEP_SUMMARY if available.
 */
export async function writeGitHubSummary(report: EvaluationReport, config?: EvalConfig): Promise<boolean> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return false;

  const summary = generateGitHubSummary(report, config);
  await fs.appendFile(summaryPath, summary + '\n');
  return true;
}
