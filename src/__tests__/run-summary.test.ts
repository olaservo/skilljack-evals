import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildRunSummary, writeRunSummary, evaluateThresholds, collectFailedChecks } from '../results/summary.js';
import type { PhaseTrialData } from '../results/summary.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { EvalConfig } from '../config.js';
import type { DeterministicResult, EvalTask } from '../types.js';
import { makeResult, makeScore } from './fixtures/test-helpers.js';

function makeTask(id: string, overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id,
    prompt: `prompt for ${id}`,
    expectedSkillLoad: 'test-skill',
    criteria: [],
    goldenChecklist: [],
    difficulty: 'medium',
    ...overrides,
  };
}

function makeDet(overrides: Partial<DeterministicResult> = {}): DeterministicResult {
  return {
    skillActivated: true,
    skillName: 'test-skill',
    markerFound: null,
    expectedToolsCalled: null,
    unexpectedToolsCalled: null,
    containsCheckPassed: null,
    notContainsCheckPassed: null,
    regexCheckPassed: null,
    javascriptCheckPassed: null,
    fileExistsCheckPassed: null,
    verifierPassed: null,
    passed: true,
    details: [],
    ...overrides,
  };
}

/** Two tasks × two trials: task-1 passes both, task-2 passes once. */
function makeWithSkillData(): PhaseTrialData {
  return {
    allResults: [
      [makeResult({ taskId: 'task-1' }), makeResult({ taskId: 'task-2' })],
      [makeResult({ taskId: 'task-1' }), makeResult({ taskId: 'task-2' })],
    ],
    allScores: [
      [
        makeScore({ taskId: 'task-1', passed: true, reward: 1, invocation: 1 }),
        makeScore({ taskId: 'task-2', passed: true, reward: 1, invocation: 1 }),
      ],
      [
        makeScore({ taskId: 'task-1', passed: true, reward: 1, invocation: 1 }),
        makeScore({
          taskId: 'task-2',
          passed: false,
          reward: 0,
          invocation: 0,
          failureCategory: 'discovery_failure',
          deterministic: makeDet({
            skillActivated: false,
            passed: false,
            details: ['Expected skill activation but no skill was loaded'],
          }),
        }),
      ],
    ],
  };
}

function makeBaselineData(): PhaseTrialData {
  return {
    allResults: [
      [makeResult({ taskId: 'task-1' }), makeResult({ taskId: 'task-2' })],
      [makeResult({ taskId: 'task-1' }), makeResult({ taskId: 'task-2' })],
    ],
    allScores: [
      [
        makeScore({ taskId: 'task-1', passed: false, reward: 0 }),
        makeScore({ taskId: 'task-2', passed: false, reward: 0 }),
      ],
      [
        makeScore({ taskId: 'task-1', passed: true, reward: 1 }),
        makeScore({ taskId: 'task-2', passed: false, reward: 0 }),
      ],
    ],
  };
}

function build(config: EvalConfig = DEFAULT_CONFIG, withBaseline = true) {
  return buildRunSummary({
    tasks: [
      makeTask('task-1', { difficulty: 'easy', category: 'docs', tags: ['pdf'] }),
      makeTask('task-2', { difficulty: 'hard', category: 'docs' }),
    ],
    skillName: 'test-skill',
    withSkill: makeWithSkillData(),
    baseline: withBaseline ? makeBaselineData() : undefined,
    baselineLabel: withBaseline ? 'No Skill' : undefined,
    config,
    nudge: 'off',
    trials: 2,
    judgeEnabled: false,
  });
}

