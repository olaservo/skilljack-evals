import { describe, it, expect } from 'vitest';
import { computeStddev, aggregateScores, aggregateResults, FLAKY_STDDEV_THRESHOLD, isFlaky } from '../scorer/aggregator.js';
import { computeSummary } from '../report/report.js';
import { makeScore, makeResult } from './fixtures/test-helpers.js';

describe('computeStddev', () => {
  it('returns 0 for empty array', () => {
    expect(computeStddev([])).toBe(0);
  });

  it('returns 0 for single value', () => {
    expect(computeStddev([5])).toBe(0);
  });

  it('returns 0 for identical values', () => {
    expect(computeStddev([3, 3, 3, 3])).toBe(0);
  });

  it('computes correct sample stddev for two values', () => {
    // [2, 4] -> mean=3, variance=((2-3)^2+(4-3)^2)/1=2, stddev=sqrt(2)
    expect(computeStddev([2, 4])).toBeCloseTo(Math.SQRT2, 10);
  });

  it('computes correct sample stddev for known dataset', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] -> mean=5, sample stddev ~2.138
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const expected = Math.sqrt(((2-5)**2 + (4-5)**2 + (4-5)**2 + (4-5)**2 + (5-5)**2 + (5-5)**2 + (7-5)**2 + (9-5)**2) / 7);
    expect(computeStddev(values)).toBeCloseTo(expected, 10);
  });

  it('uses provided mean when given', () => {
    const values = [2, 4];
    const result = computeStddev(values, 3);
    expect(result).toBeCloseTo(Math.SQRT2, 10);
  });

  it('computes mean internally when not provided', () => {
    const values = [2, 4];
    const withMean = computeStddev(values, 3);
    const withoutMean = computeStddev(values);
    expect(withoutMean).toBeCloseTo(withMean, 10);
  });
});

describe('aggregateScores', () => {
  it('returns empty array for no runs', () => {
    expect(aggregateScores([])).toEqual([]);
  });

  it('returns original scores for single run without stddev', () => {
    const scores = [makeScore()];
    const result = aggregateScores([scores]);
    expect(result).toBe(scores);
    expect(result[0].stddev).toBeUndefined();
  });

  it('averages scores across runs and keeps per-trial outcomes', () => {
    const run1 = [makeScore({ adherence: 3, outputQuality: 3, passed: false, reward: 0 })];
    const run2 = [makeScore({ adherence: 5, outputQuality: 5, passed: true, reward: 1 })];
    const result = aggregateScores([run1, run2]);

    expect(result).toHaveLength(1);
    expect(result[0].adherence).toBe(4);
    expect(result[0].outputQuality).toBe(4);
    expect(result[0].reward).toBe(0.5);
    expect(result[0].passed).toBe(false); // strict: passed only when every trial passed
    expect(result[0].trials).toEqual({ passed: [false, true], rewards: [0, 1] });
  });

  it('marks the aggregate as passed when every trial passed', () => {
    const run1 = [makeScore({ passed: true, reward: 1 })];
    const run2 = [makeScore({ passed: true, reward: 1 })];
    const result = aggregateScores([run1, run2]);

    expect(result[0].passed).toBe(true);
    expect(result[0].reward).toBe(1);
  });

  it('populates stddev for multi-run aggregation', () => {
    const run1 = [makeScore({ adherence: 3, outputQuality: 3 })];
    const run2 = [makeScore({ adherence: 5, outputQuality: 5 })];
    const result = aggregateScores([run1, run2]);

    expect(result[0].stddev).toBeDefined();
    expect(result[0].stddev!.adherence).toBeGreaterThan(0);
    expect(result[0].stddev!.outputQuality).toBeGreaterThan(0);
  });

  it('produces zero stddev when all runs are identical', () => {
    const run1 = [makeScore({ adherence: 4, outputQuality: 4 })];
    const run2 = [makeScore({ adherence: 4, outputQuality: 4 })];
    const run3 = [makeScore({ adherence: 4, outputQuality: 4 })];
    const result = aggregateScores([run1, run2, run3]);

    expect(result[0].stddev).toBeDefined();
    expect(result[0].stddev!.discovery).toBeCloseTo(0, 10);
    expect(result[0].stddev!.adherence).toBeCloseTo(0, 10);
    expect(result[0].stddev!.outputQuality).toBeCloseTo(0, 10);
    expect(result[0].stddev!.reward).toBeCloseTo(0, 10);
  });
});

describe('FLAKY_STDDEV_THRESHOLD', () => {
  it('is exported and equals 1.0', () => {
    expect(FLAKY_STDDEV_THRESHOLD).toBe(1.0);
  });
});

describe('isFlaky', () => {
  it('returns false for undefined stddev', () => {
    expect(isFlaky(undefined)).toBe(false);
  });

  it('returns false when trials agree and judge dims are below threshold', () => {
    expect(isFlaky({ reward: 0, discovery: 0, adherence: 0.5, outputQuality: 0.8 })).toBe(false);
  });

  it('returns true when trials disagree on pass/fail (reward variance)', () => {
    expect(isFlaky({ reward: 0.5, discovery: 0 })).toBe(true);
  });

  it('returns true when adherence exceeds threshold', () => {
    expect(isFlaky({ reward: 0, discovery: 0, adherence: 1.5, outputQuality: 0.5 })).toBe(true);
  });

  it('returns true when outputQuality exceeds threshold', () => {
    expect(isFlaky({ reward: 0, discovery: 0, adherence: 0.5, outputQuality: 1.5 })).toBe(true);
  });

  it('returns false when judge values equal the threshold (not exceeded)', () => {
    expect(isFlaky({ reward: 0, discovery: 0, adherence: 1.0, outputQuality: 1.0 })).toBe(false);
  });

  it('returns false when judge dims are absent and reward is stable', () => {
    expect(isFlaky({ reward: 0, discovery: 0.5 })).toBe(false);
  });
});

