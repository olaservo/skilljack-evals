import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner/runner-factory.js';
import type { RunnerType } from '../config.js';

describe('createRunner', () => {
  it('creates a claude-sdk runner', async () => {
    const runner = await createRunner('claude-sdk', {});
    expect(runner).toBeDefined();
    expect(runner.providerName).toBe('claude-sdk');
  });

  it('creates a vercel-ai runner', async () => {
    const runner = await createRunner('vercel-ai', {});
    expect(runner).toBeDefined();
    expect(runner.providerName).toBe('vercel-ai');
  });

  it('creates an openai-agents runner', async () => {
    const runner = await createRunner('openai-agents', {});
    expect(runner).toBeDefined();
    expect(runner.providerName).toBe('openai-agents');
  });

  it('creates a copilot-sdk runner', async () => {
    const runner = await createRunner('copilot-sdk', {});
    expect(runner).toBeDefined();
    expect(runner.providerName).toBe('copilot-sdk');
  });

  it('throws for unknown runner type', async () => {
    await expect(
      createRunner('invalid-runner' as RunnerType, {}),
    ).rejects.toThrow('Unknown runner type: invalid-runner');
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

  it('passes concurrency option through to runner', async () => {
    const runner = await createRunner('claude-sdk', {
      concurrency: 3,
    });
    const opts = (runner as any).runnerOptions;
    expect(opts.concurrency).toBe(3);
  });
});
