import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import {
  loadPreviousReport,
  compareResults,
  formatComparisonMarkdown,
  formatComparisonConsole,
  SIGNIFICANCE_THRESHOLD_ADHERENCE,
  SIGNIFICANCE_THRESHOLD_WEIGHTED,
} from '../report/comparison.js';
import { formatDelta, formatCategory } from '../report/format-utils.js';
import type {
  EvaluationReport,
  EvaluationSummary,
  CombinedScore,
} from '../types.js';

// Helper to build a minimal valid EvaluationReport
function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    skillName: 'test-skill',
    timestamp: '2026-03-07T10:00:00.000Z',
    passed: true,
    failureReasons: [],
    summary: {
      totalTasks: 2,
      numRuns: 1,
      discoveryAccuracy: 0.8,
      avgAdherence: 4.0,
      avgOutputQuality: 4.0,
      avgWeightedScore: 0.75,
      totalDurationMs: 5000,
      totalCostUsd: 0.01,
    },
    failureBreakdown: [],
    tasks: [
      {
        task: { id: 'task-1', prompt: 'p1', expectedSkillLoad: 'skill', criteria: [], goldenChecklist: [] },
        result: { taskId: 'task-1', prompt: 'p1', output: 'out1', durationMs: 2500, numTurns: 1, costUsd: 0.005, skillLoads: ['skill'], toolCalls: [], isError: false, errorMessage: '' },
        score: { taskId: 'task-1', deterministic: null, judge: null, discovery: 1, adherence: 4, outputQuality: 4, weightedScore: 0.8, failureCategory: 'none', reasoning: 'ok' },
      },
      {
        task: { id: 'task-2', prompt: 'p2', expectedSkillLoad: 'skill', criteria: [], goldenChecklist: [] },
        result: { taskId: 'task-2', prompt: 'p2', output: 'out2', durationMs: 2500, numTurns: 1, costUsd: 0.005, skillLoads: ['skill'], toolCalls: [], isError: false, errorMessage: '' },
        score: { taskId: 'task-2', deterministic: null, judge: null, discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7, failureCategory: 'none', reasoning: 'ok' },
      },
    ],
    ...overrides,
  };
}

function makeScore(overrides: Partial<CombinedScore> = {}): CombinedScore {
  return {
    taskId: 'task-1',
    deterministic: null,
    judge: null,
    discovery: 1,
    adherence: 4,
    outputQuality: 4,
    weightedScore: 0.8,
    failureCategory: 'none',
    reasoning: 'ok',
    ...overrides,
  };
}

function makeSummary(overrides: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return {
    totalTasks: 2,
    numRuns: 1,
    discoveryAccuracy: 0.8,
    avgAdherence: 4.0,
    avgOutputQuality: 4.0,
    avgWeightedScore: 0.75,
    totalDurationMs: 5000,
    totalCostUsd: 0.01,
    ...overrides,
  };
}

describe('loadPreviousReport', () => {
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
    const filePath = path.join(dir, 'results.json');
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return filePath;
  }

  it('loads a valid report file', async () => {
    const report = makeReport();
    const filePath = await writeTmpJson(report);
    const loaded = await loadPreviousReport(filePath);
    expect(loaded.skillName).toBe('test-skill');
    expect(loaded.tasks).toHaveLength(2);
  });

  it('throws for file not found', async () => {
    await expect(loadPreviousReport('/nonexistent/path/results.json'))
      .rejects.toThrow('Comparison file not found');
  });

  it('throws for invalid JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comparison-test-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'bad.json');
    await fs.writeFile(filePath, '{ not valid json');
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('Failed to parse comparison file as JSON');
  });

  it('throws for missing skillName', async () => {
    const filePath = await writeTmpJson({ summary: {}, tasks: [] });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing "skillName"');
  });

  it('throws for missing summary', async () => {
    const filePath = await writeTmpJson({ skillName: 'test', tasks: [] });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing "summary"');
  });

  it('throws for missing tasks array', async () => {
    const filePath = await writeTmpJson({ skillName: 'test', summary: {} });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing "tasks" array');
  });

  it('throws for task without score.taskId', async () => {
    const filePath = await writeTmpJson({
      skillName: 'test',
      summary: {},
      tasks: [{ task: {}, result: {}, score: {} }],
    });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('without score.taskId');
  });

  it('tolerates extra fields', async () => {
    const report = { ...makeReport(), extraField: 'hello' };
    const filePath = await writeTmpJson(report);
    const loaded = await loadPreviousReport(filePath);
    expect(loaded.skillName).toBe('test-skill');
  });

  it('throws for task with non-numeric weightedScore', async () => {
    const filePath = await writeTmpJson({
      skillName: 'test',
      summary: {},
      tasks: [{ task: {}, result: {}, score: { taskId: 'task-1', weightedScore: 'bad' } }],
    });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing numeric score fields');
  });

  it('throws for task with missing weightedScore', async () => {
    const filePath = await writeTmpJson({
      skillName: 'test',
      summary: {},
      tasks: [{ task: {}, result: {}, score: { taskId: 'task-1' } }],
    });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing numeric score fields');
  });
});

