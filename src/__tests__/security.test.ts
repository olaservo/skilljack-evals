import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isWriteAllowed } from '../runner/security.js';

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
