import { describe, it, expect } from 'vitest';
import { formatDelta } from '../utils/format.js';

describe('formatDelta', () => {
  it('formats positive values with + prefix', () => {
    expect(formatDelta(1.5)).toBe('+1.50');
    expect(formatDelta(0.1)).toBe('+0.10');
  });

  it('formats negative values with - prefix', () => {
    expect(formatDelta(-1.5)).toBe('-1.50');
    expect(formatDelta(-0.01)).toBe('-0.01');
  });

  it('formats zero without sign prefix', () => {
    expect(formatDelta(0)).toBe('0.00');
  });

  it('respects custom decimal places', () => {
    expect(formatDelta(1.234, 1)).toBe('+1.2');
    expect(formatDelta(-0.56789, 4)).toBe('-0.5679');
    expect(formatDelta(0, 3)).toBe('0.000');
    expect(formatDelta(0, 0)).toBe('0');
  });

  it('handles large values', () => {
    expect(formatDelta(1000)).toBe('+1000.00');
    expect(formatDelta(-9999.99)).toBe('-9999.99');
  });

  it('handles very small values', () => {
    expect(formatDelta(0.001)).toBe('+0.00');
    expect(formatDelta(0.001, 3)).toBe('+0.001');
    expect(formatDelta(-0.0001, 4)).toBe('-0.0001');
  });
});
