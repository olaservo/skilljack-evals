import { describe, it, expect } from 'vitest';
import {
  qualityImpact,
  DISCOVERY_IMPACT_THRESHOLD,
  ADHERENCE_IMPACT_THRESHOLD,
  OUTPUT_QUALITY_IMPACT_THRESHOLD,
  WEIGHTED_SCORE_IMPACT_THRESHOLD,
} from '../report/report.js';

describe('qualityImpact', () => {
  it('classifies positive delta above threshold', () => {
    expect(qualityImpact(0.06, DISCOVERY_IMPACT_THRESHOLD)).toBe('Positive');
    expect(qualityImpact(0.25, ADHERENCE_IMPACT_THRESHOLD)).toBe('Positive');
    expect(qualityImpact(0.25, OUTPUT_QUALITY_IMPACT_THRESHOLD)).toBe('Positive');
    expect(qualityImpact(0.06, WEIGHTED_SCORE_IMPACT_THRESHOLD)).toBe('Positive');
  });

  it('classifies negative delta below threshold', () => {
    expect(qualityImpact(-0.06, DISCOVERY_IMPACT_THRESHOLD)).toBe('Negative');
    expect(qualityImpact(-0.25, ADHERENCE_IMPACT_THRESHOLD)).toBe('Negative');
    expect(qualityImpact(-0.25, OUTPUT_QUALITY_IMPACT_THRESHOLD)).toBe('Negative');
    expect(qualityImpact(-0.06, WEIGHTED_SCORE_IMPACT_THRESHOLD)).toBe('Negative');
  });

  it('classifies delta within threshold as Neutral', () => {
    expect(qualityImpact(0.04, DISCOVERY_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-0.04, DISCOVERY_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(0.15, ADHERENCE_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-0.15, OUTPUT_QUALITY_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(0.03, WEIGHTED_SCORE_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(0, DISCOVERY_IMPACT_THRESHOLD)).toBe('Neutral');
  });

  it('classifies exact threshold value as Neutral (not strictly greater)', () => {
    expect(qualityImpact(DISCOVERY_IMPACT_THRESHOLD, DISCOVERY_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-DISCOVERY_IMPACT_THRESHOLD, DISCOVERY_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(ADHERENCE_IMPACT_THRESHOLD, ADHERENCE_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-ADHERENCE_IMPACT_THRESHOLD, ADHERENCE_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(OUTPUT_QUALITY_IMPACT_THRESHOLD, OUTPUT_QUALITY_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-OUTPUT_QUALITY_IMPACT_THRESHOLD, OUTPUT_QUALITY_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(WEIGHTED_SCORE_IMPACT_THRESHOLD, WEIGHTED_SCORE_IMPACT_THRESHOLD)).toBe('Neutral');
    expect(qualityImpact(-WEIGHTED_SCORE_IMPACT_THRESHOLD, WEIGHTED_SCORE_IMPACT_THRESHOLD)).toBe('Neutral');
  });
});

describe('impact threshold values', () => {
  it('are calibrated to ~5% of each scale range', () => {
    expect(DISCOVERY_IMPACT_THRESHOLD).toBe(0.05);       // 5% of 0-1 range
    expect(ADHERENCE_IMPACT_THRESHOLD).toBe(0.20);       // 5% of 1-5 range (range = 4)
    expect(OUTPUT_QUALITY_IMPACT_THRESHOLD).toBe(0.20);  // 5% of 1-5 range (range = 4)
    expect(WEIGHTED_SCORE_IMPACT_THRESHOLD).toBe(0.05);  // 5% of 0-1 range
  });
});