describe('buildRunSummary', () => {
  it('produces the summary.json contract shape', () => {
    const summary = build();

    expect(summary.version).toBe(2);
    expect(summary.run).toMatchObject({
      skillName: 'test-skill',
      runner: 'claude-sdk',
      model: 'sonnet',
      nudge: 'off',
      trials: 2,
      baseline: true,
      baselineLabel: 'No Skill',
      judge: false,
    });
    expect(typeof summary.run.timestamp).toBe('string');
    expect(summary.tasks).toHaveLength(2);
    expect(summary.metrics.byDifficulty).toBeDefined();
    expect(summary.metrics.byCategory).toBeDefined();
    expect(summary.thresholds.passed).toBeDefined();
  });

  it('computes with-skill condition stats per task', () => {
    const summary = build();
    const task1 = summary.tasks.find((t) => t.id === 'task-1')!;
    const task2 = summary.tasks.find((t) => t.id === 'task-2')!;

    expect(task1.withSkill).toEqual({ passed: [true, true], rewards: [1, 1], resolutionRate: 1, passAtK: true });
    expect(task2.withSkill).toEqual({ passed: [true, false], rewards: [1, 0], resolutionRate: 0.5, passAtK: true });
  });

  it('computes per-task and macro skill lift when the baseline ran', () => {
    const summary = build();
    const task1 = summary.tasks.find((t) => t.id === 'task-1')!;
    const task2 = summary.tasks.find((t) => t.id === 'task-2')!;

    expect(task1.baseline!.resolutionRate).toBeCloseTo(0.5);
    expect(task1.lift).toBeCloseTo(0.5);
    expect(task2.baseline!.resolutionRate).toBe(0);
    expect(task2.lift).toBeCloseTo(0.5);
    expect(summary.metrics.skillLift).toBeCloseTo(0.5);
  });

  it('omits lift and baseline when no baseline ran', () => {
    const summary = build(DEFAULT_CONFIG, false);

    expect(summary.run.baseline).toBe(false);
    expect(summary.metrics.skillLift).toBeUndefined();
    expect(summary.tasks[0].baseline).toBeUndefined();
    expect(summary.tasks[0].lift).toBeUndefined();
  });

  it('computes headline metrics with CI over all with-skill trials', () => {
    const summary = build();

    expect(summary.metrics.resolutionRate).toBeCloseTo(0.75);
    expect(summary.metrics.passAtK).toBe(1);
    expect(summary.metrics.ci.low).toBeGreaterThanOrEqual(0);
    expect(summary.metrics.ci.high).toBeLessThanOrEqual(1);
    expect(summary.metrics.ci.low).toBeLessThan(summary.metrics.resolutionRate);
    expect(summary.metrics.ci.high).toBeGreaterThan(summary.metrics.resolutionRate);
  });

  it('computes the skill invocation rate over invocation-expecting tasks', () => {
    const summary = build();

    // 4 with-skill trials, 3 invoked
    expect(summary.metrics.skillInvocationRate).toBeCloseTo(0.75);
    expect(summary.tasks[0].invocationRate).toBe(1);
    expect(summary.tasks[1].invocationRate).toBeCloseTo(0.5);
  });

  it('excludes anti-trigger tasks from the invocation rate', () => {
    const summary = buildRunSummary({
      tasks: [makeTask('anti', { expectedSkillLoad: 'none' })],
      skillName: 'test-skill',
      withSkill: {
        allResults: [[makeResult({ taskId: 'anti' })]],
        allScores: [[makeScore({ taskId: 'anti', passed: true, reward: 1, invocation: undefined })]],
      },
      config: DEFAULT_CONFIG,
      nudge: 'off',
      trials: 1,
      judgeEnabled: false,
    });

    expect(summary.metrics.skillInvocationRate).toBeUndefined();
    expect(summary.tasks[0].invocationRate).toBeUndefined();
  });

  it('carries concrete failure evidence per failing trial', () => {
    const summary = build();
    const task2 = summary.tasks.find((t) => t.id === 'task-2')!;

    const withSkillFailures = task2.failures.filter((f) => f.condition === 'with-skill');
    expect(withSkillFailures).toHaveLength(1);
    expect(withSkillFailures[0].trial).toBe(2);
    expect(withSkillFailures[0].failedChecks).toEqual(['Expected skill activation but no skill was loaded']);
    expect(withSkillFailures[0].failureCategory).toBe('discovery_failure');

    const baselineFailures = task2.failures.filter((f) => f.condition === 'baseline');
    expect(baselineFailures).toHaveLength(2);
  });

  it('carries verifier evidence on failing trials', () => {
    const result = makeResult({
      taskId: 't',
      verifier: {
        reward: 0,
        passed: false,
        exitCode: 1,
        status: 'ok',
        stdout: '',
        stderr: 'expected out/report.pdf to exist',
        durationMs: 10,
      },
    });
    const summary = buildRunSummary({
      tasks: [makeTask('t')],
      skillName: 'test-skill',
      withSkill: {
        allResults: [[result]],
        allScores: [[makeScore({
          taskId: 't',
          passed: false,
          reward: 0,
          deterministic: makeDet({ passed: false, verifierPassed: false, details: ['Verifier failed (reward 0, status ok): expected out/report.pdf to exist'] }),
        })]],
      },
      config: DEFAULT_CONFIG,
      nudge: 'off',
      trials: 1,
      judgeEnabled: false,
    });

    const failure = summary.tasks[0].failures[0];
    expect(failure.verifierStatus).toBe('ok');
    expect(failure.verifierStderr).toContain('expected out/report.pdf');
    expect(failure.failedChecks[0]).toContain('Verifier failed');
  });

  it('groups metrics by difficulty, category, and tag', () => {
    const summary = build();

    expect(summary.metrics.byDifficulty.easy.resolutionRate).toBe(1);
    expect(summary.metrics.byDifficulty.hard.resolutionRate).toBeCloseTo(0.5);
    expect(summary.metrics.byCategory.docs.tasks).toBe(2);
    expect(summary.metrics.byTag.pdf.tasks).toBe(1);
  });

  it('totals duration and cost across both conditions', () => {
    const summary = build();
    // 8 trials total (2 tasks × 2 trials × 2 conditions) at 1000ms/$0.01 each
    expect(summary.metrics.totalDurationMs).toBe(8000);
    expect(summary.metrics.totalCostUsd).toBeCloseTo(0.08);
  });
});

