import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseRunner } from '../runner/base-runner.js';
import type { EvalTask, TaskResult } from '../types.js';
import type { SessionLogger } from '../session/session-logger.js';

// Mock fixture-runner at module level
vi.mock('../runner/fixture-runner.js', () => ({
  runFixtureScript: vi.fn(),
}));

// Mock config loader to avoid file system reads
vi.mock('../config.js', () => ({
  loadConfigSync: vi.fn(() => ({
    defaultAgentModel: 'test-model',
    taskTimeoutMs: 300000,
    allowedWriteDirs: [],
  })),
}));

import { runFixtureScript } from '../runner/fixture-runner.js';

const mockRunFixtureScript = runFixtureScript as ReturnType<typeof vi.fn>;

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

describe('BaseRunner fixture integration', () => {
  let runner: TestableBaseRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new TestableBaseRunner({ cwd: '/app' });
    runner.mockRunTask.mockResolvedValue(makeResult());
  });

  it('runs task normally when no fixture is defined', async () => {
    const task = makeTask();
    const result = await runner.runTaskWithTimeout(task);

    expect(mockRunFixtureScript).not.toHaveBeenCalled();
    expect(runner.mockRunTask).toHaveBeenCalledWith(task, undefined);
    expect(result.isError).toBe(false);
  });

  it('runs setup before runTask when fixture.setup is defined', async () => {
    mockRunFixtureScript.mockResolvedValue({ success: true, stdout: '', stderr: '' });

    const callOrder: string[] = [];
    mockRunFixtureScript.mockImplementation(async () => {
      callOrder.push('setup');
      return { success: true, stdout: '', stderr: '' };
    });
    runner.mockRunTask.mockImplementation(async () => {
      callOrder.push('runTask');
      return makeResult();
    });

    const task = makeTask({ fixture: { state: 'default', setup: 'scripts/setup.sh' } });
    await runner.runTaskWithTimeout(task);

    expect(callOrder).toEqual(['setup', 'runTask']);
    expect(mockRunFixtureScript).toHaveBeenCalledWith('scripts/setup.sh', '/app');
  });

  it('runs teardown after runTask when fixture.teardown is defined', async () => {
    const callOrder: string[] = [];
    mockRunFixtureScript.mockImplementation(async () => {
      callOrder.push('teardown');
      return { success: true, stdout: '', stderr: '' };
    });
    runner.mockRunTask.mockImplementation(async () => {
      callOrder.push('runTask');
      return makeResult();
    });

    const task = makeTask({ fixture: { state: 'default', teardown: 'scripts/teardown.sh' } });
    await runner.runTaskWithTimeout(task);

    expect(callOrder).toEqual(['runTask', 'teardown']);
    expect(mockRunFixtureScript).toHaveBeenCalledWith('scripts/teardown.sh', '/app');
  });

  it('runs setup, then runTask, then teardown in order', async () => {
    const callOrder: string[] = [];
    mockRunFixtureScript.mockImplementation(async (scriptPath: string) => {
      callOrder.push(scriptPath.includes('setup') ? 'setup' : 'teardown');
      return { success: true, stdout: '', stderr: '' };
    });
    runner.mockRunTask.mockImplementation(async () => {
      callOrder.push('runTask');
      return makeResult();
    });

    const task = makeTask({
      fixture: { state: 'default', setup: 'scripts/setup.sh', teardown: 'scripts/teardown.sh' },
    });
    await runner.runTaskWithTimeout(task);

    expect(callOrder).toEqual(['setup', 'runTask', 'teardown']);
  });

  it('skips task and returns error when setup fails', async () => {
    mockRunFixtureScript.mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'permission denied',
      errorMessage: 'Script not found: /app/scripts/setup.sh',
    });

    const task = makeTask({
      fixture: { state: 'default', setup: 'scripts/setup.sh' },
    });
    const result = await runner.runTaskWithTimeout(task);

    expect(runner.mockRunTask).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toMatch(/^Fixture setup failed:/);
    expect(result.errorMessage).toContain('Script not found');
  });

  it('still runs teardown when setup fails', async () => {
    let teardownCalled = false;
    mockRunFixtureScript.mockImplementation(async (scriptPath: string) => {
      if (scriptPath.includes('teardown')) {
        teardownCalled = true;
        return { success: true, stdout: '', stderr: '' };
      }
      return { success: false, stdout: '', stderr: '', errorMessage: 'setup failed' };
    });

    const task = makeTask({
      fixture: { state: 'default', setup: 'scripts/setup.sh', teardown: 'scripts/teardown.sh' },
    });
    await runner.runTaskWithTimeout(task);

    expect(teardownCalled).toBe(true);
  });

  it('does not fail the task when teardown fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockRunFixtureScript.mockImplementation(async (scriptPath: string) => {
      if (scriptPath.includes('teardown')) {
        return { success: false, stdout: '', stderr: '', errorMessage: 'cleanup error' };
      }
      return { success: true, stdout: '', stderr: '' };
    });

    const task = makeTask({
      fixture: { state: 'default', setup: 'scripts/setup.sh', teardown: 'scripts/teardown.sh' },
    });
    const result = await runner.runTaskWithTimeout(task);

    expect(result.isError).toBe(false);
    expect(result.output).toBe('Some output');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fixture teardown failed'),
    );

    warnSpy.mockRestore();
  });

  it('runs teardown even when runTask throws', async () => {
    let teardownCalled = false;
    mockRunFixtureScript.mockImplementation(async (scriptPath: string) => {
      if (scriptPath.includes('teardown')) {
        teardownCalled = true;
      }
      return { success: true, stdout: '', stderr: '' };
    });
    runner.mockRunTask.mockRejectedValue(new Error('agent crashed'));

    const task = makeTask({
      fixture: { state: 'default', setup: 'scripts/setup.sh', teardown: 'scripts/teardown.sh' },
    });
    const result = await runner.runTaskWithTimeout(task);

    expect(teardownCalled).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('agent crashed');
  });

  it('does not call runFixtureScript when fixture exists but has no setup or teardown', async () => {
    const task = makeTask({ fixture: { state: 'default' } });
    await runner.runTaskWithTimeout(task);

    expect(mockRunFixtureScript).not.toHaveBeenCalled();
    expect(runner.mockRunTask).toHaveBeenCalled();
  });

  it('handles teardown throwing an unexpected error without masking the task result', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockRunFixtureScript.mockImplementation(async (scriptPath: string) => {
      if (scriptPath.includes('teardown')) {
        throw new Error('unexpected teardown crash');
      }
      return { success: true, stdout: '', stderr: '' };
    });

    const task = makeTask({
      fixture: { state: 'default', setup: 'scripts/setup.sh', teardown: 'scripts/teardown.sh' },
    });
    const result = await runner.runTaskWithTimeout(task);

    expect(result.isError).toBe(false);
    expect(result.output).toBe('Some output');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fixture teardown threw'),
    );

    warnSpy.mockRestore();
  });
});
