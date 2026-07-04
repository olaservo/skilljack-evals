import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseRunner } from '../runner/base-runner.js';
import type { EvalTask, TaskResult } from '../types.js';
import type { SessionLogger } from '../session/session-logger.js';

// Mock config loader to avoid file system reads
vi.mock('../config.js', () => ({
  loadConfigSync: vi.fn(() => ({
    defaultAgentModel: 'test-model',
    taskTimeoutMs: 300000,
    allowedWriteDirs: [],
  })),
}));

/**
 * Concrete subclass of BaseRunner for testing.
 * Follows the testable-subclass pattern used across the codebase.
 */
class TestableBaseRunner extends BaseRunner {
  readonly providerName = 'test-runner';
  mockRunTask = vi.fn<(task: EvalTask, logger?: SessionLogger) => Promise<TaskResult>>();

  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    return this.mockRunTask(task, logger);
  }

  buildResultForTest(task: EvalTask, fields: Parameters<BaseRunner['buildTaskResult']>[1]): TaskResult {
    return this.buildTaskResult(task, fields);
  }
}

function makeTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'test-1',
    prompt: 'Test prompt',
    expectedSkillLoad: 'test-skill',
    criteria: [{ dimension: 'discovery', weight: 1, description: 'test' }],
    goldenChecklist: [],
    ...overrides,
  };
}

function makeResult(taskId: string = 'test-1'): TaskResult {
  return {
    taskId,
    prompt: 'Test prompt',
    output: 'Some output',
    durationMs: 100,
    numTurns: 1,
    costUsd: 0.001,
    skillLoads: ['test-skill'],
    toolCalls: [],
    isError: false,
    errorMessage: '',
  };
}

describe('BaseRunner runTaskWithTimeout', () => {
  let runner: TestableBaseRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new TestableBaseRunner({ cwd: '/app' });
    runner.mockRunTask.mockResolvedValue(makeResult());
  });

  it('returns the task result on success', async () => {
    const task = makeTask();
    const result = await runner.runTaskWithTimeout(task);

    expect(runner.mockRunTask).toHaveBeenCalledWith(task, undefined);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('Some output');
  });

  it('returns an error result when runTask throws', async () => {
    runner.mockRunTask.mockRejectedValue(new Error('agent crashed'));

    const result = await runner.runTaskWithTimeout(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('agent crashed');
  });

  it('times out a hanging task with the explicit timeout argument', async () => {
    runner.mockRunTask.mockImplementation(() => new Promise(() => {}));

    const result = await runner.runTaskWithTimeout(makeTask(), 20);

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('timed out after 20ms');
  });

  it('uses the per-task timeoutMs override when no explicit timeout given', async () => {
    runner.mockRunTask.mockImplementation(() => new Promise(() => {}));

    const result = await runner.runTaskWithTimeout(makeTask({ timeoutMs: 25 }));

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('timed out after 25ms');
  });

  it('prefers the explicit timeout argument over task.timeoutMs', async () => {
    runner.mockRunTask.mockImplementation(() => new Promise(() => {}));

    const result = await runner.runTaskWithTimeout(makeTask({ timeoutMs: 60000 }), 15);

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('timed out after 15ms');
  });

  it('buildTaskResult threads tokens onto the TaskResult', () => {
    const task = makeTask();
    const tokens = { input: 1000, output: 250, cacheRead: 50, cacheCreation: 10, total: 1310 };
    const result = runner.buildResultForTest(task, {
      output: 'ok',
      durationMs: 100,
      numTurns: 1,
      costUsd: 0.001,
      skillLoads: [],
      toolCalls: [],
      tokens,
    });
    expect(result.tokens).toEqual(tokens);
  });

  it('buildTaskResult leaves tokens undefined when not provided', () => {
    const task = makeTask();
    const result = runner.buildResultForTest(task, {
      output: 'ok',
      durationMs: 100,
      numTurns: 1,
      costUsd: 0.001,
      skillLoads: [],
      toolCalls: [],
    });
    expect(result.tokens).toBeUndefined();
  });
});
