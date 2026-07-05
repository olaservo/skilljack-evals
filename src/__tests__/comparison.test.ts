import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import {
  loadPreviousRunSummary,
  compareRunSummaries,
  formatComparisonMarkdown,
  formatComparisonConsole,
  SIGNIFICANCE_THRESHOLD_RESOLUTION,
} from '../report/comparison.js';
import { formatDelta, formatCategory } from '../utils/format.js';
import type { RunSummary, TaskRunSummary, ConditionStats } from '../results/types.js';

function makeCondition(passed: boolean[]): ConditionStats {
  return {
    passed,
    rewards: passed.map((p) => (p ? 1 : 0)),
    resolutionRate: passed.length > 0 ? passed.filter(Boolean).length / passed.length : 0,
    passAtK: passed.some(Boolean),
  };
}

function makeTaskSummary(id: string, passed: boolean[], overrides: Partial<TaskRunSummary> = {}): TaskRunSummary {
  return {
    id,
    expectedSkill: 'test-skill',
    withSkill: makeCondition(passed),
    failures: [],
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  const tasks = overrides.tasks ?? [
    makeTaskSummary('task-1', [true, true]),
    makeTaskSummary('task-2', [true, false]),
  ];
  const rates = tasks.map((t) => t.withSkill.resolutionRate);
  const resolutionRate = rates.length > 0 ? rates.reduce((s, v) => s + v, 0) / rates.length : 0;
  return {
    version: 2,
    run: {
      timestamp: '2026-03-07T10:00:00.000Z',
      skillName: 'test-skill',
      runner: 'claude-sdk',
      model: 'sonnet',
      nudge: 'off',
      trials: 2,
      baseline: false,
      judge: false,
    },
    metrics: {
      resolutionRate,
      ci: { low: 0, high: 1 },
      passAtK: tasks.length > 0 ? tasks.filter((t) => t.withSkill.passAtK).length / tasks.length : 0,
      byDifficulty: {},
      byCategory: {},
      byTag: {},
      totalDurationMs: 5000,
      totalCostUsd: 0.01,
    },
    thresholds: { resolution: 0.8, resolutionPassed: resolutionRate >= 0.8, passed: resolutionRate >= 0.8 },
    ...overrides,
    tasks,
  };
}

describe('loadPreviousRunSummary', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function writeTmpJson(data: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comparison-test-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'summary.json');
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return filePath;
  }

  it('loads a valid run summary file', async () => {
    const summary = makeRunSummary();
    const filePath = await writeTmpJson(summary);
    const loaded = await loadPreviousRunSummary(filePath);
    expect(loaded.run.skillName).toBe('test-skill');
    expect(loaded.tasks).toHaveLength(2);
  });

  it('throws for file not found', async () => {
    await expect(loadPreviousRunSummary('/nonexistent/path/summary.json'))
      .rejects.toThrow('Comparison file not found');
  });

  it('throws for invalid JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comparison-test-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'bad.json');
    await fs.writeFile(filePath, '{ not valid json');
    await expect(loadPreviousRunSummary(filePath))
      .rejects.toThrow('Failed to parse comparison file as JSON');
  });

  it('rejects the pre-2.0 results.json format with a clear error', async () => {
    const filePath = await writeTmpJson({
      skillName: 'old-skill',
      summary: { discoveryAccuracy: 0.8, avgAdherence: 4, avgOutputQuality: 4, avgWeightedScore: 0.75 },
      tasks: [],
    });
    await expect(loadPreviousRunSummary(filePath))
      .rejects.toThrow('pre-2.0 results.json');
  });

  it('throws for missing metrics', async () => {
    const filePath = await writeTmpJson({ run: { timestamp: 'x' }, tasks: [] });
    await expect(loadPreviousRunSummary(filePath))
      .rejects.toThrow('missing numeric "metrics.resolutionRate"');
  });

  it('throws for missing tasks array', async () => {
    const filePath = await writeTmpJson({
      run: { timestamp: 'x' },
      metrics: { resolutionRate: 0.5, passAtK: 0.5 },
    });
    await expect(loadPreviousRunSummary(filePath))
      .rejects.toThrow('missing "tasks" array');
  });

  it('throws for task entries without id/withSkill.resolutionRate', async () => {
    const filePath = await writeTmpJson({
      run: { timestamp: 'x' },
      metrics: { resolutionRate: 0.5, passAtK: 0.5 },
      tasks: [{ withSkill: {} }],
    });
    await expect(loadPreviousRunSummary(filePath))
      .rejects.toThrow('task entries without "id"');
  });

  it('throws for missing run.timestamp', async () => {
    const filePath = await writeTmpJson({
      metrics: { resolutionRate: 0.5, passAtK: 0.5 },
      tasks: [],
    });
    await expect(loadPreviousRunSummary(filePath))
      .rejects.toThrow('missing "run.timestamp"');
  });

  it('tolerates extra fields', async () => {
    const summary = { ...makeRunSummary(), extraField: 'hello' };
    const filePath = await writeTmpJson(summary);
    const loaded = await loadPreviousRunSummary(filePath);
    expect(loaded.run.skillName).toBe('test-skill');
  });
});

