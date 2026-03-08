import { describe, it, expect } from 'vitest';
import { computeStddev, aggregateScores, FLAKY_STDDEV_THRESHOLD } from '../scorer/aggregator.js';
import type { CombinedScore } from '../types.js';

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
      reasoning: 'test',
      ...overrides,
    };
  }

  it('returns empty array for no runs', () => {
    expect(aggregateScores([])).toEqual([]);
  });

  it('returns original scores for single run', () => {
    const scores = [makeScore()];
    expect(aggregateScores([scores])).toBe(scores);
  });

  it('averages scores across runs', () => {
    const run1 = [makeScore({ adherence: 3, outputQuality: 3, weightedScore: 0.6 })];
    const run2 = [makeScore({ adherence: 5, outputQuality: 5, weightedScore: 1.0 })];
    const result = aggregateScores([run1, run2]);

    expect(result).toHaveLength(1);
    expect(result[0].adherence).toBe(4);
    expect(result[0].outputQuality).toBe(4);
    expect(result[0].weightedScore).toBe(0.8);
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
    const run1 = [makeScore()];
    const run2 = [makeScore()];
    const run3 = [makeScore()];
    const result = aggregateScores([run1, run2, run3]);

    expect(result[0].stddev).toBeDefined();
    expect(result[0].stddev!.discovery).toBeCloseTo(0, 10);
    expect(result[0].stddev!.adherence).toBeCloseTo(0, 10);
    expect(result[0].stddev!.outputQuality).toBeCloseTo(0, 10);
    expect(result[0].stddev!.weightedScore).toBeCloseTo(0, 10);
  });
});

describe('FLAKY_STDDEV_THRESHOLD', () => {
  it('is exported and equals 1.0', () => {
    expect(FLAKY_STDDEV_THRESHOLD).toBe(1.0);
  });
});
