/**
 * Cross-iteration comparison for skill evaluation results.
 *
 * Loads a previous JSON result file, matches tasks by ID,
 * computes per-task deltas, and formats comparison output.
 */

import * as fs from 'fs/promises';
import type {
  EvaluationReport,
  EvaluationSummary,
  CombinedScore,
  ComparisonResult,
  TaskDelta,
  SummaryDelta,
  ScoreSnapshot,
  SummarySnapshot,
} from '../types.js';
import { formatDelta, ARROW_DIRECTION_EPSILON } from '../utils/format.js';

export const SIGNIFICANCE_THRESHOLD_ADHERENCE = 1;
export const SIGNIFICANCE_THRESHOLD_WEIGHTED = 0.15;

/**
 * Load and validate a previous evaluation report from a JSON file.
 */
export async function loadPreviousReport(filePath: string): Promise<EvaluationReport> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Comparison file not found: ${filePath}`);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse comparison file as JSON: ${(err as Error).message}`);
  }

  const report = data as Record<string, unknown>;

  if (typeof report.skillName !== 'string') {
    throw new Error('Comparison file is not a valid EvaluationReport: missing "skillName"');
  }
  if (!report.summary || typeof report.summary !== 'object') {
    throw new Error('Comparison file is not a valid EvaluationReport: missing "summary"');
  }
  const summary = report.summary as Record<string, unknown>;
  if (
    typeof summary.discoveryAccuracy !== 'number' ||
    typeof summary.avgAdherence !== 'number' ||
    typeof summary.avgOutputQuality !== 'number' ||
    typeof summary.avgWeightedScore !== 'number'
  ) {
    throw new Error('Comparison file summary is missing required numeric fields');
  }
  if (!Array.isArray(report.tasks)) {
    throw new Error('Comparison file is not a valid EvaluationReport: missing "tasks" array');
  }

  for (const task of report.tasks) {
    if (!task.score || typeof task.score.taskId !== 'string') {
      throw new Error('Comparison file has task entries without score.taskId');
    }
    if (
      typeof task.score.weightedScore !== 'number' ||
      typeof task.score.discovery !== 'number' ||
      typeof task.score.adherence !== 'number' ||
      typeof task.score.outputQuality !== 'number'
    ) {
      throw new Error(`Comparison file task "${task.score.taskId}" is missing numeric score fields`);
    }
  }

  return data as EvaluationReport;
}

/**
 * Compare current scores against a previous evaluation report.
 */