describe('compareRunSummaries', () => {
  it('returns all unchanged for identical results', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary();

    const result = compareRunSummaries(current, previous);

    expect(result.taskDeltas).toHaveLength(2);
    expect(result.taskDeltas.every((t) => t.significantChange === 'unchanged')).toBe(true);
    expect(result.taskDeltas[0].delta).toBe(0);
    expect(result.tasksOnlyInCurrent).toHaveLength(0);
    expect(result.tasksOnlyInPrevious).toHaveLength(0);
    expect(result.summaryDelta.delta.resolutionRate).toBe(0);
    expect(result.summaryDelta.delta.passAtK).toBe(0);
  });

  it('detects improved task', () => {
    const previous = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [false, false]), makeTaskSummary('task-2', [true, true])],
    });
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, true]), makeTaskSummary('task-2', [true, true])],
    });

    const result = compareRunSummaries(current, previous);

    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.significantChange).toBe('improved');
    expect(task1.delta).toBe(1);
  });

  it('detects regressed task', () => {
    const previous = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, true])],
    });
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [false, false])],
    });

    const result = compareRunSummaries(current, previous);

    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.significantChange).toBe('regressed');
    expect(task1.delta).toBe(-1);
  });

  it('flags significance at the 0.2 resolution-delta boundary', () => {
    // 3/5 → 4/5 = +0.2 exactly
    const previous = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, true, true, false, false])],
    });
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, true, true, true, false])],
    });

    const result = compareRunSummaries(current, previous);
    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.delta).toBeCloseTo(SIGNIFICANCE_THRESHOLD_RESOLUTION, 10);
    expect(task1.significantChange).toBe('improved');
  });

  it('treats sub-threshold deltas as unchanged', () => {
    // 4/5 → 5/5 wait that's 0.2; use 9/10 → 10/10 = +0.1
    const previous = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [...Array(9).fill(true), false])],
    });
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', Array(10).fill(true))],
    });

    const result = compareRunSummaries(current, previous);
    expect(result.taskDeltas[0].significantChange).toBe('unchanged');
  });

  it('detects tasks only in current', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary({
      tasks: [
        makeTaskSummary('task-1', [true]),
        makeTaskSummary('task-2', [true]),
        makeTaskSummary('task-3', [true]),
      ],
    });

    const result = compareRunSummaries(current, previous);
    expect(result.tasksOnlyInCurrent).toEqual(['task-3']);
  });

  it('detects tasks only in previous', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary({ tasks: [makeTaskSummary('task-1', [true])] });

    const result = compareRunSummaries(current, previous);
    expect(result.tasksOnlyInPrevious).toEqual(['task-2']);
    expect(result.taskDeltas).toHaveLength(1);
  });

  it('handles empty previous (all tasks are new)', () => {
    const previous = makeRunSummary({ tasks: [] });
    const current = makeRunSummary({ tasks: [makeTaskSummary('task-1', [true])] });

    const result = compareRunSummaries(current, previous);
    expect(result.taskDeltas).toHaveLength(0);
    expect(result.tasksOnlyInCurrent).toEqual(['task-1']);
    expect(result.tasksOnlyInPrevious).toHaveLength(0);
  });

  it('computes correct summary deltas incl. skill lift', () => {
    const previous = makeRunSummary();
    previous.metrics.resolutionRate = 0.5;
    previous.metrics.passAtK = 0.5;
    previous.metrics.skillLift = 0.1;
    const current = makeRunSummary();
    current.metrics.resolutionRate = 0.75;
    current.metrics.passAtK = 1;
    current.metrics.skillLift = 0.4;

    const result = compareRunSummaries(current, previous);
    expect(result.summaryDelta.delta.resolutionRate).toBeCloseTo(0.25);
    expect(result.summaryDelta.delta.passAtK).toBeCloseTo(0.5);
    expect(result.summaryDelta.delta.skillLift).toBeCloseTo(0.3);
  });

  it('omits skill lift delta when either run lacks a baseline', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary();
    current.metrics.skillLift = 0.4;

    const result = compareRunSummaries(current, previous);
    expect(result.summaryDelta.delta.skillLift).toBeUndefined();
  });

  it('stores previous and current values in task deltas', () => {
    const previous = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, false], { lift: 0.5 })],
    });
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, true], { lift: 1 })],
    });

    const result = compareRunSummaries(current, previous);
    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.previous).toEqual({ resolutionRate: 0.5, lift: 0.5 });
    expect(task1.current).toEqual({ resolutionRate: 1, lift: 1 });
  });
});

