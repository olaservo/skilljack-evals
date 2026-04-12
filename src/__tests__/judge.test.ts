import { describe, it, expect, vi } from 'vitest';
import { extractJsonObject, parseJudgeResponseJson, parseBlindJudgeResponse, BASELINE_JUDGE_PROMPT_TEMPLATE, SkillJudge } from '../scorer/judge.js';

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
    expect(score.checklistResults[0]).toEqual({
      item: 'Used correct format',
      passed: true,
      evidence: 'Output matches expected format',
    });
    expect(score.checklistResults[1]).toEqual({
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
    expect(score.checklistResults[0].item).toBe('Valid item');
    expect(score.checklistResults[1].item).toBe('Also valid');
    expect(score.checklistResults[1].passed).toBe(false);
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
    expect(score.checklistResults[0].item).toBe('123');
    expect(score.checklistResults[0].passed).toBe(true);
    expect(score.checklistResults[0].evidence).toBe('coerced');
    expect(score.checklistResults[1].item).toBe('text');
    expect(score.checklistResults[1].passed).toBe(false);
    expect(score.checklistResults[1].evidence).toBeUndefined();
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

  it('returns error score for single-quoted JSON with valid structure', () => {
    const response = "{'discovery': 1, 'adherence': 5, 'output_quality': 4, 'failure_category': 'none', 'reasoning': 'Good'}";
    const score = parseJudgeResponseJson(response, 'task-sq2', defaultWeights);

    expect(score.failureCategory).toBe('agent_error');
    expect(score.reasoning).toContain('Invalid JSON');
    expect(score.discovery).toBe(0);
    expect(score.weightedScore).toBe(0);
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

  it('falls back to agent_error for unknown failure category', () => {
    const response = JSON.stringify({
      discovery: 1,
      adherence: 3,
      output_quality: 3,
      failure_category: 'hallucinated_category',
      reasoning: 'Some issue',
    });
    const score = parseJudgeResponseJson(response, 'task-fc', defaultWeights);

    expect(score.failureCategory).toBe('agent_error');
  });

  it('accepts all valid failure categories', () => {
    const categories = [
      'discovery_failure',
      'false_positive',
      'instruction_ambiguity',
      'missing_guidance',
      'agent_error',
      'none',
    ];
    for (const cat of categories) {
      const response = JSON.stringify({
        discovery: 1,
        adherence: 5,
        output_quality: 5,
        failure_category: cat,
        reasoning: 'test',
      });
      const score = parseJudgeResponseJson(response, `task-${cat}`, defaultWeights);
      expect(score.failureCategory).toBe(cat);
    }
  });

  it('falls back to agent_error when failure_category is missing', () => {
    const response = JSON.stringify({
      discovery: 1,
      adherence: 3,
      output_quality: 3,
      reasoning: 'No category provided',
    });
    const score = parseJudgeResponseJson(response, 'task-nocat', defaultWeights);

    expect(score.failureCategory).toBe('agent_error');
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

describe('parseBlindJudgeResponse', () => {
  it('parses a valid response', () => {
    const response = JSON.stringify({
      output_a: { instruction_following: 4, output_quality: 5 },
      output_b: { instruction_following: 3, output_quality: 2 },
      preferred: 'A',
      reasoning: 'Output A is better',
    });
    const result = parseBlindJudgeResponse(response);

    expect(result).not.toBeNull();
    expect(result!.outputA.instructionFollowing).toBe(4);
    expect(result!.outputA.outputQuality).toBe(5);
    expect(result!.outputB.instructionFollowing).toBe(3);
    expect(result!.outputB.outputQuality).toBe(2);
    expect(result!.preferred).toBe('A');
    expect(result!.reasoning).toBe('Output A is better');
  });

  it('parses response wrapped in markdown code block', () => {
    const json = JSON.stringify({
      output_a: { instruction_following: 5, output_quality: 5 },
      output_b: { instruction_following: 4, output_quality: 4 },
      preferred: 'A',
      reasoning: 'Better quality',
    });
    const response = `\`\`\`json\n${json}\n\`\`\``;
    const result = parseBlindJudgeResponse(response);

    expect(result).not.toBeNull();
    expect(result!.outputA.instructionFollowing).toBe(5);
    expect(result!.preferred).toBe('A');
  });

  it('returns null on unparseable input', () => {
    expect(parseBlindJudgeResponse('no json here')).toBeNull();
    expect(parseBlindJudgeResponse('')).toBeNull();
  });

  it('clamps scores to 1-5', () => {
    const response = JSON.stringify({
      output_a: { instruction_following: 0, output_quality: 7 },
      output_b: { instruction_following: -1, output_quality: 10 },
      preferred: 'B',
      reasoning: 'Test clamping',
    });
    const result = parseBlindJudgeResponse(response);

    expect(result).not.toBeNull();
    expect(result!.outputA.instructionFollowing).toBe(1);
    expect(result!.outputA.outputQuality).toBe(5);
    expect(result!.outputB.instructionFollowing).toBe(1);
    expect(result!.outputB.outputQuality).toBe(5);
  });

  it('normalizes preferred to uppercase, fallback to tie', () => {
    const makeResponse = (pref: string) => JSON.stringify({
      output_a: { instruction_following: 3, output_quality: 3 },
      output_b: { instruction_following: 3, output_quality: 3 },
      preferred: pref,
      reasoning: 'test',
    });

    expect(parseBlindJudgeResponse(makeResponse('a'))!.preferred).toBe('A');
    expect(parseBlindJudgeResponse(makeResponse('b'))!.preferred).toBe('B');
    expect(parseBlindJudgeResponse(makeResponse('TIE'))!.preferred).toBe('tie');
    expect(parseBlindJudgeResponse(makeResponse('neither'))!.preferred).toBe('tie');
    expect(parseBlindJudgeResponse(makeResponse(''))!.preferred).toBe('tie');
  });

  it('returns null when output_a or output_b is missing', () => {
    const noA = JSON.stringify({
      output_b: { instruction_following: 3, output_quality: 3 },
      preferred: 'B',
      reasoning: 'missing a',
    });
    expect(parseBlindJudgeResponse(noA)).toBeNull();

    const noB = JSON.stringify({
      output_a: { instruction_following: 3, output_quality: 3 },
      preferred: 'A',
      reasoning: 'missing b',
    });
    expect(parseBlindJudgeResponse(noB)).toBeNull();
  });

  it('defaults missing fields gracefully', () => {
    const response = JSON.stringify({
      output_a: { instruction_following: 4 },
      output_b: { output_quality: 3 },
      preferred: 'A',
    });
    const result = parseBlindJudgeResponse(response);

    expect(result).not.toBeNull();
    // Missing output_quality defaults to 1 (NaN clamp)
    expect(result!.outputA.outputQuality).toBe(1);
    // Missing instruction_following defaults to 1 (NaN clamp)
    expect(result!.outputB.instructionFollowing).toBe(1);
    // Missing reasoning defaults to empty string
    expect(result!.reasoning).toBe('');
  });
});

describe('BASELINE_JUDGE_PROMPT_TEMPLATE', () => {
  it('does not reference expectedSkill or goldenChecklist placeholders', () => {
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).not.toContain('{expectedSkill}');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).not.toContain('{checklistText}');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).not.toContain('{checklistScoringInstructions}');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).not.toContain('{checklistJsonField}');
  });

  it('identifies itself as a no-skill baseline evaluation', () => {
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('NO-SKILL BASELINE');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('baseline');
  });

  it('instructs discovery to always be 0', () => {
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('Discovery (always 0)');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('"discovery": 0');
  });

  it('scores adherence against task prompt, not skill instructions', () => {
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain("task prompt's instructions");
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).not.toContain("skill's instructions");
  });

  it('contains required substitution placeholders', () => {
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('{prompt}');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('{criteriaText}');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('{skillLoads}');
    expect(BASELINE_JUDGE_PROMPT_TEMPLATE).toContain('{output}');
  });
});

describe('scoreTask passes isBaseline to SkillJudge', () => {
  const task = {
    id: 'test-1',
    prompt: 'Do something',
    expectedSkillLoad: 'some-skill',
    criteria: [
      { dimension: 'discovery' as const, weight: 0.3, description: 'Found skill' },
      { dimension: 'adherence' as const, weight: 0.4, description: 'Followed instructions' },
      { dimension: 'output' as const, weight: 0.3, description: 'Quality output' },
    ],
    goldenChecklist: [],
  };

  const result = {
    taskId: 'test-1',
    prompt: 'Do something',
    output: 'some output',
    durationMs: 1000,
    numTurns: 1,
    costUsd: 0.01,
    skillLoads: [],
    toolCalls: [],
    isError: false,
    errorMessage: '',
  };

  it('constructs SkillJudge with isBaseline=true when isBaseline option is set', async () => {
    const mockScore = {
      taskId: 'test-1',
      discovery: 0,
      adherence: 3,
      outputQuality: 3,
      weightedScore: 0.5,
      failureCategory: 'none' as const,
      reasoning: 'baseline',
      checklistResults: [],
    };
    let capturedInstance: any;
    const judgeResultSpy = vi.spyOn(SkillJudge.prototype, 'judgeResult').mockImplementation(
      async function (this: SkillJudge) {
        capturedInstance = this;
        return mockScore;
      }
    );

    const { scoreTask } = await import('../scorer/scorer.js');
    await scoreTask(task, result, { isBaseline: true });

    expect(capturedInstance.options.isBaseline).toBe(true);
    judgeResultSpy.mockRestore();
  });

  it('constructs SkillJudge with isBaseline=false by default', async () => {
    const mockScore = {
      taskId: 'test-1',
      discovery: 0,
      adherence: 3,
      outputQuality: 3,
      weightedScore: 0.5,
      failureCategory: 'none' as const,
      reasoning: 'standard',
      checklistResults: [],
    };
    let capturedInstance: any;
    const judgeResultSpy = vi.spyOn(SkillJudge.prototype, 'judgeResult').mockImplementation(
      async function (this: SkillJudge) {
        capturedInstance = this;
        return mockScore;
      }
    );

    const { scoreTask } = await import('../scorer/scorer.js');
    await scoreTask(task, result, {});

    expect(capturedInstance.options.isBaseline).toBe(false);
    judgeResultSpy.mockRestore();
  });
});

describe('parseJudgeResponseJson with baseline-style response', () => {
  const defaultWeights = new Map([
    ['discovery', 0.3],
    ['adherence', 0.4],
    ['output', 0.3],
  ]);

  it('handles baseline response with discovery=0 and no checklist', () => {
    const response = JSON.stringify({
      discovery: 0,
      adherence: 4,
      output_quality: 4,
      failure_category: 'none',
      reasoning: 'Agent followed prompt well without any skill',
    });
    const score = parseJudgeResponseJson(response, 'baseline-1', defaultWeights);

    expect(score.taskId).toBe('baseline-1');
    expect(score.discovery).toBe(0);
    expect(score.adherence).toBe(4);
    expect(score.outputQuality).toBe(4);
    expect(score.failureCategory).toBe('none');
    expect(score.checklistResults).toEqual([]);

    // discovery=0: 0.3*0 = 0
    // adherence=4: 0.4*((4-1)/4) = 0.4*0.75 = 0.3
    // output=4: 0.3*((4-1)/4) = 0.3*0.75 = 0.225
    // total = 0.525
    expect(score.weightedScore).toBeCloseTo(0.525);
  });

  it('computes correct weighted score for high-quality baseline', () => {
    const response = JSON.stringify({
      discovery: 0,
      adherence: 5,
      output_quality: 5,
      failure_category: 'none',
      reasoning: 'Excellent output without skill',
    });
    const score = parseJudgeResponseJson(response, 'baseline-2', defaultWeights);

    // discovery=0: 0.3*0 = 0
    // adherence=5: 0.4*1 = 0.4
    // output=5: 0.3*1 = 0.3
    // total = 0.7
    expect(score.weightedScore).toBeCloseTo(0.7);
  });
});
