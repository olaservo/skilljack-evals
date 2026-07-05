/**
 * Cross-iteration comparison for skill evaluation results.
 *
 * Loads a previous run's summary.json, matches tasks by ID, computes
 * per-task resolution-rate deltas, and formats comparison output.
 */

import * as fs from 'fs/promises';
import type {
  ComparisonResult,
  TaskDelta,
  SummaryDelta,
  ScoreSnapshot,
  SummarySnapshot,
} from '../types.js';
import type { RunSummary } from '../results/types.js';
import { formatDelta, ARROW_DIRECTION_EPSILON } from '../utils/format.js';

/** Per-task resolution-rate delta at or above this magnitude is significant. */
export const SIGNIFICANCE_THRESHOLD_RESOLUTION = 0.2;

/**
 * Load and validate a previous run summary (summary.json).
 *
 * Old-format results.json files (pre-2.0) are rejected with a clear error.
 */
export async function loadPreviousRunSummary(filePath: string): Promise<RunSummary> {
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

  const summary = data as Record<string, unknown>;

  // Detect the pre-2.0 results.json shape and fail with guidance.
  const oldSummary = summary.summary as Record<string, unknown> | undefined;
  if (typeof summary.skillName === 'string' && oldSummary && typeof oldSummary.avgWeightedScore === 'number') {
    throw new Error(
      `Comparison file looks like a pre-2.0 results.json (weighted-score format): ${filePath}. ` +
      `--compare-results now reads the summary.json written by a 2.x run — re-run the previous iteration to produce one.`,
    );
  }

  const metrics = summary.metrics as Record<string, unknown> | undefined;
  if (!metrics || typeof metrics.resolutionRate !== 'number' || typeof metrics.passAtK !== 'number') {
    throw new Error('Comparison file is not a valid run summary: missing numeric "metrics.resolutionRate"/"metrics.passAtK"');
  }
  if (!Array.isArray(summary.tasks)) {
    throw new Error('Comparison file is not a valid run summary: missing "tasks" array');
  }
  for (const task of summary.tasks) {
    if (typeof task?.id !== 'string' || typeof task?.withSkill?.resolutionRate !== 'number') {
      throw new Error('Comparison file has task entries without "id" and numeric "withSkill.resolutionRate"');
    }
  }
  if (!summary.run || typeof (summary.run as Record<string, unknown>).timestamp !== 'string') {
    throw new Error('Comparison file is not a valid run summary: missing "run.timestamp"');
  }

  return data as RunSummary;
}

/**
 * Compare a current run summary against a previous one.
 */
export function compareRunSummaries(
  current: RunSummary,
  previous: RunSummary
): ComparisonResult {
  // Build lookup from previous tasks
  const previousMap = new Map<string, ScoreSnapshot>();
  for (const task of previous.tasks) {
    previousMap.set(task.id, {
      resolutionRate: task.withSkill.resolutionRate,
      lift: task.lift,
    });
  }

  const currentIds = new Set(current.tasks.map((t) => t.id));

  // Compute per-task deltas
  const taskDeltas: TaskDelta[] = [];
  const tasksOnlyInCurrent: string[] = [];

  const round3 = (v: number) => Math.round(v * 1000) / 1000;

  for (const task of current.tasks) {
    const prev = previousMap.get(task.id);
    if (!prev) {
      tasksOnlyInCurrent.push(task.id);
      continue;
    }

    const currentSnapshot: ScoreSnapshot = {
      resolutionRate: task.withSkill.resolutionRate,
      lift: task.lift,
    };
    const delta = round3(currentSnapshot.resolutionRate - prev.resolutionRate);

    let significantChange: TaskDelta['significantChange'] = 'unchanged';
    if (Math.abs(delta) >= SIGNIFICANCE_THRESHOLD_RESOLUTION) {
      significantChange = delta > 0 ? 'improved' : 'regressed';
    }

    taskDeltas.push({
      taskId: task.id,
      previous: prev,
      current: currentSnapshot,
      delta,
      significantChange,
    });
  }

  // Find tasks only in previous
  const tasksOnlyInPrevious: string[] = [];
  for (const task of previous.tasks) {
    if (!currentIds.has(task.id)) {
      tasksOnlyInPrevious.push(task.id);
    }
  }

  // Compute summary delta
  const prevSummary: SummarySnapshot = {
    resolutionRate: previous.metrics.resolutionRate,
    passAtK: previous.metrics.passAtK,
    skillLift: previous.metrics.skillLift,
  };
  const currSummary: SummarySnapshot = {
    resolutionRate: current.metrics.resolutionRate,
    passAtK: current.metrics.passAtK,
    skillLift: current.metrics.skillLift,
  };

  const summaryDelta: SummaryDelta = {
    previous: prevSummary,
    current: currSummary,
    delta: {
      resolutionRate: round3(currSummary.resolutionRate - prevSummary.resolutionRate),
      passAtK: round3(currSummary.passAtK - prevSummary.passAtK),
      skillLift: currSummary.skillLift !== undefined && prevSummary.skillLift !== undefined
        ? round3(currSummary.skillLift - prevSummary.skillLift)
        : undefined,
    },
  };

  return {
    previousTimestamp: previous.run.timestamp,
    previousSkillName: previous.run.skillName,
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
  lines.push(summaryRow('Resolution Rate',
    `${(d.previous.resolutionRate * 100).toFixed(1)}%`,
    `${(d.current.resolutionRate * 100).toFixed(1)}%`,
    formatDelta(d.delta.resolutionRate * 100) + '%',
    d.delta.resolutionRate
  ));
  lines.push(summaryRow('Pass@k',
    `${(d.previous.passAtK * 100).toFixed(1)}%`,
    `${(d.current.passAtK * 100).toFixed(1)}%`,
    formatDelta(d.delta.passAtK * 100) + '%',
    d.delta.passAtK
  ));
  if (d.delta.skillLift !== undefined && d.previous.skillLift !== undefined && d.current.skillLift !== undefined) {
    lines.push(summaryRow('Skill Lift',
      formatDelta(d.previous.skillLift * 100, 1) + '%',
      formatDelta(d.current.skillLift * 100, 1) + '%',
      formatDelta(d.delta.skillLift * 100) + '%',
      d.delta.skillLift
    ));
  }
  lines.push('');

  // Per-task changes table
  if (comparison.taskDeltas.length > 0) {
    lines.push('### Per-Task Changes');
    lines.push('');
    lines.push('| Task | Resolution Rate | Delta | Status |');
    lines.push('|------|-----------------|-------|--------|');
    for (const t of comparison.taskDeltas) {
      const status = t.significantChange === 'improved'
        ? ':arrow_up: Improved'
        : t.significantChange === 'regressed'
          ? ':arrow_down: Regressed'
          : 'Unchanged';
      lines.push(`| ${t.taskId} | ${formatTransitionPct(t.previous.resolutionRate, t.current.resolutionRate)} | ${formatDelta(t.delta * 100)}% | ${status} |`);
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
  lines.push(`  Resolution:   ${formatDelta(d.resolutionRate * 100)}%`);
  lines.push(`  Pass@k:       ${formatDelta(d.passAtK * 100)}%`);
  if (d.skillLift !== undefined) {
    lines.push(`  Skill Lift:   ${formatDelta(d.skillLift * 100)}%`);
  }

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

function formatTransitionPct(prev: number, curr: number): string {
  return `${(prev * 100).toFixed(0)}% → ${(curr * 100).toFixed(0)}%`;
}
