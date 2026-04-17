import { describe, it, expect } from 'vitest';
import { withConcurrencyLimit, DEFAULT_CONCURRENCY, DEFAULT_RUNNER_CONCURRENCY } from '../utils/concurrency.js';

describe('withConcurrencyLimit', () => {
  it('returns empty array for empty input', async () => {
    const results = await withConcurrencyLimit([], 3);
    expect(results).toEqual([]);
  });

  it('runs tasks sequentially with limit=1', async () => {
    const order: number[] = [];
    const factories = [0, 1, 2].map((i) => async () => {
      order.push(i);
      return i * 10;
    });

    const results = await withConcurrencyLimit(factories, 1);
    expect(results).toEqual([0, 10, 20]);
    expect(order).toEqual([0, 1, 2]);
  });

  it('respects bounded concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const limit = 2;

    const factories = Array.from({ length: 5 }, (_, i) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield to let other workers start if they can
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return i;
    });

    const results = await withConcurrencyLimit(factories, limit);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBeLessThanOrEqual(limit);
    expect(maxActive).toBe(limit);
  });

  it('runs all tasks at once with limit=0 (unlimited)', async () => {
    let active = 0;
    let maxActive = 0;
    const count = 5;

    const factories = Array.from({ length: count }, (_, i) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return i;
    });

    const results = await withConcurrencyLimit(factories, 0);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBe(count);
  });

  it('preserves result order regardless of completion order', async () => {
    // Tasks complete in reverse order but results should match input order
    const factories = [0, 1, 2, 3].map((i) => async () => {
      await new Promise((r) => setTimeout(r, (3 - i) * 10));
      return `task-${i}`;
    });

    const results = await withConcurrencyLimit(factories, 4);
    expect(results).toEqual(['task-0', 'task-1', 'task-2', 'task-3']);
  });

  it('propagates errors from failing factories', async () => {
    const factories = [
      async () => 'ok',
      async () => { throw new Error('boom'); },
      async () => 'also ok',
    ];

    await expect(withConcurrencyLimit(factories, 2)).rejects.toThrow('boom');
  });

  it('handles limit larger than factory count', async () => {
    const factories = [async () => 1, async () => 2];
    const results = await withConcurrencyLimit(factories, 100);
    expect(results).toEqual([1, 2]);
  });

  it('throws RangeError for negative limit', async () => {
    const factories = [async () => 1];
    await expect(withConcurrencyLimit(factories, -1)).rejects.toThrow(RangeError);
    await expect(withConcurrencyLimit(factories, -5)).rejects.toThrow('Concurrency limit must be >= 0');
  });
});

describe('constants', () => {
  it('DEFAULT_CONCURRENCY is 5 (for judge)', () => {
    expect(DEFAULT_CONCURRENCY).toBe(5);
  });

  it('DEFAULT_RUNNER_CONCURRENCY is 1 (sequential)', () => {
    expect(DEFAULT_RUNNER_CONCURRENCY).toBe(1);
  });
});
