/**
 * OpenCodeRunner tests — EXPERIMENTAL runner, replayed against a SYNTHETIC
 * fixture (hand-written from documented output shapes, NOT captured from a
 * live CLI). Replace with a captured transcript when opencode is available.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { OpenCodeRunner, OPENCODE_CLI_INSTALL_HINT } from '../runner/opencode-runner.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { EvalTask } from '../types.js';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'transcripts', 'opencode', 'synthetic-greeting-with-skill.jsonl',
);

class TestableOpenCodeRunner extends OpenCodeRunner {
  cliResult: CliJsonlResult = emptyCliResult();
  detection: CliDetection = { available: true, version: '1.0.0' };
  lastCliOptions?: RunCliJsonlOptions;

  protected override runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    this.lastCliOptions = options;
    return Promise.resolve(this.cliResult);
  }

  protected override detect(): Promise<CliDetection> {
    return Promise.resolve(this.detection);
  }
}

function emptyCliResult(): CliJsonlResult {
  return { events: [], rawLines: [], stderr: '', exitCode: 0, durationMs: 100, timedOut: false };
}

function makeTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'gr-001',
    prompt: 'Hello! Please greet me using the greeting skill.',
    expectedSkillLoad: 'greeting',
    criteria: [{ dimension: 'discovery', weight: 1, description: 'test' }],
    goldenChecklist: [],
    ...overrides,
  };
}

let fixtureEvents: unknown[];

beforeAll(async () => {
  const content = await fs.readFile(FIXTURE_PATH, 'utf-8');
  fixtureEvents = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
});

describe('OpenCodeRunner with the synthetic transcript', () => {
  function makeRunner(model?: string): TestableOpenCodeRunner {
    const runner = new TestableOpenCodeRunner({ model, taskTimeoutMs: 60000 });
    runner.cliResult = { ...emptyCliResult(), events: fixtureEvents };
    return runner;
  }

  it('detects the skill load via the native skill tool', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.isError).toBe(false);
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('captures text events as output with GREETING_SUCCESS present', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.output).toContain('GREETING_SUCCESS');
    expect(result.output.trimEnd().endsWith('Warm regards!')).toBe(true);
  });

  it('extracts cost and tokens from step_finish', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.costUsd).toBeCloseTo(0.0021);
    expect(result.tokens).toEqual({
      input: 900,
      output: 80,
      cacheRead: 300,
      cacheCreation: 50,
      total: 900 + 80 + 300 + 50,
    });
    expect(result.numTurns).toBe(1);
  });

  it('spawns opencode run with json format, --auto, prompt, and workspace cwd', async () => {
    const runner = makeRunner();
    const task = makeTask({ workspaceDir: '/tmp/trial-ws' });
    await runner.runTask(task);

    const opts = runner.lastCliOptions!;
    expect(opts.command).toBe('opencode');
    expect(opts.cwd).toBe('/tmp/trial-ws');
    expect(opts.args[0]).toBe('run');
    const fmtIdx = opts.args.indexOf('--format');
    expect(opts.args[fmtIdx + 1]).toBe('json');
    // REQUIRED: non-interactive permission requests are auto-REJECTED without --auto.
    expect(opts.args).toContain('--auto');
    expect(opts.args[opts.args.length - 1]).toBe(task.prompt);
  });

  it('does not pass --model for the framework default model', async () => {
    const runner = makeRunner('sonnet');
    await runner.runTask(makeTask());
    expect(runner.lastCliOptions!.args).not.toContain('--model');
  });

  it('passes --model for an explicit provider/model', async () => {
    const runner = makeRunner('anthropic/claude-sonnet-4-6');
    await runner.runTask(makeTask());
    const args = runner.lastCliOptions!.args;
    const idx = args.indexOf('--model');
    expect(args[idx + 1]).toBe('anthropic/claude-sonnet-4-6');
  });

  it('counts a read-tool SKILL.md access as the fallback invocation surface', async () => {
    const runner = new TestableOpenCodeRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      events: [
        { type: 'tool_use', tool: 'read', callID: 'c1', state: { status: 'completed', input: { filePath: '/ws/.opencode/skills/greeting/SKILL.md' } } },
        { type: 'text', text: 'done' },
      ],
    };

    const result = await runner.runTask(makeTask());
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('mounts skills at .opencode/skills (plural, per current docs)', () => {
    expect(new TestableOpenCodeRunner({}).skillsMountPath).toBe(path.join('.opencode', 'skills'));
  });
});

describe('OpenCodeRunner error handling', () => {
  it('returns an error result on nonzero exit', async () => {
    const runner = new TestableOpenCodeRunner({});
    runner.cliResult = { ...emptyCliResult(), exitCode: 1, stderr: 'no provider configured' };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('exited with code 1');
    expect(result.errorMessage).toContain('no provider configured');
  });

  it('returns an error result on an error event', async () => {
    const runner = new TestableOpenCodeRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      events: [{ type: 'error', part: { message: 'model refused' } }],
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('model refused');
  });

  it('returns the standard timeout error result', async () => {
    const runner = new TestableOpenCodeRunner({ taskTimeoutMs: 500 });
    runner.cliResult = { ...emptyCliResult(), exitCode: null, timedOut: true, durationMs: 520 };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('Task gr-001 timed out after 500ms');
  });

  it('surfaces an actionable error when the opencode CLI is not installed', async () => {
    const runner = new TestableOpenCodeRunner({});
    runner.detection = { available: false, reason: OPENCODE_CLI_INSTALL_HINT };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('npm install -g opencode-ai');
  });
});