describe('evaluateThresholds', () => {
  it('gates on the resolution threshold', () => {
    const config: EvalConfig = { ...DEFAULT_CONFIG, resolutionThreshold: 0.8 };
    expect(evaluateThresholds(0.75, config).passed).toBe(false);
    expect(evaluateThresholds(0.8, config).passed).toBe(true);
  });

  it('does not gate on lift when no threshold is configured', () => {
    const result = evaluateThresholds(1, DEFAULT_CONFIG, -0.5);
    expect(result.liftPassed).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('gates on lift when a threshold is configured and a lift is present', () => {
    const config: EvalConfig = { ...DEFAULT_CONFIG, resolutionThreshold: 0.5, liftThreshold: 0.2 };
    expect(evaluateThresholds(1, config, 0.1).passed).toBe(false);
    expect(evaluateThresholds(1, config, 0.1).liftPassed).toBe(false);
    expect(evaluateThresholds(1, config, 0.3).passed).toBe(true);
  });

  it('skips lift gating when no baseline ran (lift undefined)', () => {
    const config: EvalConfig = { ...DEFAULT_CONFIG, resolutionThreshold: 0.5, liftThreshold: 0.2 };
    const result = evaluateThresholds(1, config, undefined);
    expect(result.liftPassed).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('threshold gating drives buildRunSummary.thresholds.passed', () => {
    const failing = build({ ...DEFAULT_CONFIG, resolutionThreshold: 0.9 });
    expect(failing.thresholds.resolutionPassed).toBe(false);
    expect(failing.thresholds.passed).toBe(false);

    const passing = build({ ...DEFAULT_CONFIG, resolutionThreshold: 0.7 });
    expect(passing.thresholds.passed).toBe(true);

    const liftGated = build({ ...DEFAULT_CONFIG, resolutionThreshold: 0.5, liftThreshold: 0.6 });
    expect(liftGated.thresholds.liftPassed).toBe(false);
    expect(liftGated.thresholds.passed).toBe(false);
  });
});

describe('collectFailedChecks', () => {
  it('returns only failure-evidence detail strings', () => {
    const det = makeDet({
      passed: false,
      details: [
        'Skill activated correctly: test-skill',
        'Expected substrings not found: "Hello"',
        'No forbidden tools called',
        'Verifier failed (reward 0, status ok)',
      ],
    });
    expect(collectFailedChecks(det)).toEqual([
      'Expected substrings not found: "Hello"',
      'Verifier failed (reward 0, status ok)',
    ]);
  });

  it('returns empty for a null result', () => {
    expect(collectFailedChecks(null)).toEqual([]);
  });
});

describe('writeRunSummary', () => {
  it('writes summary.json to the output dir', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-summary-test-'));
    try {
      const summary = build();
      const summaryPath = await writeRunSummary(summary, dir);
      expect(summaryPath).toBe(path.join(dir, 'summary.json'));
      const parsed = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
      expect(parsed.version).toBe(2);
      expect(parsed.metrics.resolutionRate).toBeCloseTo(0.75);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