describe('compareResults', () => {
  it('returns all unchanged for identical results', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 1, adherence: 4, outputQuality: 4, weightedScore: 0.8 }),
      makeScore({ taskId: 'task-2', discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7 }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);

    expect(result.taskDeltas).toHaveLength(2);
    expect(result.taskDeltas.every((t) => t.significantChange === 'unchanged')).toBe(true);
    expect(result.taskDeltas[0].delta.discovery).toBe(0);
    expect(result.taskDeltas[0].delta.adherence).toBe(0);
    expect(result.tasksOnlyInCurrent).toHaveLength(0);
    expect(result.tasksOnlyInPrevious).toHaveLength(0);

    // Summary delta should be zero
    expect(result.summaryDelta.delta.discoveryAccuracy).toBe(0);
    expect(result.summaryDelta.delta.avgAdherence).toBe(0);
  });

  it('detects improved task', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 1, adherence: 5, outputQuality: 5, weightedScore: 0.95 }),
      makeScore({ taskId: 'task-2', discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7 }),
    ];
    const currentSummary = makeSummary({ avgAdherence: 4.5, avgWeightedScore: 0.825 });

    const result = compareResults(currentScores, currentSummary, previous);

    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.significantChange).toBe('improved');
    expect(task1.delta.adherence).toBe(1);
    expect(task1.delta.weightedScore).toBeCloseTo(0.15);
  });

  it('detects regressed task', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 0, adherence: 2, outputQuality: 2, weightedScore: 0.15 }),
      makeScore({ taskId: 'task-2', discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7 }),
    ];
    const currentSummary = makeSummary({ avgAdherence: 3.0, avgWeightedScore: 0.425 });

    const result = compareResults(currentScores, currentSummary, previous);

    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.significantChange).toBe('regressed');
    expect(task1.delta.adherence).toBe(-2);
  });

  it('flags significance at boundary (adherence delta = 1)', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 1, adherence: 5, outputQuality: 4, weightedScore: 0.85 }),
      makeScore({ taskId: 'task-2', discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7 }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.delta.adherence).toBe(SIGNIFICANCE_THRESHOLD_ADHERENCE);
    expect(task1.significantChange).toBe('improved');
  });

  it('detects tasks only in current', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1' }),
      makeScore({ taskId: 'task-2' }),
      makeScore({ taskId: 'task-3' }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    expect(result.tasksOnlyInCurrent).toEqual(['task-3']);
  });

  it('detects tasks only in previous', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1' }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    expect(result.tasksOnlyInPrevious).toEqual(['task-2']);
    expect(result.taskDeltas).toHaveLength(1);
  });

  it('handles empty previous (all tasks are new)', () => {
    const previous = makeReport({ tasks: [], summary: makeSummary({ totalTasks: 0, discoveryAccuracy: 0, avgAdherence: 0, avgOutputQuality: 0, avgWeightedScore: 0 }) });
    const currentScores = [makeScore({ taskId: 'task-1' })];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    expect(result.taskDeltas).toHaveLength(0);
    expect(result.tasksOnlyInCurrent).toEqual(['task-1']);
    expect(result.tasksOnlyInPrevious).toHaveLength(0);
  });

  it('computes correct summary deltas', () => {
    const previous = makeReport();
    const currentSummary = makeSummary({
      discoveryAccuracy: 0.9,
      avgAdherence: 4.5,
      avgOutputQuality: 4.2,
      avgWeightedScore: 0.85,
    });
    const currentScores = [
      makeScore({ taskId: 'task-1' }),
      makeScore({ taskId: 'task-2' }),
    ];

    const result = compareResults(currentScores, currentSummary, previous);
    expect(result.summaryDelta.delta.discoveryAccuracy).toBeCloseTo(0.1);
    expect(result.summaryDelta.delta.avgAdherence).toBeCloseTo(0.5);
    expect(result.summaryDelta.delta.avgOutputQuality).toBeCloseTo(0.2);
    expect(result.summaryDelta.delta.avgWeightedScore).toBeCloseTo(0.1);
  });

  it('detects significance by weighted threshold when adherence is unchanged', () => {
    const previous = makeReport();
    // Discovery flip: 0 -> 1, which changes weighted score by ~0.3 with default weights
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 1, adherence: 4, outputQuality: 4, weightedScore: 0.8 }),
      makeScore({ taskId: 'task-2', discovery: 1, adherence: 4, outputQuality: 4, weightedScore: 0.9 }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    const task2 = result.taskDeltas.find((t) => t.taskId === 'task-2')!;
    // weightedScore delta = 0.9 - 0.7 = 0.2, which exceeds SIGNIFICANCE_THRESHOLD_WEIGHTED
    expect(task2.significantChange).toBe('improved');
  });

  it('classifies as improved when weightedScore is zero but adherence improved', () => {
    const previous = makeReport();
    // Adherence improves by 1 (significant), but weightedScore stays the same
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 1, adherence: 5, outputQuality: 4, weightedScore: 0.8 }),
      makeScore({ taskId: 'task-2', discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7 }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.delta.adherence).toBe(1);
    expect(task1.delta.weightedScore).toBe(0);
    expect(task1.significantChange).toBe('improved');
  });

  it('classifies as regressed when weightedScore is zero but adherence regressed', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 1, adherence: 3, outputQuality: 4, weightedScore: 0.8 }),
      makeScore({ taskId: 'task-2', discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7 }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.delta.adherence).toBe(-1);
    expect(task1.delta.weightedScore).toBe(0);
    expect(task1.significantChange).toBe('regressed');
  });

  it('stores previous and current values in task deltas', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', discovery: 1, adherence: 5, outputQuality: 5, weightedScore: 0.95 }),
      makeScore({ taskId: 'task-2', discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7 }),
    ];
    const currentSummary = makeSummary();

    const result = compareResults(currentScores, currentSummary, previous);
    const task1 = result.taskDeltas.find((t) => t.taskId === 'task-1')!;
    expect(task1.previous).toEqual({ discovery: 1, adherence: 4, outputQuality: 4, weightedScore: 0.8 });
    expect(task1.current).toEqual({ discovery: 1, adherence: 5, outputQuality: 5, weightedScore: 0.95 });
  });
});

