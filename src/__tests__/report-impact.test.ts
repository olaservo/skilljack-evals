import { describe, it, expect } from 'vitest';
import {
  qualityImpact,
  RESOLUTION_IMPACT_THRESHOLD,
} from '../report/report.js';

describe('qualityImpact', () => {
  it('classifies positive delta above threshold', () => {
    expect(qualityImpact(0.06, RESOLUTION_IMPACT_THRESHOLD)).toBe('Positive');
    expect(qualityImpact(0.5, RESOLUTION_IMPACT_THRESHOLD)).toBe('Positive');
  });

  it('classifies negative delta below threshold', () => {
    expect(qualityImpact(-0.06, RESOLUTION_IMPACT_THRESHOLD)).toBe('Negative');
    expect(qualityImpact(-0.5, RESOLUTION_IMPACT_THRESHOLD)).toBe('Negative');
  });

  it('classifies delta within threshold as Neutral', () => {
    expect(qualityImpact(0.04, RESOLUTION_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-0.04, RESOLUTION_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(0, RESOLUTION_IMPACT_THRESHOLD)).toBe('Neutral');
  });

  it('classifies exact threshold value as Neutral (not strictly greater)', () => {
    expect(qualityImpact(RESOLUTION_IMPACT_THRESHOLD, RESOLUTION_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-RESOLUTION_IMPACT_THRESHOLD, RESOLUTION_IMPACT_THRESHOLD)).toBe('Neutral');
  });
});

describe('impact threshold values', () => {
  it('is calibrated to 5% of the 0-1 resolution range', () => {
    expect(RESOLUTION_IMPACT_THRESHOLD).toBe(0.05);
  });
});
