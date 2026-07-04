import { describe, it, expect, vi, afterEach } from 'vitest';
import { scoreTask } from '../scorer/scorer.js';
import { SkillJudge } from '../scorer/judge.js';
import { DEFAULT_CONFIG } from '../config.js';
import { evaluatePassFail, computeFailureReasons } from '../report/report.js';
import type { EvalTask, EvaluationSummary, TaskResult } from '../types.js';
import { makeResult } from './fixtures/test-helpers.js';

function makeTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'task-1',
    prompt: 'Do something',
    expectedSkillLoad: 'test-skill',
    criteria: [
      { dimension: 'discovery', weight: 0.3, description: 'Found skill' },
      { dimension: 'adherence', weight: 0.4, description: 'Followed instructions' },
      { dimension: 'output', weight: 0.3, description: 'Quality output' },
    ],
    goldenChecklist: [],
    deterministic: { expectSkillActivation: true },
    ...overrides,
  };
}

function makeSkillResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return makeResult({
    skillLoads: ['test-skill'],
    toolCalls: [{ tool: 'Skill', toolUseId: '1', timestamp: 0, input: { skill: 'test-skill' } }],
    ...overrides,
  });
}

describe('judge is off by default', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DEFAULT_CONFIG.judgeEnabled is false', () => {
    expect(DEFAULT_CONFIG.judgeEnabled).toBe(false);
  });

  it('scoreTask does not call the judge without judgeEnabled', async () => {
    const judgeSpy = vi.spyOn(SkillJudge.prototype, 'judgeResult');

    const score = await scoreTask(makeTask(), makeSkillResult());

    expect(judgeSpy).not.toHaveBeenCalled();
    expect(score.judge).toBeNull();
    expect(score.adherence).toBeUndefined();
    expect(score.outputQuality).toBeUndefined();
  });

  it('scoreTask calls the judge when judgeEnabled is set', async () => {
    const judgeSpy = vi.spyOn(SkillJudge.prototype, 'judgeResult').mockResolvedValue({
      taskId: 'task-1',
      discovery: 1,
      adherence: 4,
      outputQuality: 3,
      failureCategory: 'none',
      reasoning: 'diag',
      checklistResults: [],
    });

    const score = await scoreTask(makeTask(), makeSkillResult(), { judgeEnabled: true });

    expect(judgeSpy).toHaveBeenCalledOnce();
    expect(score.judge).not.toBeNull();
    expect(score.adherence).toBe(4);
    expect(score.outputQuality).toBe(3);
  });

  it('judge ratings never affect passed/reward', async () => {
    vi.spyOn(SkillJudge.prototype, 'judgeResult').mockResolvedValue({
      taskId: 'task-1',
      discovery: 0,
      adherence: 1,
      outputQuality: 1,
      failureCategory: 'agent_error',
      reasoning: 'judge hated it',
      checklistResults: [],
    });

    // Deterministic passes (skill activated) → passed stays true despite judge 1/5s.
    const score = await scoreTask(makeTask(), makeSkillResult(), { judgeEnabled: true });

    expect(score.passed).toBe(true);
    expect(score.reward).toBe(1);
  });
});

describe('trial reward derivation', () => {
  it('passes when all deterministic checks pass', async () => {
    const score = await scoreTask(makeTask(), makeSkillResult());
    expect(score.passed).toBe(true);
    expect(score.reward).toBe(1);
    expect(score.failureCategory).toBe('none');
  });

  it('fails with reward 0 on agent error', async () => {
    const score = await scoreTask(makeTask(), makeResult({ isError: true, errorMessage: 'timeout' }));
    expect(score.passed).toBe(false);
    expect(score.reward).toBe(0);
    expect(score.failureCategory).toBe('agent_error');
  });

  it('fails with discovery_failure when the skill was not activated', async () => {
    const score = await scoreTask(makeTask(), makeResult({ skillLoads: [], toolCalls: [] }));
    expect(score.passed).toBe(false);
    expect(score.reward).toBe(0);
    expect(score.failureCategory).toBe('discovery_failure');
    expect(score.invocation).toBe(0);
  });

  it('carries the verifier partial reward on failure', async () => {
    const result = makeSkillResult({
      verifier: { reward: 0.5, passed: false, exitCode: 0, status: 'ok', stdout: '', stderr: '', durationMs: 5 },
    });
    const score = await scoreTask(makeTask(), result);
    expect(score.passed).toBe(false);
    expect(score.reward).toBe(0.5);
  });

  it('sets invocation only for invocation-expecting tasks', async () => {
    const antiTask = makeTask({
      expectedSkillLoad: 'none',
      deterministic: { expectSkillActivation: false },
    });
    const score = await scoreTask(antiTask, makeResult({ skillLoads: [], toolCalls: [] }));
    expect(score.invocation).toBeUndefined();
    expect(score.passed).toBe(true);
    expect(score.discovery).toBe(1); // correctly did not activate
  });

  it('baseline mode scores output checks without an activation gate', async () => {
    const task = makeTask({
      deterministic: { expectSkillActivation: true, expectContains: ['hello'] },
    });
    // No skill activated (baseline mounts no skills) but the output satisfies the checks.
    const score = await scoreTask(task, makeResult({ output: 'hello world', skillLoads: [], toolCalls: [] }), { isBaseline: true });
    expect(score.passed).toBe(true);
    expect(score.reward).toBe(1);
    expect(score.invocation).toBeUndefined();
  });
});

describe('evaluatePassFail (report thresholds)', () => {
  function makeSummary(resolutionRate: number): EvaluationSummary {
    return {
      totalTasks: 2,
      numRuns: 1,
      resolutionRate,
      resolutionCI: { low: 0, high: 1 },
      passAtK: resolutionRate,
      totalDurationMs: 0,
      totalCostUsd: 0,
    };
  }

  it('gates on the resolution threshold', () => {
    const config = { ...DEFAULT_CONFIG, resolutionThreshold: 0.8 };
    expect(evaluatePassFail(makeSummary(0.79), config).passed).toBe(false);
    expect(evaluatePassFail(makeSummary(0.8), config).passed).toBe(true);
  });

  it('does not gate lift without a threshold', () => {
    const result = evaluatePassFail(makeSummary(1), DEFAULT_CONFIG, -1);
    expect(result.liftPassed).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('gates lift when threshold and lift are both present', () => {
    const config = { ...DEFAULT_CONFIG, resolutionThreshold: 0.5, liftThreshold: 0.2 };
    expect(evaluatePassFail(makeSummary(1), config, 0.1).passed).toBe(false);
    expect(evaluatePassFail(makeSummary(1), config, 0.25).passed).toBe(true);
  });

  it('computeFailureReasons names the failing gates', () => {
    const config = { ...DEFAULT_CONFIG, resolutionThreshold: 0.8, liftThreshold: 0.2 };
    const reasons = computeFailureReasons(makeSummary(0.5), config, 0.1);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('Resolution rate 50.0% below threshold 80%');
    expect(reasons[1]).toContain('Skill lift +10.0% below threshold +20.0%');
  });
});