describe('formatComparisonMarkdown', () => {
  it('contains expected headings', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', adherence: 5, weightedScore: 0.95 }),
      makeScore({ taskId: 'task-2' }),
    ];
    const comparison = compareResults(currentScores, makeSummary(), previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('## Comparison vs. Previous');
    expect(md).toContain('### Summary Changes');
    expect(md).toContain('### Per-Task Changes');
  });

  it('shows positive deltas with + prefix', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', adherence: 5, weightedScore: 0.95 }),
      makeScore({ taskId: 'task-2' }),
    ];
    const currentSummary = makeSummary({ avgAdherence: 4.5 });
    const comparison = compareResults(currentScores, currentSummary, previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('+0.50');
  });

  it('includes warnings for mismatched tasks', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1' }),
      makeScore({ taskId: 'task-3' }),
    ];
    const comparison = compareResults(currentScores, makeSummary(), previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('### Warnings');
    expect(md).toContain('`task-3`');
    expect(md).toContain('`task-2`');
  });

  it('omits warnings section when no mismatched tasks', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1' }),
      makeScore({ taskId: 'task-2' }),
    ];
    const comparison = compareResults(currentScores, makeSummary(), previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).not.toContain('### Warnings');
  });

  it('shows improved and regressed status labels', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', adherence: 5, outputQuality: 5, weightedScore: 0.95 }),
      makeScore({ taskId: 'task-2', adherence: 2, outputQuality: 2, weightedScore: 0.15 }),
    ];
    const comparison = compareResults(currentScores, makeSummary(), previous);
    const md = formatComparisonMarkdown(comparison);

    expect(md).toContain('Improved');
    expect(md).toContain('Regressed');
  });
});

