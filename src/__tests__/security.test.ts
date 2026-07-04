import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isWriteAllowed, createPreToolUseHook } from '../runner/security.js';

describe('isWriteAllowed', () => {
  const cwd = '/app';

  it('allows all writes when allowedWriteDirs is empty', () => {
    expect(isWriteAllowed('/anywhere/file.txt', [], cwd)).toBe(true);
  });

  it('allows writes inside an allowed directory', () => {
    const allowed = ['./results/'];
    const filePath = path.resolve(cwd, 'results/output.json');
    expect(isWriteAllowed(filePath, allowed, cwd)).toBe(true);
  });

  it('allows writes to the allowed directory itself', () => {
    const allowed = ['./results/'];
    const dirPath = path.resolve(cwd, 'results');
    expect(isWriteAllowed(dirPath, allowed, cwd)).toBe(true);
  });

  it('denies writes outside allowed directories', () => {
    const allowed = ['./results/'];
    const filePath = path.resolve(cwd, 'src/evil.ts');
    expect(isWriteAllowed(filePath, allowed, cwd)).toBe(false);
  });

  it('prevents prefix attack (results-evil should not match results)', () => {
    const allowed = ['./results/'];
    const filePath = path.resolve(cwd, 'results-evil/hack.txt');
    expect(isWriteAllowed(filePath, allowed, cwd)).toBe(false);
  });

  it('supports multiple allowed directories', () => {
    const allowed = ['./results/', './fixtures/'];
    const resultsFile = path.resolve(cwd, 'results/out.json');
    const fixturesFile = path.resolve(cwd, 'fixtures/data.txt');
    const otherFile = path.resolve(cwd, 'src/main.ts');

    expect(isWriteAllowed(resultsFile, allowed, cwd)).toBe(true);
    expect(isWriteAllowed(fixturesFile, allowed, cwd)).toBe(true);
    expect(isWriteAllowed(otherFile, allowed, cwd)).toBe(false);
  });
});

describe('createPreToolUseHook', () => {
  const cwd = '/app';
  const signal = new AbortController().signal;

  // Build a minimal PreToolUse hook input; the hook only reads
  // hook_event_name / tool_name / tool_input.
  function input(toolName: string, filePath?: string) {
    return {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: filePath === undefined ? {} : { file_path: filePath },
      tool_use_id: 'tu_1',
    } as never;
  }

  async function decide(
    hook: ReturnType<typeof createPreToolUseHook>,
    toolName: string,
    filePath?: string,
  ): Promise<string | undefined> {
    const out = (await hook(input(toolName, filePath), 'tu_1', { signal })) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return out.hookSpecificOutput?.permissionDecision;
  }

  it('allows non-write tools regardless of path', async () => {
    const hook = createPreToolUseHook(['./results/'], cwd);
    expect(await decide(hook, 'Bash')).toBe('allow');
    expect(await decide(hook, 'Read', path.resolve(cwd, 'src/secret.ts'))).toBe('allow');
  });

  it('allows Write inside an allowed directory', async () => {
    const hook = createPreToolUseHook(['./results/'], cwd);
    expect(await decide(hook, 'Write', path.resolve(cwd, 'results/out.json'))).toBe('allow');
  });

  it('denies Write outside allowed directories', async () => {
    const hook = createPreToolUseHook(['./results/'], cwd);
    expect(await decide(hook, 'Write', path.resolve(cwd, 'src/evil.ts'))).toBe('deny');
  });

  it('denies Edit outside allowed directories', async () => {
    const hook = createPreToolUseHook(['./results/'], cwd);
    expect(await decide(hook, 'Edit', path.resolve(cwd, 'package.json'))).toBe('deny');
  });

  it('prevents prefix attack (results-evil should not match results)', async () => {
    const hook = createPreToolUseHook(['./results/'], cwd);
    expect(await decide(hook, 'Write', path.resolve(cwd, 'results-evil/hack.txt'))).toBe('deny');
  });

  it('allows all writes when allowedWriteDirs is empty', async () => {
    const hook = createPreToolUseHook([], cwd);
    expect(await decide(hook, 'Write', '/anywhere/file.txt')).toBe('allow');
  });

  it('ignores non-PreToolUse events', async () => {
    const hook = createPreToolUseHook(['./results/'], cwd);
    const out = await hook({ hook_event_name: 'PostToolUse' } as never, 'tu_1', { signal });
    expect(out).toEqual({});
  });
});