describe('formatComparisonMarkdown', () => {
  it('contains expected headings', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary();
    const comparison = compareRunSummaries(current, previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('## Comparison vs. Previous');
    expect(md).toContain('### Summary Changes');
    expect(md).toContain('### Per-Task Changes');
  });

  it('shows positive deltas with + prefix', () => {
    const previous = makeRunSummary();
    previous.metrics.resolutionRate = 0.5;
    const current = makeRunSummary();
    current.metrics.resolutionRate = 0.75;
    const comparison = compareRunSummaries(current, previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('+25.00%');
  });

  it('includes warnings for mismatched tasks', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true]), makeTaskSummary('task-3', [true])],
    });
    const comparison = compareRunSummaries(current, previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('### Warnings');
    expect(md).toContain('`task-3`');
    expect(md).toContain('`task-2`');
  });

  it('omits warnings section when no mismatched tasks', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary();
    const comparison = compareRunSummaries(current, previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).not.toContain('### Warnings');
  });

  it('shows improved and regressed status labels', () => {
    const previous = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [false, false]), makeTaskSummary('task-2', [true, true])],
    });
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, true]), makeTaskSummary('task-2', [false, false])],
    });
    const comparison = compareRunSummaries(current, previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('Improved');
    expect(md).toContain('Regressed');
  });
});

describe('formatComparisonConsole', () => {
  it('contains comparison header and delta values', () => {
    const previous = makeRunSummary();
    previous.metrics.resolutionRate = 0.5;
    const current = makeRunSummary();
    current.metrics.resolutionRate = 0.75;
    const comparison = compareRunSummaries(current, previous);
    const output = formatComparisonConsole(comparison);

    expect(output).toContain('Comparison vs. Previous');
    expect(output).toContain('Resolution');
    expect(output).toContain('+25.00%');
  });

  it('lists improved and regressed tasks', () => {
    const previous = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [false, false]), makeTaskSummary('task-2', [true, true])],
    });
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true, true]), makeTaskSummary('task-2', [false, false])],
    });
    const comparison = compareRunSummaries(current, previous);
    const output = formatComparisonConsole(comparison);

    expect(output).toContain('Improved (1): task-1');
    expect(output).toContain('Regressed (1): task-2');
  });

  it('shows new and removed task labels', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary({
      tasks: [makeTaskSummary('task-1', [true]), makeTaskSummary('task-3', [true])],
    });
    const comparison = compareRunSummaries(current, previous);
    const output = formatComparisonConsole(comparison);

    expect(output).toContain('New tasks: task-3');
    expect(output).toContain('Removed tasks: task-2');
  });

  it('omits new/removed labels when all tasks match', () => {
    const previous = makeRunSummary();
    const current = makeRunSummary();
    const comparison = compareRunSummaries(current, previous);
    const output = formatComparisonConsole(comparison);

    expect(output).not.toContain('New tasks');
    expect(output).not.toContain('Removed tasks');
  });
});

describe('formatDelta', () => {
  it('adds + prefix for positive values', () => {
    expect(formatDelta(1.5)).toBe('+1.50');
  });

  it('shows no prefix for negative values (minus is implicit)', () => {
    expect(formatDelta(-0.75)).toBe('-0.75');
  });

  it('shows no prefix for zero', () => {
    expect(formatDelta(0)).toBe('0.00');
  });

  it('can be combined with a suffix by the caller', () => {
    expect(formatDelta(2.5) + '%').toBe('+2.50%');
    expect(formatDelta(-1.0) + '%').toBe('-1.00%');
  });

  it('rounds to 2 decimal places', () => {
    expect(formatDelta(1.999)).toBe('+2.00');
    expect(formatDelta(0.005)).toBe('+0.01');
    expect(formatDelta(0.004)).toBe('+0.00');
  });
});

describe('formatCategory', () => {
  it('converts "none" to "No Failure"', () => {
    expect(formatCategory('none')).toBe('No Failure');
  });

  it('converts snake_case to Title Case', () => {
    expect(formatCategory('discovery_failure')).toBe('Discovery Failure');
    expect(formatCategory('false_positive')).toBe('False Positive');
    expect(formatCategory('instruction_ambiguity')).toBe('Instruction Ambiguity');
  });

  it('capitalizes single words', () => {
    expect(formatCategory('error')).toBe('Error');
  });
});
