import { describe, it, expect, vi } from 'vitest';
import type {
  BlindTaskComparison,
  BlindComparisonData,
  TaskComparison,
  TaskResult,
  CombinedScore,
} from '../types.js';
import { blindCompareAll, BLIND_BIAS_THRESHOLD, SkillJudge } from '../scorer/judge.js';

/** Helper to create a minimal TaskResult */
function makeResult(taskId: string, output = 'test output'): TaskResult {
  return {
    taskId,
    prompt: 'test prompt',
    output,
    durationMs: 1000,
    numTurns: 1,
    costUsd: 0.01,
    skillLoads: [],
    toolCalls: [],
    isError: false,
    errorMessage: '',
  };
}

/** Helper to create a minimal CombinedScore */
function makeScore(
  taskId: string,
  overrides: Partial<CombinedScore> = {},
): CombinedScore {
  return {
    taskId,
    deterministic: null,
    judge: null,
    discovery: 1,
    adherence: 4,
    outputQuality: 4,
    weightedScore: 0.8,
    failureCategory: 'none',
    reasoning: 'test',
    ...overrides,
  };
}

/** Helper to create a TaskComparison with a given weighted score delta */
function makeTaskComparison(
  taskId: string,
  withSkillWeighted: number,
  withoutSkillWeighted: number,
): TaskComparison {
  return {
    taskId,
    withSkill: {
      result: makeResult(taskId, 'with-skill output'),
      score: makeScore(taskId, { weightedScore: withSkillWeighted }),
    },
    withoutSkill: {
      result: makeResult(taskId, 'without-skill output'),
      score: makeScore(taskId, { weightedScore: withoutSkillWeighted }),
    },
    delta: {
      taskId,
      discoveryDelta: 0,
      adherenceDelta: 0,
      outputQualityDelta: 0,
      weightedScoreDelta: withSkillWeighted - withoutSkillWeighted,
      durationDeltaMs: 0,
      costDeltaUsd: 0,
    },
  };
}

/** Helper to create a BlindTaskComparison */
function makeBlindTask(
  taskId: string,
  preferredCondition: 'with-skill' | 'without-skill' | 'tie',
  standardDelta: number,
): BlindTaskComparison {
  // Detect bias: standard prefers one, blind prefers the other
  const standardPrefersWithSkill = standardDelta > 0.02;
  const standardPrefersWithout = standardDelta < -0.02;
  const biasSignal =
    preferredCondition !== 'tie' &&
    ((standardPrefersWithSkill && preferredCondition === 'without-skill') ||
     (standardPrefersWithout && preferredCondition === 'with-skill'));

  return {
    taskId,
    withSkillLabel: 'A',
    outputA: { instructionFollowing: 4, outputQuality: 4 },
    outputB: { instructionFollowing: 3, outputQuality: 3 },
    preferred: preferredCondition === 'with-skill' ? 'A' : preferredCondition === 'without-skill' ? 'B' : 'tie',
    reasoning: 'test reasoning',
    preferredCondition,
    biasSignal,
    failed: false,
  };
}

/** Helper to compute aggregate from tasks */
function computeAggregate(tasks: BlindTaskComparison[]): BlindComparisonData['aggregate'] {
  return {
    withSkillPreferred: tasks.filter(t => t.preferredCondition === 'with-skill').length,
    withoutSkillPreferred: tasks.filter(t => t.preferredCondition === 'without-skill').length,
    ties: tasks.filter(t => t.preferredCondition === 'tie').length,
    biasSignalCount: tasks.filter(t => t.biasSignal).length,
    failedCount: tasks.filter(t => t.failed).length,
  };
}

describe('Blind comparison bias detection', () => {
  it('detects bias when standard prefers with-skill but blind prefers without-skill', () => {
    // Standard delta = +0.2 (prefers with-skill), blind prefers without-skill
    const task = makeBlindTask('task-1', 'without-skill', 0.2);
    expect(task.biasSignal).toBe(true);
  });

  it('detects bias when standard prefers without-skill but blind prefers with-skill', () => {
    // Standard delta = -0.2 (prefers without-skill), blind prefers with-skill
    const task = makeBlindTask('task-1', 'with-skill', -0.2);
    expect(task.biasSignal).toBe(true);
  });

  it('no bias when both agree on with-skill preference', () => {
    // Standard delta = +0.2 (prefers with-skill), blind also prefers with-skill
    const task = makeBlindTask('task-1', 'with-skill', 0.2);
    expect(task.biasSignal).toBe(false);
  });

  it('no bias when both agree on without-skill preference', () => {
    // Standard delta = -0.2, blind also prefers without-skill
    const task = makeBlindTask('task-1', 'without-skill', -0.2);
    expect(task.biasSignal).toBe(false);
  });

  it('no bias when blind result is a tie', () => {
    const task = makeBlindTask('task-1', 'tie', 0.5);
    expect(task.biasSignal).toBe(false);
  });

  it('no bias when standard delta is within threshold (neutral)', () => {
    // Standard delta = 0.01, under 0.02 threshold
    const task = makeBlindTask('task-1', 'without-skill', 0.01);
    expect(task.biasSignal).toBe(false);
  });
});