describe('formatComparisonConsole', () => {
  it('contains comparison header and delta values', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', adherence: 5, weightedScore: 0.95 }),
      makeScore({ taskId: 'task-2' }),
    ];
    const currentSummary = makeSummary({ avgAdherence: 4.5 });
    const comparison = compareResults(currentScores, currentSummary, previous);
    const output = formatComparisonConsole(comparison);

    expect(output).toContain('Comparison vs. Previous');
    expect(output).toContain('Adherence');
    expect(output).toContain('+0.50');
  });

  it('lists improved and regressed tasks', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1', adherence: 5, outputQuality: 5, weightedScore: 0.95 }),
      makeScore({ taskId: 'task-2', adherence: 2, outputQuality: 2, weightedScore: 0.15 }),
    ];
    const comparison = compareResults(currentScores, makeSummary(), previous);
    const output = formatComparisonConsole(comparison);

    expect(output).toContain('Improved (1): task-1');
    expect(output).toContain('Regressed (1): task-2');
  });

  it('shows new and removed task labels', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1' }),
      makeScore({ taskId: 'task-3' }),
    ];
    const comparison = compareResults(currentScores, makeSummary(), previous);
    const output = formatComparisonConsole(comparison);

    expect(output).toContain('New tasks: task-3');
    expect(output).toContain('Removed tasks: task-2');
  });

  it('omits new/removed labels when all tasks match', () => {
    const previous = makeReport();
    const currentScores = [
      makeScore({ taskId: 'task-1' }),
      makeScore({ taskId: 'task-2' }),
    ];
    const comparison = compareResults(currentScores, makeSummary(), previous);
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

  it('appends suffix when provided', () => {
    expect(formatDelta(2.5, '%')).toBe('+2.50%');
    expect(formatDelta(-1.0, '%')).toBe('-1.00%');
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

describe('loadPreviousReport - score field validation', () => {
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
    const filePath = path.join(dir, 'results.json');
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return filePath;
  }

  it('throws for task with missing discovery field', async () => {
    const filePath = await writeTmpJson({
      skillName: 'test',
      summary: {},
      tasks: [{ task: {}, result: {}, score: { taskId: 'task-1', weightedScore: 0.8, adherence: 4, outputQuality: 4 } }],
    });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing numeric score fields');
  });

  it('throws for task with missing adherence field', async () => {
    const filePath = await writeTmpJson({
      skillName: 'test',
      summary: {},
      tasks: [{ task: {}, result: {}, score: { taskId: 'task-1', weightedScore: 0.8, discovery: 1, outputQuality: 4 } }],
    });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing numeric score fields');
  });

  it('throws for task with missing outputQuality field', async () => {
    const filePath = await writeTmpJson({
      skillName: 'test',
      summary: {},
      tasks: [{ task: {}, result: {}, score: { taskId: 'task-1', weightedScore: 0.8, discovery: 1, adherence: 4 } }],
    });
    await expect(loadPreviousReport(filePath))
      .rejects.toThrow('missing numeric score fields');
  });

  it('accepts task with all numeric score fields', async () => {
    const filePath = await writeTmpJson({
      skillName: 'test',
      summary: {},
      tasks: [{ task: {}, result: {}, score: { taskId: 'task-1', weightedScore: 0.8, discovery: 1, adherence: 4, outputQuality: 4 } }],
    });
    const loaded = await loadPreviousReport(filePath);
    expect(loaded.tasks).toHaveLength(1);
  });
});
