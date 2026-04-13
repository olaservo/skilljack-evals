import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { scoreDeterministic } from '../scorer/deterministic.js';
import type { EvalTask, TaskResult, DeterministicCheck } from '../types.js';

/** Build a minimal EvalTask with deterministic config */
function makeTask(det: Partial<DeterministicCheck>, overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'test-001',
    prompt: 'test prompt',
    expectedSkillLoad: 'my-skill',
    criteria: [],
    goldenChecklist: [],
    deterministic: {
      expectSkillActivation: true,
      ...det,
    },
    ...overrides,
  };
}

/** Build a minimal TaskResult */
function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'test-001',
    prompt: 'test prompt',
    output: 'some output text',
    durationMs: 100,
    numTurns: 1,
    costUsd: 0,
    skillLoads: ['my-skill'],
    toolCalls: [],
    isError: false,
    errorMessage: '',
    ...overrides,
  };
}

// ============================================
// Regression: existing behavior
// ============================================

describe('scoreDeterministic — existing behavior', () => {
  it('returns null when no deterministic check configured', () => {
    const task = makeTask({}, { deterministic: undefined });
    const result = makeResult();
    expect(scoreDeterministic(task, result)).toBeNull();
  });

  it('passes when skill is correctly activated via skillLoads', () => {
    const task = makeTask({ expectSkillActivation: true });
    const result = makeResult({ skillLoads: ['my-skill'] });
    const det = scoreDeterministic(task, result)!;
    expect(det.skillActivated).toBe(true);
    expect(det.passed).toBe(true);
  });

  it('fails when no skill activated but expected', () => {
    const task = makeTask({ expectSkillActivation: true });
    const result = makeResult({ skillLoads: [] });
    const det = scoreDeterministic(task, result)!;
    expect(det.skillActivated).toBe(false);
    expect(det.passed).toBe(false);
  });

  it('passes false-positive test when no activation', () => {
    const task = makeTask({ expectSkillActivation: false });
    const result = makeResult({ skillLoads: [] });
    const det = scoreDeterministic(task, result)!;
    expect(det.passed).toBe(true);
  });

  it('new fields default to null when not configured', () => {
    const task = makeTask({ expectSkillActivation: true });
    const result = makeResult();
    const det = scoreDeterministic(task, result)!;
    expect(det.containsCheckPassed).toBeNull();
    expect(det.notContainsCheckPassed).toBeNull();
    expect(det.regexCheckPassed).toBeNull();
    expect(det.javascriptCheckPassed).toBeNull();
    expect(det.fileExistsCheckPassed).toBeNull();
  });
});

// ============================================
// expect_contains
// ============================================

describe('expect_contains', () => {
  it('passes when all substrings found in output', () => {
    const task = makeTask({ expectContains: ['some', 'output'] });
    const result = makeResult({ output: 'some output text' });
    const det = scoreDeterministic(task, result)!;
    expect(det.containsCheckPassed).toBe(true);
    expect(det.passed).toBe(true);
    expect(det.details).toContain('All expected substrings found in output');
  });

  it('fails when any substring is missing from output', () => {
    const task = makeTask({ expectContains: ['some', 'missing'] });
    const result = makeResult({ output: 'some output text' });
    const det = scoreDeterministic(task, result)!;
    expect(det.containsCheckPassed).toBe(false);
    expect(det.passed).toBe(false);
    expect(det.details.some(d => d.includes('"missing"'))).toBe(true);
  });

  it('is case-sensitive', () => {
    const task = makeTask({ expectContains: ['SOME'] });
    const result = makeResult({ output: 'some output text' });
    const det = scoreDeterministic(task, result)!;
    expect(det.containsCheckPassed).toBe(false);
  });

  it('handles empty output', () => {
    const task = makeTask({ expectContains: ['anything'] });
    const result = makeResult({ output: '' });
    const det = scoreDeterministic(task, result)!;
    expect(det.containsCheckPassed).toBe(false);
  });

  it('is skipped (null) when not configured', () => {
    const task = makeTask({});
    const result = makeResult();
    const det = scoreDeterministic(task, result)!;
    expect(det.containsCheckPassed).toBeNull();
  });
});

// ============================================
// expect_not_contains
// ============================================

