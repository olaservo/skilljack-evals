import type { CombinedScore, TaskResult, EvaluationReport } from '../../types.js';

export function makeScore(overrides: Partial<CombinedScore> = {}): CombinedScore {
  return {
    taskId: 'task-1',
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

export function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'task-1',
    prompt: 'test prompt',
    output: 'test output',
    durationMs: 1000,
    numTurns: 1,
    costUsd: 0.01,
    skillLoads: [],
    toolCalls: [],
    isError: false,
    errorMessage: '',
    ...overrides,
  };
}

export function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    skillName: 'test-skill',
    timestamp: '2026-03-07T10:00:00.000Z',
    passed: true,
    failureReasons: [],
    summary: {
      totalTasks: 2,
      numRuns: 1,
      discoveryAccuracy: 0.8,
      avgAdherence: 4.0,
      avgOutputQuality: 4.0,
      avgWeightedScore: 0.75,
      totalDurationMs: 5000,
      totalCostUsd: 0.01,
    },
    failureBreakdown: [],
    tasks: [
      {
        task: { id: 'task-1', prompt: 'p1', expectedSkillLoad: 'skill', criteria: [], goldenChecklist: [] },
        result: { taskId: 'task-1', prompt: 'p1', output: 'out1', durationMs: 2500, numTurns: 1, costUsd: 0.005, skillLoads: ['skill'], toolCalls: [], isError: false, errorMessage: '' },
        score: { taskId: 'task-1', deterministic: null, judge: null, discovery: 1, adherence: 4, outputQuality: 4, weightedScore: 0.8, failureCategory: 'none', reasoning: 'ok' },
      },
      {
        task: { id: 'task-2', prompt: 'p2', expectedSkillLoad: 'skill', criteria: [], goldenChecklist: [] },
        result: { taskId: 'task-2', prompt: 'p2', output: 'out2', durationMs: 2500, numTurns: 1, costUsd: 0.005, skillLoads: ['skill'], toolCalls: [], isError: false, errorMessage: '' },
        score: { taskId: 'task-2', deterministic: null, judge: null, discovery: 0.6, adherence: 4, outputQuality: 4, weightedScore: 0.7, failureCategory: 'none', reasoning: 'ok' },
      },
    ],
    ...overrides,
  };
}
