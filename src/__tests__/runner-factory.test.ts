import { describe, it, expect } from 'vitest';
import { createRunner, RUNNER_SKILLS_MOUNT_PATHS } from '../runner/runner-factory.js';
import { VALID_RUNNER_TYPES } from '../config.js';
import type { RunnerType } from '../config.js';

describe('createRunner', () => {
  it('creates a claude-sdk runner', async () => {
    const runner = await createRunner('claude-sdk', {});
    expect(runner).toBeDefined();
    expect(runner.providerName).toBe('claude-sdk');
  });

  it('creates the CLI runners with their harness-specific skills mount paths', async () => {
    const codex = await createRunner('codex', {});
    expect(codex.providerName).toBe('codex');
    expect(codex.skillsMountPath).toContain('.agents');

    const gemini = await createRunner('gemini', {});
    expect(gemini.providerName).toBe('gemini');
    expect(gemini.skillsMountPath).toContain('.gemini');

    const opencode = await createRunner('opencode', {});
    expect(opencode.providerName).toBe('opencode');
    expect(opencode.skillsMountPath).toContain('.opencode');

    const claudeCode = await createRunner('claude-code', {});
    expect(claudeCode.skillsMountPath).toContain('.claude');
  });

  it('throws for unknown runner type', async () => {
    await expect(
      createRunner('invalid-runner' as RunnerType, {}),
    ).rejects.toThrow('Unknown runner type: invalid-runner');
  });

  it('RUNNER_SKILLS_MOUNT_PATHS matches every constructed runner (never diverges)', async () => {
    for (const type of VALID_RUNNER_TYPES) {
      const runner = await createRunner(type, {});
      expect(RUNNER_SKILLS_MOUNT_PATHS[type], `mount path for ${type}`).toBe(runner.skillsMountPath);
    }
  });

  it('passes options through to runner', async () => {
    const runner = await createRunner('claude-sdk', {
      model: 'haiku',
      cwd: '/tmp/test',
      taskTimeoutMs: 60000,
    });
    expect(runner).toBeDefined();
    expect(runner.providerName).toBe('claude-sdk');

    const opts = (runner as any).runnerOptions;
    expect(opts.model).toBe('haiku');
    expect(opts.cwd).toBe('/tmp/test');
    expect(opts.taskTimeoutMs).toBe(60000);
  });

});
