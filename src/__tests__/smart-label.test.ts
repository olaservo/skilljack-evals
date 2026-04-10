import { describe, it, expect } from 'vitest';
import { smartLabel } from '../pipeline.js';

describe('smartLabel', () => {
  it('returns last two path components for deep paths', () => {
    expect(smartLabel('/home/user/v1/skills')).toBe('v1/skills');
    expect(smartLabel('/path/to/some/skill-v1')).toBe('some/skill-v1');
  });

  it('disambiguates paths with same basename', () => {
    expect(smartLabel('/repo/v1/skills')).toBe('v1/skills');
    expect(smartLabel('/repo/v2/skills')).toBe('v2/skills');
  });

  it('returns basename for single-component paths', () => {
    expect(smartLabel('skills')).toBe('skills');
  });

  it('returns last two components for two-component paths', () => {
    expect(smartLabel('v1/skills')).toBe('v1/skills');
  });

  it('handles trailing separators', () => {
    expect(smartLabel('/path/to/v1/skills/')).toBe('v1/skills');
  });

  it('handles relative paths', () => {
    expect(smartLabel('./v1/skills')).toBe('v1/skills');
    expect(smartLabel('../other/v2/skills')).toBe('v2/skills');
  });
});
