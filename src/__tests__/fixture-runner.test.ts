import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('child_process', () => {
  const mock = vi.fn();
  return { execFile: mock };
});

vi.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { runFixtureScript } from '../runner/fixture-runner.js';
import { execFile } from 'child_process';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

describe('runFixtureScript', () => {
  const cwd = '/app';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when script executes successfully', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: 'setup done', stderr: '' });

    const result = await runFixtureScript('scripts/setup.sh', cwd);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('setup done');
    expect(result.stderr).toBe('');
    expect(result.errorMessage).toBeUndefined();
  });

  it('resolves script path against cwd', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await runFixtureScript('scripts/setup.sh', cwd);

    const expectedPath = path.resolve(cwd, 'scripts/setup.sh');
    expect(mockExecFile).toHaveBeenCalledWith(expectedPath, [], {
      cwd,
      timeout: 30_000,
      encoding: 'utf-8',
    });
  });

  it('passes absolute script path unchanged', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

    // Use path.resolve to build a cross-platform absolute path
    const absPath = path.resolve('/usr/local/bin/setup.sh');
    await runFixtureScript(absPath, cwd);

    expect(mockExecFile).toHaveBeenCalledWith(absPath, [], expect.objectContaining({ cwd }));
  });

  it('uses custom timeout when provided', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await runFixtureScript('setup.sh', cwd, 5000);

    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('returns failure with message when script is not found (ENOENT)', async () => {
    const error = new Error('spawn ENOENT') as Error & { code: string };
    error.code = 'ENOENT';
    mockExecFile.mockRejectedValueOnce(error);

    const result = await runFixtureScript('missing.sh', cwd);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Script not found');
    expect(result.errorMessage).toContain('missing.sh');
  });

  it('returns failure with message when ENOENT appears in error message', async () => {
    const error = new Error('ENOENT: no such file or directory');
    mockExecFile.mockRejectedValueOnce(error);

    const result = await runFixtureScript('missing.sh', cwd);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Script not found');
  });

  it('returns failure when script exits with non-zero code', async () => {
    const error = Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: 'partial output',
      stderr: 'error details',
    });
    mockExecFile.mockRejectedValueOnce(error);

    const result = await runFixtureScript('bad-script.sh', cwd);

    expect(result.success).toBe(false);
    expect(result.stdout).toBe('partial output');
    expect(result.stderr).toBe('error details');
    expect(result.errorMessage).toBeDefined();
  });

  it('returns failure with timeout message when script is killed', async () => {
    const error = Object.assign(new Error('killed'), {
      killed: true,
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockRejectedValueOnce(error);

    const result = await runFixtureScript('slow-script.sh', cwd, 5000);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    expect(result.errorMessage).toContain('5000ms');
  });

  it('handles null stdout/stderr in success response', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: null, stderr: null });

    const result = await runFixtureScript('setup.sh', cwd);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('handles null stdout/stderr in error response', async () => {
    const error = Object.assign(new Error('failed'), { code: 1 });
    mockExecFile.mockRejectedValueOnce(error);

    const result = await runFixtureScript('setup.sh', cwd);

    expect(result.success).toBe(false);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