export function compareResults(
  currentScores: CombinedScore[],
  currentSummary: EvaluationSummary,
  previous: EvaluationReport
): ComparisonResult {
  // Build lookup from previous tasks
  const previousMap = new Map<string, ScoreSnapshot>();
  for (const entry of previous.tasks) {
    const s = entry.score;
    previousMap.set(s.taskId, {
      discovery: s.discovery,
      adherence: s.adherence,
      outputQuality: s.outputQuality,
      weightedScore: s.weightedScore,
    });
  }

  // Build lookup of current task IDs
  const currentIds = new Set(currentScores.map((s) => s.taskId));

  // Compute per-task deltas
  const taskDeltas: TaskDelta[] = [];
  const tasksOnlyInCurrent: string[] = [];

  for (const score of currentScores) {
    const prev = previousMap.get(score.taskId);
    if (!prev) {
      tasksOnlyInCurrent.push(score.taskId);
      continue;
    }

    const current: ScoreSnapshot = {
      discovery: score.discovery,
      adherence: score.adherence,
      outputQuality: score.outputQuality,
      weightedScore: score.weightedScore,
    };

    const round3 = (v: number) => Math.round(v * 1000) / 1000;
    const delta: ScoreSnapshot = {
      discovery: round3(current.discovery - prev.discovery),
      adherence: round3(current.adherence - prev.adherence),
      outputQuality: round3(current.outputQuality - prev.outputQuality),
      weightedScore: round3(current.weightedScore - prev.weightedScore),
    };

    const roundedWeighted = Math.round(delta.weightedScore * 1000) / 1000;
    const isSignificant =
      Math.abs(delta.adherence) >= SIGNIFICANCE_THRESHOLD_ADHERENCE ||
      Math.abs(roundedWeighted) >= SIGNIFICANCE_THRESHOLD_WEIGHTED;

    let significantChange: TaskDelta['significantChange'] = 'unchanged';
    if (isSignificant) {
      // Use weighted score as primary signal, fall back to adherence for tie-breaking
      if (delta.weightedScore > 0 || (delta.weightedScore === 0 && delta.adherence > 0)) {
        significantChange = 'improved';
      } else if (delta.weightedScore < 0 || (delta.weightedScore === 0 && delta.adherence < 0)) {
        significantChange = 'regressed';
      }
      // else stays 'unchanged' when both deltas are exactly zero
    }

    taskDeltas.push({
      taskId: score.taskId,
      previous: prev,
      current,
      delta,
      significantChange,
    });
  }

  // Find tasks only in previous
  const tasksOnlyInPrevious: string[] = [];
  for (const entry of previous.tasks) {
    if (!currentIds.has(entry.score.taskId)) {
      tasksOnlyInPrevious.push(entry.score.taskId);
    }
  }

  // Compute summary delta
  const prevSummary: SummarySnapshot = {
    discoveryAccuracy: previous.summary.discoveryAccuracy,
    avgAdherence: previous.summary.avgAdherence,
    avgOutputQuality: previous.summary.avgOutputQuality,
    avgWeightedScore: previous.summary.avgWeightedScore,
  };

  const currSummary: SummarySnapshot = {
    discoveryAccuracy: currentSummary.discoveryAccuracy,
    avgAdherence: currentSummary.avgAdherence,
    avgOutputQuality: currentSummary.avgOutputQuality,
    avgWeightedScore: currentSummary.avgWeightedScore,
  };

  const summaryDelta: SummaryDelta = {
    previous: prevSummary,
    current: currSummary,
    delta: {
      discoveryAccuracy: Math.round((currSummary.discoveryAccuracy - prevSummary.discoveryAccuracy) * 1000) / 1000,
      avgAdherence: Math.round((currSummary.avgAdherence - prevSummary.avgAdherence) * 1000) / 1000,
      avgOutputQuality: Math.round((currSummary.avgOutputQuality - prevSummary.avgOutputQuality) * 1000) / 1000,
      avgWeightedScore: Math.round((currSummary.avgWeightedScore - prevSummary.avgWeightedScore) * 1000) / 1000,
    },
  };

  return {
    previousTimestamp: previous.timestamp,
    previousSkillName: previous.skillName,
    summaryDelta,
    taskDeltas,
    tasksOnlyInCurrent,
    tasksOnlyInPrevious,
  };
}

/**
 * Format comparison data as a markdown section for the report.
 */