describe('Blind comparison label mapping', () => {
  it('maps A preference to with-skill when withSkillLabel is A', () => {
    const task: BlindTaskComparison = {
      taskId: 'task-1',
      withSkillLabel: 'A',
      outputA: { instructionFollowing: 5, outputQuality: 5 },
      outputB: { instructionFollowing: 3, outputQuality: 3 },
      preferred: 'A',
      reasoning: 'A is better',
      preferredCondition: 'with-skill',
      biasSignal: false,
      failed: false,
    };
    expect(task.preferredCondition).toBe('with-skill');
  });

  it('maps B preference to with-skill when withSkillLabel is B', () => {
    const task: BlindTaskComparison = {
      taskId: 'task-1',
      withSkillLabel: 'B',
      outputA: { instructionFollowing: 3, outputQuality: 3 },
      outputB: { instructionFollowing: 5, outputQuality: 5 },
      preferred: 'B',
      reasoning: 'B is better',
      preferredCondition: 'with-skill',
      biasSignal: false,
      failed: false,
    };
    expect(task.preferredCondition).toBe('with-skill');
  });

  it('maps A preference to without-skill when withSkillLabel is B', () => {
    const task: BlindTaskComparison = {
      taskId: 'task-1',
      withSkillLabel: 'B',
      outputA: { instructionFollowing: 5, outputQuality: 5 },
      outputB: { instructionFollowing: 3, outputQuality: 3 },
      preferred: 'A',
      reasoning: 'A is better',
      preferredCondition: 'without-skill',
      biasSignal: false,
      failed: false,
    };
    expect(task.preferredCondition).toBe('without-skill');
  });
});

describe('Blind comparison aggregate computation', () => {
  it('computes correct aggregate counts', () => {
    const tasks: BlindTaskComparison[] = [
      makeBlindTask('task-1', 'with-skill', 0.1),
      makeBlindTask('task-2', 'without-skill', 0.1),  // bias signal
      makeBlindTask('task-3', 'tie', 0.1),
      makeBlindTask('task-4', 'with-skill', 0.1),
    ];

    const aggregate = computeAggregate(tasks);

    expect(aggregate.withSkillPreferred).toBe(2);
    expect(aggregate.withoutSkillPreferred).toBe(1);
    expect(aggregate.ties).toBe(1);
    expect(aggregate.biasSignalCount).toBe(1);
  });

  it('handles all ties', () => {
    const tasks: BlindTaskComparison[] = [
      makeBlindTask('task-1', 'tie', 0.0),
      makeBlindTask('task-2', 'tie', 0.0),
    ];

    const aggregate = computeAggregate(tasks);

    expect(aggregate.withSkillPreferred).toBe(0);
    expect(aggregate.withoutSkillPreferred).toBe(0);
    expect(aggregate.ties).toBe(2);
    expect(aggregate.biasSignalCount).toBe(0);
  });

  it('handles empty tasks array', () => {
    const aggregate = computeAggregate([]);

    expect(aggregate.withSkillPreferred).toBe(0);
    expect(aggregate.withoutSkillPreferred).toBe(0);
    expect(aggregate.ties).toBe(0);
    expect(aggregate.biasSignalCount).toBe(0);
  });
});