describe('expect_not_contains', () => {
  it('passes when no forbidden substrings found', () => {
    const task = makeTask({ expectNotContains: ['error', 'FIXME'] });
    const result = makeResult({ output: 'clean output' });
    const det = scoreDeterministic(task, result)!;
    expect(det.notContainsCheckPassed).toBe(true);
    expect(det.passed).toBe(true);
    expect(det.details).toContain('No forbidden substrings found in output');
  });

  it('fails when any forbidden substring found', () => {
    const task = makeTask({ expectNotContains: ['error', 'FIXME'] });
    const result = makeResult({ output: 'there was an error' });
    const det = scoreDeterministic(task, result)!;
    expect(det.notContainsCheckPassed).toBe(false);
    expect(det.passed).toBe(false);
    expect(det.details.some(d => d.includes('"error"'))).toBe(true);
  });

  it('is case-sensitive', () => {
    const task = makeTask({ expectNotContains: ['ERROR'] });
    const result = makeResult({ output: 'there was an error' });
    const det = scoreDeterministic(task, result)!;
    expect(det.notContainsCheckPassed).toBe(true);
  });

  it('is skipped (null) when not configured', () => {
    const task = makeTask({});
    const result = makeResult();
    const det = scoreDeterministic(task, result)!;
    expect(det.notContainsCheckPassed).toBeNull();
  });
});

// ============================================
// expect_regex
// ============================================

describe('expect_regex', () => {
  it('passes when all patterns match output', () => {
    const task = makeTask({ expectRegex: ['\\d{4}-\\d{2}-\\d{2}', 'date'] });
    const result = makeResult({ output: 'The date is 2024-01-15' });
    const det = scoreDeterministic(task, result)!;
    expect(det.regexCheckPassed).toBe(true);
    expect(det.passed).toBe(true);
    expect(det.details).toContain('All regex patterns matched');
  });

  it('fails when any pattern does not match', () => {
    const task = makeTask({ expectRegex: ['\\d{4}-\\d{2}-\\d{2}', 'missing'] });
    const result = makeResult({ output: 'The date is 2024-01-15' });
    const det = scoreDeterministic(task, result)!;
    expect(det.regexCheckPassed).toBe(false);
    expect(det.passed).toBe(false);
    expect(det.details.some(d => d.includes('/missing/'))).toBe(true);
  });

  it('handles invalid regex gracefully', () => {
    const task = makeTask({ expectRegex: ['[invalid'] });
    const result = makeResult({ output: 'some text' });
    const det = scoreDeterministic(task, result)!;
    expect(det.regexCheckPassed).toBe(false);
    expect(det.details.some(d => d.includes('invalid regex'))).toBe(true);
  });

  it('is skipped (null) when not configured', () => {
    const task = makeTask({});
    const result = makeResult();
    const det = scoreDeterministic(task, result)!;
    expect(det.regexCheckPassed).toBeNull();
  });
});

// ============================================
// expect_javascript
// ============================================

describe('expect_javascript', () => {
  it('passes when expression returns true', () => {
    const task = makeTask({ expectJavascript: 'output.length > 5' });
    const result = makeResult({ output: 'hello world' });
    const det = scoreDeterministic(task, result)!;
    expect(det.javascriptCheckPassed).toBe(true);
    expect(det.passed).toBe(true);
    expect(det.details).toContain('JavaScript assertion passed');
  });

  it('fails when expression returns false', () => {
    const task = makeTask({ expectJavascript: 'output.length > 100' });
    const result = makeResult({ output: 'short' });
    const det = scoreDeterministic(task, result)!;
    expect(det.javascriptCheckPassed).toBe(false);
    expect(det.passed).toBe(false);
    expect(det.details.some(d => d.includes('returned false'))).toBe(true);
  });

  it('fails when expression returns truthy non-boolean', () => {
    const task = makeTask({ expectJavascript: 'output.length' });
    const result = makeResult({ output: 'hello' });
    const det = scoreDeterministic(task, result)!;
    // output.length = 5 (truthy but not === true)
    expect(det.javascriptCheckPassed).toBe(false);
    expect(det.details.some(d => d.includes('returned 5'))).toBe(true);
  });

  it('fails gracefully on runtime error', () => {
    const task = makeTask({ expectJavascript: 'undefinedVar.method()' });
    const result = makeResult();
    const det = scoreDeterministic(task, result)!;
    expect(det.javascriptCheckPassed).toBe(false);
    expect(det.details.some(d => d.includes('JavaScript assertion error'))).toBe(true);
  });

  it('has output variable in scope', () => {
    const task = makeTask({ expectJavascript: 'typeof output === "string"' });
    const result = makeResult({ output: 'test value' });
    const det = scoreDeterministic(task, result)!;
    expect(det.javascriptCheckPassed).toBe(true);
  });

  it('can evaluate complex expressions', () => {
    const task = makeTask({
      expectJavascript: 'output.split("\\n").length > 2',
    });
    const result = makeResult({ output: 'line1\nline2\nline3' });
    const det = scoreDeterministic(task, result)!;
    expect(det.javascriptCheckPassed).toBe(true);
  });

  it('is skipped (null) when not configured', () => {
    const task = makeTask({});
    const result = makeResult();
    const det = scoreDeterministic(task, result)!;
    expect(det.javascriptCheckPassed).toBeNull();
  });
});

