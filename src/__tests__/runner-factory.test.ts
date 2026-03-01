import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner/runner-factory.js';
import type { RunnerType } from '../config.js';

describe('createRunner', () => {
  it('creates a claude-sdk runner', async () => {
    const runner = await createRunner('claude-sdk', {});
    expect(runner).toBeDefined();
    expect(runner.providerName).toBe('claude-sdk');
  });

  it('throws for unknown runner type', async () => {
    await expect(
      createRunner('invalid-runner' as RunnerType, {}),
    ).rejects.toThrow('Unknown runner type: invalid-runner');
  });
});