export function formatComparisonMarkdown(comparison: ComparisonResult): string {
  const lines: string[] = [];
  const d = comparison.summaryDelta;

  lines.push('## Comparison vs. Previous');
  lines.push('');
  lines.push(`**Previous run:** ${comparison.previousTimestamp}`);
  lines.push('');

  // Summary changes table
  lines.push('### Summary Changes');
  lines.push('');
  lines.push('| Metric | Previous | Current | Delta | |');
  lines.push('|--------|----------|---------|-------|-|');
  lines.push(summaryRow('Discovery Accuracy',
    `${(d.previous.discoveryAccuracy * 100).toFixed(1)}%`,
    `${(d.current.discoveryAccuracy * 100).toFixed(1)}%`,
    formatDelta(d.delta.discoveryAccuracy * 100) + '%',
    d.delta.discoveryAccuracy
  ));
  lines.push(summaryRow('Avg Adherence',
    `${d.previous.avgAdherence.toFixed(2)}/5`,
    `${d.current.avgAdherence.toFixed(2)}/5`,
    formatDelta(d.delta.avgAdherence),
    d.delta.avgAdherence
  ));
  lines.push(summaryRow('Avg Output Quality',
    `${d.previous.avgOutputQuality.toFixed(2)}/5`,
    `${d.current.avgOutputQuality.toFixed(2)}/5`,
    formatDelta(d.delta.avgOutputQuality),
    d.delta.avgOutputQuality
  ));
  lines.push(summaryRow('Weighted Score',
    d.previous.avgWeightedScore.toFixed(2),
    d.current.avgWeightedScore.toFixed(2),
    formatDelta(d.delta.avgWeightedScore),
    d.delta.avgWeightedScore
  ));
  lines.push('');

  // Per-task changes table
  if (comparison.taskDeltas.length > 0) {
    lines.push('### Per-Task Changes');
    lines.push('');
    lines.push('| Task | Discovery | Adherence | Output | Weighted | Status |');
    lines.push('|------|-----------|-----------|--------|----------|--------|');
    for (const t of comparison.taskDeltas) {
      const status = t.significantChange === 'improved'
        ? ':arrow_up: Improved'
        : t.significantChange === 'regressed'
          ? ':arrow_down: Regressed'
          : 'Unchanged';
      lines.push(`| ${t.taskId} | ${formatTransition(t.previous.discovery, t.current.discovery)} | ${formatTransition(t.previous.adherence, t.current.adherence)} | ${formatTransition(t.previous.outputQuality, t.current.outputQuality)} | ${formatTransitionDecimal(t.previous.weightedScore, t.current.weightedScore)} | ${status} |`);
    }
    lines.push('');
  }

  // Warnings
  if (comparison.tasksOnlyInCurrent.length > 0 || comparison.tasksOnlyInPrevious.length > 0) {
    lines.push('### Warnings');
    lines.push('');
    for (const id of comparison.tasksOnlyInCurrent) {
      lines.push(`- Task \`${id}\` exists in current results but not in previous`);
    }
    for (const id of comparison.tasksOnlyInPrevious) {
      lines.push(`- Task \`${id}\` exists in previous results but not in current`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format comparison data for console output.
 */
export function formatComparisonConsole(comparison: ComparisonResult): string {
  const lines: string[] = [];
  const d = comparison.summaryDelta.delta;

  lines.push('');
  lines.push('-'.repeat(50));
  lines.push('  Comparison vs. Previous');
  lines.push('-'.repeat(50));
  lines.push(`  Discovery:    ${formatDelta(d.discoveryAccuracy * 100)}%`);
  lines.push(`  Adherence:    ${formatDelta(d.avgAdherence)}`);
  lines.push(`  Output:       ${formatDelta(d.avgOutputQuality)}`);
  lines.push(`  Weighted:     ${formatDelta(d.avgWeightedScore)}`);

  const improved = comparison.taskDeltas.filter((t) => t.significantChange === 'improved');
  const regressed = comparison.taskDeltas.filter((t) => t.significantChange === 'regressed');

  if (improved.length > 0) {
    lines.push(`\n  Improved (${improved.length}): ${improved.map((t) => t.taskId).join(', ')}`);
  }
  if (regressed.length > 0) {
    lines.push(`  Regressed (${regressed.length}): ${regressed.map((t) => t.taskId).join(', ')}`);
  }
  if (comparison.tasksOnlyInCurrent.length > 0) {
    lines.push(`  New tasks: ${comparison.tasksOnlyInCurrent.join(', ')}`);
  }
  if (comparison.tasksOnlyInPrevious.length > 0) {
    lines.push(`  Removed tasks: ${comparison.tasksOnlyInPrevious.join(', ')}`);
  }
  lines.push('-'.repeat(50));

  return lines.join('\n');
}

function summaryRow(label: string, prev: string, curr: string, delta: string, value: number): string {
  const arrow = value > ARROW_DIRECTION_EPSILON ? ':arrow_up:' : value < -ARROW_DIRECTION_EPSILON ? ':arrow_down:' : '';
  return `| **${label}** | ${prev} | ${curr} | ${delta} | ${arrow} |`;
}

function formatTransition(prev: number, curr: number): string {
  const delta = curr - prev;
  const sign = delta > 0 ? '+' : '';
  const fmt = (v: number) => v.toFixed(1);
  return `${fmt(prev)} → ${fmt(curr)} (${sign}${fmt(delta)})`;
}

function formatTransitionDecimal(prev: number, curr: number): string {
  const delta = curr - prev;
  const sign = delta > 0 ? '+' : '';
  return `${prev.toFixed(2)} → ${curr.toFixed(2)} (${sign}${delta.toFixed(2)})`;
}
