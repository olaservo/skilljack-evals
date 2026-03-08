import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../scorer/judge.js';

describe('extractJsonObject', () => {
  it('extracts a simple JSON object', () => {
    const result = extractJsonObject('{"a": 1}');
    expect(result).toBe('{"a": 1}');
  });

  it('extracts JSON from surrounding text', () => {
    const result = extractJsonObject('Here is the result: {"score": 5} done.');
    expect(result).toBe('{"score": 5}');
  });

  it('extracts JSON from a code block', () => {
    const result = extractJsonObject('```json\n{"a": {"b": 1}}\n```');
    expect(result).toBe('{"a": {"b": 1}}');
  });

  it('handles nested objects', () => {
    const input = '{"outer": {"inner": {"deep": true}}, "flat": 1}';
    expect(extractJsonObject(input)).toBe(input);
  });

  it('handles braces inside strings', () => {
    const input = '{"msg": "use { and }"}';
    expect(extractJsonObject(input)).toBe(input);
  });

  it('handles escaped quotes inside strings', () => {
    const input = '{"msg": "he said \\"hello\\""}';
    expect(extractJsonObject(input)).toBe(input);
  });

  it('handles checklist_results with nested array of objects', () => {
    const input = JSON.stringify({
      discovery: 1,
      adherence: 5,
      output_quality: 4,
      failure_category: 'none',
      reasoning: 'Good job',
      checklist_results: [
        { item: 'Did X', passed: true, evidence: 'Found X in output' },
        { item: 'Did Y', passed: false, evidence: 'Y was missing' },
      ],
    });
    const result = extractJsonObject(input);
    expect(result).toBe(input);
    expect(JSON.parse(result!).checklist_results).toHaveLength(2);
  });

  it('extracts JSON with checklist from markdown code block', () => {
    const wrapped = '```json\n' + JSON.stringify({
      discovery: 1,
      checklist_results: [{ item: 'test', passed: true, evidence: 'ok' }],
    }) + '\n```';
    const result = extractJsonObject(wrapped);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.checklist_results[0].item).toBe('test');
  });

  it('returns null when no JSON present', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJsonObject('')).toBeNull();
  });

  it('returns null for unbalanced braces', () => {
    expect(extractJsonObject('{"a": 1')).toBeNull();
  });

  it('handles strings with escaped backslashes', () => {
    const input = '{"path": "C:\\\\Users\\\\test"}';
    expect(extractJsonObject(input)).toBe(input);
  });
});