describe('computeSummary', () => {
  it('produces no stddev for single-run', () => {
    const results = [makeResult()];
    const scores = [makeScore()];
    const summary = computeSummary(results, scores, 1);
    expect(summary.stddev).toBeUndefined();
  });

  it('produces summary stddev as mean of per-task stddevs for multi-run', () => {
    const results = [makeResult({ taskId: 'task-1' }), makeResult({ taskId: 'task-2' })];
    const scores = [
      makeScore({
        taskId: 'task-1',
        stddev: { reward: 0.1, discovery: 0.2, adherence: 0.5, outputQuality: 0.6 },
      }),
      makeScore({
        taskId: 'task-2',
        stddev: { reward: 0.3, discovery: 0.4, adherence: 1.5, outputQuality: 1.0 },
      }),
    ];
    const summary = computeSummary(results, scores, 3);

    expect(summary.stddev).toBeDefined();
    expect(summary.stddev!.reward).toBeCloseTo(0.2, 10);
    expect(summary.stddev!.discovery).toBeCloseTo(0.3, 10);
    expect(summary.stddev!.adherence).toBeCloseTo(1.0, 10);
    expect(summary.stddev!.outputQuality).toBeCloseTo(0.8, 10);
  });

  it('handles mix of tasks with and without stddev', () => {
    const results = [makeResult({ taskId: 'task-1' }), makeResult({ taskId: 'task-2' })];
    const scores = [
      makeScore({
        taskId: 'task-1',
        stddev: { reward: 0.1, discovery: 0.2, adherence: 0.8, outputQuality: 0.6 },
      }),
      makeScore({ taskId: 'task-2' }), // no stddev
    ];
    const summary = computeSummary(results, scores, 2);

    // Only one task has stddev, so summary stddev should equal that task's stddev
    expect(summary.stddev).toBeDefined();
    expect(summary.stddev!.reward).toBeCloseTo(0.1, 10);
    expect(summary.stddev!.discovery).toBeCloseTo(0.2, 10);
    expect(summary.stddev!.adherence).toBeCloseTo(0.8, 10);
    expect(summary.stddev!.outputQuality).toBeCloseTo(0.6, 10);
  });

  it('produces no stddev when numRuns >= 2 but no tasks have stddev', () => {
    const results = [makeResult()];
    const scores = [makeScore()]; // no stddev property
    const summary = computeSummary(results, scores, 2);
    expect(summary.stddev).toBeUndefined();
  });

  it('sums totalTokens across tasks when every result has tokens', () => {
    const tokensA = { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 };
    const tokensB = { input: 200, output: 75, cacheRead: 25, cacheCreation: 10, total: 310 };
    const results = [
      makeResult({ taskId: 't1', tokens: tokensA }),
      makeResult({ taskId: 't2', tokens: tokensB }),
    ];
    const scores = [makeScore({ taskId: 't1' }), makeScore({ taskId: 't2' })];
    const summary = computeSummary(results, scores, 1);
    expect(summary.totalTokens).toBe(460);
  });

  it('leaves totalTokens undefined when any task lacks tokens', () => {
    const results = [
      makeResult({ taskId: 't1', tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15 } }),
      makeResult({ taskId: 't2' }), // no tokens
    ];
    const scores = [makeScore({ taskId: 't1' }), makeScore({ taskId: 't2' })];
    const summary = computeSummary(results, scores, 1);
    expect(summary.totalTokens).toBeUndefined();
  });
});

describe('aggregateResults token sum', () => {
  it('sums tokens across runs when every run reports them', () => {
    const run1 = [makeResult({ taskId: 't1', tokens: { input: 100, output: 50, cacheRead: 10, cacheCreation: 5, total: 165 } })];
    const run2 = [makeResult({ taskId: 't1', tokens: { input: 120, output: 60, cacheRead: 20, cacheCreation: 0, total: 200 } })];
    const run3 = [makeResult({ taskId: 't1', tokens: { input: 80, output: 40, cacheRead: 0, cacheCreation: 0, total: 120 } })];
    const scores = [[makeScore({ taskId: 't1' })], [makeScore({ taskId: 't1' })], [makeScore({ taskId: 't1' })]];
    const result = aggregateResults([run1, run2, run3], scores);
    expect(result[0].tokens).toEqual({
      input: 300,
      output: 150,
      cacheRead: 30,
      cacheCreation: 5,
      total: 485,
    });
  });

  it('leaves tokens undefined when any run lacks them', () => {
    const run1 = [makeResult({ taskId: 't1', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 } })];
    const run2 = [makeResult({ taskId: 't1' })]; // no tokens
    const scores = [[makeScore({ taskId: 't1' })], [makeScore({ taskId: 't1' })]];
    const result = aggregateResults([run1, run2], scores);
    expect(result[0].tokens).toBeUndefined();
  });
});
