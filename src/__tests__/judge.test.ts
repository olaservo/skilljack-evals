import { describe, it, expect } from 'vitest';
import { extractJsonObject, parseJudgeResponseJson } from '../scorer/judge.js';

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

describe('parseJudgeResponseJson', () => {
  const defaultWeights = new Map([
    ['discovery', 0.3],
    ['adherence', 0.4],
    ['output', 0.3],
  ]);

  it('parses a complete judge response with checklist results', () => {
    const response = JSON.stringify({
      discovery: 1,
      adherence: 5,
      output_quality: 4,
      failure_category: 'none',
      reasoning: 'Agent performed well',
      checklist_results: [
        { item: 'Used correct format', passed: true, evidence: 'Output matches expected format' },
        { item: 'Included header', passed: false, evidence: 'Header was missing' },
      ],
    });
    const score = parseJudgeResponseJson(response, 'task-1', defaultWeights);

    expect(score.taskId).toBe('task-1');
    expect(score.discovery).toBe(1);
    expect(score.adherence).toBe(5);
    expect(score.outputQuality).toBe(4);
    expect(score.failureCategory).toBe('none');
    expect(score.reasoning).toBe('Agent performed well');
    expect(score.checklistResults).toHaveLength(2);
    expect(score.checklistResults![0]).toEqual({
      item: 'Used correct format',
      passed: true,
      evidence: 'Output matches expected format',
    });
    expect(score.checklistResults![1]).toEqual({
      item: 'Included header',
      passed: false,
      evidence: 'Header was missing',
    });
  });

  it('parses response without checklist results', () => {
    const response = JSON.stringify({
      discovery: 1,
      adherence: 4,
      output_quality: 3,
      failure_category: 'none',
      reasoning: 'Decent output',
    });
    const score = parseJudgeResponseJson(response, 'task-2', defaultWeights);

    expect(score.checklistResults).toEqual([]);
    expect(score.adherence).toBe(4);
    expect(score.outputQuality).toBe(3);
  });

  it('filters out malformed checklist entries', () => {
    const response = JSON.stringify({
      discovery: 1,
      adherence: 5,
      output_quality: 5,
      failure_category: 'none',
      reasoning: 'Great',
      checklist_results: [
        { item: 'Valid item', passed: true, evidence: 'Yes' },
        { wrong_field: 'no item key' },
        'not an object',
        null,
        { item: 'Missing passed field' },
        { item: 'Also valid', passed: false },
      ],
    });
    const score = parseJudgeResponseJson(response, 'task-3', defaultWeights);

    expect(score.checklistResults).toHaveLength(2);
    expect(score.checklistResults![0].item).toBe('Valid item');
    expect(score.checklistResults![1].item).toBe('Also valid');
    expect(score.checklistResults![1].passed).toBe(false);
  });

  it('coerces non-standard types in checklist results', () => {
    const response = JSON.stringify({
      discovery: 1,
      adherence: 5,
      output_quality: 5,
      failure_category: 'none',
      reasoning: 'Ok',
      checklist_results: [
        { item: 123, passed: 1, evidence: 'coerced' },
        { item: 'text', passed: 0 },
      ],
    });
    const score = parseJudgeResponseJson(response, 'task-4', defaultWeights);

    expect(score.checklistResults).toHaveLength(2);
    expect(score.checklistResults![0].item).toBe('123');
    expect(score.checklistResults![0].passed).toBe(true);
    expect(score.checklistResults![0].evidence).toBe('coerced');
    expect(score.checklistResults![1].item).toBe('text');
    expect(score.checklistResults![1].passed).toBe(false);
    expect(score.checklistResults![1].evidence).toBeUndefined();
  });

  it('returns error score for unparseable response', () => {
    const score = parseJudgeResponseJson('no json here', 'task-5', defaultWeights);

    expect(score.discovery).toBe(0);
    expect(score.adherence).toBe(1);
    expect(score.outputQuality).toBe(1);
    expect(score.weightedScore).toBe(0);
    expect(score.failureCategory).toBe('agent_error');
    expect(score.reasoning).toContain('Failed to parse');
  });

  it('returns error score for invalid JSON', () => {
    const score = parseJudgeResponseJson('{not valid json}', 'task-6', defaultWeights);

    expect(score.failureCategory).toBe('agent_error');
    expect(score.reasoning).toContain('Invalid JSON');
  });

  it('returns error score for single-quoted JSON', () => {
    const score = parseJudgeResponseJson("{'discovery': 1}", 'task-sq', defaultWeights);

    expect(score.failureCategory).toBe('agent_error');
    expect(score.reasoning).toContain('Invalid JSON');
  });

  it('computes weighted score correctly', () => {
    const response = JSON.stringify({
      discovery: 1,
      adherence: 5,
      output_quality: 5,
      failure_category: 'none',
      reasoning: 'Perfect',
    });
    const score = parseJudgeResponseJson(response, 'task-7', defaultWeights);

    // discovery=1: 0.3*1 = 0.3
    // adherence=5: 0.4*((5-1)/4) = 0.4*1 = 0.4
    // output=5: 0.3*((5-1)/4) = 0.3*1 = 0.3
    // total = 1.0
    expect(score.weightedScore).toBeCloseTo(1.0);
  });

  it('handles response wrapped in markdown code block', () => {
    const json = JSON.stringify({
      discovery: 0,
      adherence: 2,
      output_quality: 1,
      failure_category: 'discovery_failure',
      reasoning: 'Skill not loaded',
    });
    const response = `Here is my evaluation:\n\`\`\`json\n${json}\n\`\`\`\nThat concludes the review.`;
    const score = parseJudgeResponseJson(response, 'task-8', defaultWeights);

    expect(score.discovery).toBe(0);
    expect(score.adherence).toBe(2);
    expect(score.failureCategory).toBe('discovery_failure');
  });
});