// ============================================
// expect_file_exists
// ============================================

describe('expect_file_exists', () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'det-test-'));
  }

  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  it('passes when all files exist', () => {
    setup();
    try {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'content');

      const task = makeTask({ expectFileExists: ['a.txt', 'b.txt'] });
      const result = makeResult();
      const det = scoreDeterministic(task, result, { cwd: tmpDir })!;
      expect(det.fileExistsCheckPassed).toBe(true);
      expect(det.passed).toBe(true);
      expect(det.details).toContain('All expected files exist');
    } finally {
      teardown();
    }
  });

  it('fails when any file is missing', () => {
    setup();
    try {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content');

      const task = makeTask({ expectFileExists: ['a.txt', 'missing.txt'] });
      const result = makeResult();
      const det = scoreDeterministic(task, result, { cwd: tmpDir })!;
      expect(det.fileExistsCheckPassed).toBe(false);
      expect(det.passed).toBe(false);
      expect(det.details.some(d => d.includes('missing.txt'))).toBe(true);
    } finally {
      teardown();
    }
  });

  it('resolves relative paths against cwd option', () => {
    setup();
    try {
      const subDir = path.join(tmpDir, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'file.txt'), 'content');

      const task = makeTask({ expectFileExists: ['sub/file.txt'] });
      const result = makeResult();
      const det = scoreDeterministic(task, result, { cwd: tmpDir })!;
      expect(det.fileExistsCheckPassed).toBe(true);
    } finally {
      teardown();
    }
  });

  it('handles absolute paths within cwd', () => {
    setup();
    try {
      const absPath = path.join(tmpDir, 'abs.txt');
      fs.writeFileSync(absPath, 'content');

      const task = makeTask({ expectFileExists: [absPath] });
      const result = makeResult();
      const det = scoreDeterministic(task, result, { cwd: tmpDir })!;
      expect(det.fileExistsCheckPassed).toBe(true);
    } finally {
      teardown();
    }
  });

  it('rejects paths outside cwd', () => {
    setup();
    try {
      const absPath = path.join(tmpDir, 'abs.txt');
      fs.writeFileSync(absPath, 'content');

      const task = makeTask({ expectFileExists: [absPath] });
      const result = makeResult();
      const det = scoreDeterministic(task, result, { cwd: '/nonexistent' })!;
      expect(det.fileExistsCheckPassed).toBe(false);
      expect(det.details.some((d: string) => d.includes('outside working directory'))).toBe(true);
    } finally {
      teardown();
    }
  });

  it('is skipped (null) when not configured', () => {
    const task = makeTask({});
    const result = makeResult();
    const det = scoreDeterministic(task, result)!;
    expect(det.fileExistsCheckPassed).toBeNull();
  });
});

// ============================================
// Pass/fail integration
// ============================================

describe('pass/fail logic', () => {
  it('requires all checks to pass for positive test', () => {
    const task = makeTask({
      expectSkillActivation: true,
      expectContains: ['hello'],
      expectNotContains: ['error'],
      expectRegex: ['hello'],
      expectJavascript: 'output.includes("hello")',
    });
    const result = makeResult({ output: 'hello world' });
    const det = scoreDeterministic(task, result)!;
    expect(det.passed).toBe(true);
    expect(det.containsCheckPassed).toBe(true);
    expect(det.notContainsCheckPassed).toBe(true);
    expect(det.regexCheckPassed).toBe(true);
    expect(det.javascriptCheckPassed).toBe(true);
  });

  it('fails if any single check fails (positive test)', () => {
    const task = makeTask({
      expectSkillActivation: true,
      expectContains: ['hello'],
      expectNotContains: ['world'], // "world" IS in output → this should fail
    });
    const result = makeResult({ output: 'hello world' });
    const det = scoreDeterministic(task, result)!;
    expect(det.containsCheckPassed).toBe(true);
    expect(det.notContainsCheckPassed).toBe(false);
    expect(det.passed).toBe(false);
  });

  it('only checks skill non-activation for negative test', () => {
    // Even though contains would fail, negative test only cares about non-activation
    const task = makeTask({
      expectSkillActivation: false,
      expectContains: ['missing substring'],
    });
    const result = makeResult({ output: 'some output', skillLoads: [] });
    const det = scoreDeterministic(task, result)!;
    expect(det.passed).toBe(true); // Passed because skill wasn't activated
  });
});