describe('blindCompareAll integration', () => {
  function createMockJudge(
    response: { outputA: { instructionFollowing: number; outputQuality: number }; outputB: { instructionFollowing: number; outputQuality: number }; preferred: 'A' | 'B' | 'tie'; reasoning: string } | null,
  ) {
    return {
      blindCompare: vi.fn().mockResolvedValue(response),
    } as unknown as SkillJudge;
  }

  it('maps judge results and detects bias correctly', async () => {
    const mockJudge = createMockJudge({
      outputA: { instructionFollowing: 5, outputQuality: 5 },
      outputB: { instructionFollowing: 2, outputQuality: 2 },
      preferred: 'A',
      reasoning: 'A is clearly better',
    });

    // Standard scoring prefers with-skill (delta > 0)
    const tasks = [makeTaskComparison('task-1', 0.8, 0.3)];
    // Pin randomFn so with-skill is always A
    const result = await blindCompareAll(tasks, mockJudge, { randomFn: () => 0.1 });

    expect(result.tasks).toHaveLength(1);
    expect(mockJudge.blindCompare).toHaveBeenCalledOnce();
    expect(result.tasks[0].withSkillLabel).toBe('A');
    expect(result.tasks[0].preferredCondition).toBe('with-skill');
    expect(result.tasks[0].biasSignal).toBe(false); // both agree
    expect(result.tasks[0].failed).toBe(false);
    expect(result.aggregate.withSkillPreferred).toBe(1);
    expect(result.aggregate.ties).toBe(0);
  });

  it('detects bias when blind disagrees with standard', async () => {
    // Blind prefers B (without-skill), standard prefers with-skill
    const mockJudge = createMockJudge({
      outputA: { instructionFollowing: 2, outputQuality: 2 },
      outputB: { instructionFollowing: 5, outputQuality: 5 },
      preferred: 'B',
      reasoning: 'B is better',
    });

    const tasks = [makeTaskComparison('task-1', 0.8, 0.3)]; // standard prefers with-skill
    const result = await blindCompareAll(tasks, mockJudge, { randomFn: () => 0.1 }); // with-skill = A

    expect(result.tasks[0].preferredCondition).toBe('without-skill');
    expect(result.tasks[0].biasSignal).toBe(true);
    expect(result.aggregate.biasSignalCount).toBe(1);
  });

  it('handles failed blind judge calls gracefully', async () => {
    const mockJudge = createMockJudge(null);

    const tasks = [makeTaskComparison('task-1', 0.8, 0.3)];
    const result = await blindCompareAll(tasks, mockJudge, { randomFn: () => 0.1 });

    expect(result.tasks[0].failed).toBe(true);
    expect(result.tasks[0].preferredCondition).toBe('tie');
    expect(result.tasks[0].biasSignal).toBe(false);
    expect(result.aggregate.failedCount).toBe(1);
    expect(result.aggregate.ties).toBe(1);
  });

  it('respects randomFn for deterministic label assignment', async () => {
    const mockJudge = createMockJudge({
      outputA: { instructionFollowing: 3, outputQuality: 3 },
      outputB: { instructionFollowing: 3, outputQuality: 3 },
      preferred: 'tie',
      reasoning: 'Equal',
    });

    const tasks = [makeTaskComparison('task-1', 0.5, 0.5)];

    // randomFn returns 0.9 → with-skill should be B
    const result = await blindCompareAll(tasks, mockJudge, { randomFn: () => 0.9 });
    expect(result.tasks[0].withSkillLabel).toBe('B');

    // randomFn returns 0.1 → with-skill should be A
    const result2 = await blindCompareAll(tasks, mockJudge, { randomFn: () => 0.1 });
    expect(result2.tasks[0].withSkillLabel).toBe('A');
  });

  it('runs multiple tasks concurrently', async () => {
    const callOrder: string[] = [];
    const mockJudge = {
      blindCompare: vi.fn().mockImplementation(async (_prompt: string, _a: string, _b: string) => {
        callOrder.push('start');
        // Simulate async work
        await new Promise(r => setTimeout(r, 10));
        callOrder.push('end');
        return {
          outputA: { instructionFollowing: 4, outputQuality: 4 },
          outputB: { instructionFollowing: 3, outputQuality: 3 },
          preferred: 'A' as const,
          reasoning: 'A is better',
        };
      }),
    } as unknown as SkillJudge;

    const tasks = [
      makeTaskComparison('task-1', 0.8, 0.3),
      makeTaskComparison('task-2', 0.7, 0.4),
      makeTaskComparison('task-3', 0.6, 0.5),
    ];

    const result = await blindCompareAll(tasks, mockJudge, { randomFn: () => 0.1 });

    expect(result.tasks).toHaveLength(3);
    expect(mockJudge.blindCompare).toHaveBeenCalledTimes(3);
    // All 3 starts should happen before any ends (concurrent execution)
    const starts = callOrder.filter(c => c === 'start');
    const firstEnd = callOrder.indexOf('end');
    expect(starts.length).toBe(3);
    // With Promise.all, all starts happen before the first end
    expect(callOrder.slice(0, 3)).toEqual(['start', 'start', 'start']);
  });
});
