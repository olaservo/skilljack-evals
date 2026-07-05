/**
 * Pipeline behavior tests (mocked runner):
 * - cache hits are scored against the SAME effective task as misses (nudged
 *   prompt), not the original bare-prompt task;
 * - --cwd is the base directory for task resolution and outputs;
 * - a trial that throws mid-suite still applies the workspace cleanup policy
 *   and disposes the runner.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EvalTask, TaskResult } from '../types.js';

const GREETING_SKILL_MD = `---
name: greeting
description: Use when the user greets you or asks for a welcome.
---

# Greeting Skill

Say GREETING_SUCCESS.
`;

const runnerState = {
  runTaskImpl: undefined as undefined | ((task: EvalTask) => Promise<TaskResult>),
  runCount: 0,
  disposeCount: 0,
};

function okResult(task: EvalTask): TaskResult {
  return {
    taskId: task.id,
    prompt: task.prompt,
    output: 'Hello! GREETING_SUCCESS',
    durationMs: 5,
    numTurns: 1,
    costUsd: 0,
    skillLoads: ['greeting'],
    toolCalls: [],
    isError: false,
    errorMessage: '',
  };
}

vi.mock('../runner/runner-factory.js', () => ({
  createRunner: vi.fn(async () => ({
    providerName: 'fake-runner',
    skillsMountPath: path.join('.claude', 'skills'),
    runTask: vi.fn(),
    runTaskWithTimeout: async (task: EvalTask): Promise<TaskResult> => {
      runnerState.runCount++;
      if (runnerState.runTaskImpl) return runnerState.runTaskImpl(task);
      return okResult(task);
    },
    dispose: async () => {
      runnerState.disposeCount++;
    },
  })),
}));

// Spy-wrap scoreAll to capture the prompts scoring actually sees.
const scoredPrompts: string[][] = [];
vi.mock('../scorer/scorer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scorer/scorer.js')>();
  return {
    ...actual,
    scoreAll: async (tasks: EvalTask[], results: TaskResult[], options?: unknown) => {
      scoredPrompts.push(tasks.map((t) => t.prompt));
      return actual.scoreAll(tasks, results, options as never);
    },
  };
});

const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function writeSuite(suiteDir: string, taskIds: string[]): Promise<void> {
  await fs.mkdir(path.join(suiteDir, 'skills', 'greeting'), { recursive: true });
  await fs.writeFile(path.join(suiteDir, 'skills', 'greeting', 'SKILL.md'), GREETING_SKILL_MD, 'utf-8');
  for (const id of taskIds) {
    await fs.mkdir(path.join(suiteDir, id), { recursive: true });
    await fs.writeFile(
      path.join(suiteDir, id, 'task.md'),
      '---\nexpected_skill: greeting\nchecks:\n  contains: [GREETING_SUCCESS]\n---\n\nGreet me please.\n',
      'utf-8',
    );
  }
}

afterEach(async () => {
  runnerState.runTaskImpl = undefined;
  runnerState.runCount = 0;
  scoredPrompts.length = 0;
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe('pipeline cache-hit scoring (effectiveTask parity)', () => {
  it('scores a cache hit against the nudged prompt, same as the miss path', async () => {
    const { runPipeline } = await import('../pipeline.js');
    const suiteDir = await makeTmpDir('pipeline-cache-');
    await writeSuite(suiteDir, ['t-001']);
    const outDir = path.join(suiteDir, 'out');
    const cacheDir = path.join(suiteDir, 'cache');

    const opts = {
      tasksPath: path.join(suiteDir, 't-001'),
      numRuns: 1,
      baseline: false,
      keepWorkspaces: 'none' as const,
      nudge: 'name' as const,
      configOverrides: {
        outputDir: outDir,
        htmlReport: false,
        cache: { enabled: true, dir: cacheDir, ttlHours: 1 },
      },
    };

    const first = await runPipeline(opts);
    expect(first.passed).toBe(true);
    expect(runnerState.runCount).toBe(1);

    scoredPrompts.length = 0;
    const second = await runPipeline(opts);

    // Cache hit: the runner was NOT invoked again...
    expect(runnerState.runCount).toBe(1);
    // ...and scoring still saw the NUDGED prompt (what the cached output
    // actually answered), not the bare task prompt.
    expect(scoredPrompts).toHaveLength(1);
    expect(scoredPrompts[0]).toEqual(['Greet me please.\n\nAvailable skills: greeting']);
    expect(second.passed).toBe(true);
  }, 30000);
});

describe('pipeline --cwd resolution', () => {
  it('resolves relative tasksPath, outputDir, and workspaces against cwd', async () => {
    const { runPipeline } = await import('../pipeline.js');
    const base = await makeTmpDir('pipeline-cwd-');
    await writeSuite(path.join(base, 'suite'), ['t-001']);

    const result = await runPipeline({
      tasksPath: path.join('suite', 't-001'), // relative to cwd
      cwd: base,
      numRuns: 1,
      baseline: false,
      bustCache: true,
      keepWorkspaces: 'all',
      configOverrides: { outputDir: 'out-rel', htmlReport: false },
    });

    expect(result.passed).toBe(true);
    // summary.json and workspaces land under <cwd>/out-rel, not process.cwd().
    expect(result.summaryJsonPath).toBe(path.join(base, 'out-rel', 'summary.json'));
    expect(existsSync(path.join(base, 'out-rel', 'workspaces', 't-001', 'run-1'))).toBe(true);
  }, 30000);
});

describe('pipeline abort cleanup', () => {
  it('applies the cleanup policy to created workspaces and disposes the runner when a trial throws', async () => {
    const { runPipeline } = await import('../pipeline.js');
    const suiteDir = await makeTmpDir('pipeline-abort-');
    await writeSuite(suiteDir, ['t-001', 't-002']);
    const outDir = path.join(suiteDir, 'out');

    runnerState.runTaskImpl = async (task) => {
      if (task.id === 't-002') throw new Error('boom mid-suite');
      return okResult(task);
    };

    const disposeBefore = runnerState.disposeCount;
    await expect(runPipeline({
      tasksPath: suiteDir,
      numRuns: 1,
      baseline: false,
      bustCache: true,
      keepWorkspaces: 'none',
      configOverrides: { outputDir: outDir, htmlReport: false },
    })).rejects.toThrow('boom mid-suite');

    // Runner disposed despite the abort.
    expect(runnerState.disposeCount).toBe(disposeBefore + 1);
    // Both created workspaces were cleaned per the 'none' policy — including
    // t-001's, whose trial completed before the abort.
    expect(existsSync(path.join(outDir, 'workspaces', 't-001', 'run-1'))).toBe(false);
    expect(existsSync(path.join(outDir, 'workspaces', 't-002', 'run-1'))).toBe(false);
  }, 30000);

  it('keeps aborted-run workspaces under the failures policy (unscored trials count as failed)', async () => {
    const { runPipeline } = await import('../pipeline.js');
    const suiteDir = await makeTmpDir('pipeline-abort-keep-');
    await writeSuite(suiteDir, ['t-001', 't-002']);
    const outDir = path.join(suiteDir, 'out');

    runnerState.runTaskImpl = async (task) => {
      if (task.id === 't-002') throw new Error('boom mid-suite');
      return okResult(task);
    };

    await expect(runPipeline({
      tasksPath: suiteDir,
      numRuns: 1,
      baseline: false,
      bustCache: true,
      keepWorkspaces: 'failures',
      configOverrides: { outputDir: outDir, htmlReport: false },
    })).rejects.toThrow('boom mid-suite');

    expect(existsSync(path.join(outDir, 'workspaces', 't-001', 'run-1'))).toBe(true);
    expect(existsSync(path.join(outDir, 'workspaces', 't-002', 'run-1'))).toBe(true);
  }, 30000);
});
