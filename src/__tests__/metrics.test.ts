import { describe, it, expect } from 'vitest';
import {
  resolutionRate,
  passAtK,
  binomialCI,
  skillLift,
  macroSkillLift,
  skillInvocationRate,
  groupMetrics,
} from '../score/metrics.js';

describe('resolutionRate', () => {
  it('is the mean of the pass flags', () => {
    expect(resolutionRate([true, false, true, true])).toBeCloseTo(0.75);
  });

  it('returns 1 when all trials pass', () => {
    expect(resolutionRate([true, true, true])).toBe(1);
  });

  it('returns 0 when all trials fail', () => {
    expect(resolutionRate([false, false, false])).toBe(0);
  });

  it('handles k=1', () => {
    expect(resolutionRate([true])).toBe(1);
    expect(resolutionRate([false])).toBe(0);
  });

  it('returns 0 for an empty trial list', () => {
    expect(resolutionRate([])).toBe(0);
  });
});

describe('passAtK', () => {
  it('is true when any trial passed', () => {
    expect(passAtK([false, false, true])).toBe(true);
  });

  it('is false when all trials fail', () => {
    expect(passAtK([false, false, false])).toBe(false);
  });

  it('handles k=1', () => {
    expect(passAtK([true])).toBe(true);
    expect(passAtK([false])).toBe(false);
  });

  it('is false for an empty trial list', () => {
    expect(passAtK([])).toBe(false);
  });
});

describe('binomialCI', () => {
  it('computes p ± 1.96·sqrt(p(1−p)/n)', () => {
    const { low, high } = binomialCI(0.5, 100);
    const halfWidth = 1.96 * Math.sqrt(0.25 / 100);
    expect(low).toBeCloseTo(0.5 - halfWidth, 10);
    expect(high).toBeCloseTo(0.5 + halfWidth, 10);
  });

  it('clamps the interval to [0, 1]', () => {
    const nearOne = binomialCI(0.95, 3);
    expect(nearOne.high).toBe(1);
    expect(nearOne.low).toBeGreaterThanOrEqual(0);

    const nearZero = binomialCI(0.05, 3);
    expect(nearZero.low).toBe(0);
    expect(nearZero.high).toBeLessThanOrEqual(1);
  });

  it('collapses to a point at p=0 and p=1', () => {
    expect(binomialCI(0, 10)).toEqual({ low: 0, high: 0 });
    expect(binomialCI(1, 10)).toEqual({ low: 1, high: 1 });
  });

  it('returns the maximally wide interval when n <= 0', () => {
    expect(binomialCI(0.5, 0)).toEqual({ low: 0, high: 1 });
    expect(binomialCI(0.5, -1)).toEqual({ low: 0, high: 1 });
  });
});

describe('skillLift', () => {
  it('is the with-skill rate minus the baseline rate', () => {
    expect(skillLift(0.8, 0.3)).toBeCloseTo(0.5);
    expect(skillLift(0.2, 0.6)).toBeCloseTo(-0.4);
  });
});

describe('macroSkillLift', () => {
  it('macro-averages per-task lifts', () => {
    expect(macroSkillLift([1, 0, 0.5])).toBeCloseTo(0.5);
  });

  it('returns 0 for an empty list (missing baseline)', () => {
    expect(macroSkillLift([])).toBe(0);
  });
});

describe('skillInvocationRate', () => {
  it('is the share of trials where the expected skill was invoked', () => {
    expect(skillInvocationRate([true, true, false, false])).toBeCloseTo(0.5);
  });

  it('returns undefined when there are no eligible trials (e.g. only anti-trigger tasks)', () => {
    expect(skillInvocationRate([])).toBeUndefined();
  });
});

describe('groupMetrics', () => {
  it('groups per-task rates by key', () => {
    const grouped = groupMetrics([
      { keys: ['easy'], passed: [true, true] },
      { keys: ['easy'], passed: [false, false] },
      { keys: ['hard'], passed: [true, false] },
    ]);

    expect(grouped.easy.tasks).toBe(2);
    expect(grouped.easy.resolutionRate).toBeCloseTo(0.5);
    expect(grouped.easy.passAtK).toBeCloseTo(0.5);
    expect(grouped.hard.tasks).toBe(1);
    expect(grouped.hard.resolutionRate).toBeCloseTo(0.5);
    expect(grouped.hard.passAtK).toBe(1);
  });

  it('counts a task toward every tag it carries', () => {
    const grouped = groupMetrics([
      { keys: ['pdf', 'forms'], passed: [true] },
      { keys: ['pdf'], passed: [false] },
    ]);

    expect(grouped.pdf.tasks).toBe(2);
    expect(grouped.pdf.resolutionRate).toBeCloseTo(0.5);
    expect(grouped.forms.tasks).toBe(1);
    expect(grouped.forms.resolutionRate).toBe(1);
  });

  it('skips undefined keys', () => {
    const grouped = groupMetrics([
      { keys: [undefined], passed: [true] },
      { keys: ['docs'], passed: [true] },
    ]);

    expect(Object.keys(grouped)).toEqual(['docs']);
  });

  it('deduplicates repeated keys on a single task', () => {
    const grouped = groupMetrics([
      { keys: ['pdf', 'pdf'], passed: [true] },
    ]);

    expect(grouped.pdf.tasks).toBe(1);
  });

  it('returns an empty record for no tasks', () => {
    expect(groupMetrics([])).toEqual({});
  });
});
