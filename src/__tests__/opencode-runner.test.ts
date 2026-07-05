/**
 * OpenCodeRunner tests — replayed against a REAL transcript captured from
 * opencode 1.17.13 (2026-07-05, Windows, anthropic/claude-haiku-4-5, greeting
 * skill mounted at .opencode/skills/, full isolation env). See
 * fixtures/transcripts/README.md for the capture procedure and the verified
 * contract.
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
  'fixtures', 'transcripts', 'opencode', 'greeting-with-skill.jsonl',
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

describe('OpenCodeRunner with the captured transcript', () => {
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

  it('sums cost and tokens across step_finish events', async () => {
    const result = await makeRunner().runTask(makeTask());

    // Captured run has two steps (skill call, then final text):
    // cost 0.0104655 + 0.00141995, tokens input 3+5, output 52+38,
    // cache read 0+8162, cache write 8162+327.
    expect(result.costUsd).toBeCloseTo(0.01188545, 6);
    expect(result.tokens).toEqual({
      input: 8,
      output: 90,
      cacheRead: 8162,
      cacheCreation: 8489,
      total: 8 + 90 + 8162 + 8489,
    });
    expect(result.numTurns).toBe(2);
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
        { type: 'tool_use', part: { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'completed', input: { filePath: '/ws/.opencode/skills/greeting/SKILL.md' } } } },
        { type: 'text', part: { type: 'text', text: 'done', time: { start: 1, end: 2 } } },
      ],
    };

    const result = await runner.runTask(makeTask());
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('ignores the built-in customize-opencode skill (always registered by the CLI)', async () => {
    const runner = new TestableOpenCodeRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      events: [
        { type: 'tool_use', part: { type: 'tool', tool: 'skill', callID: 'c1', state: { status: 'completed', input: { name: 'customize-opencode' } } } },
        { type: 'text', part: { type: 'text', text: 'done', time: { start: 1, end: 2 } } },
      ],
    };

    const result = await runner.runTask(makeTask());
    expect(result.skillLoads).toEqual([]);
    // Still recorded as a tool call, just not a skill invocation.
    expect(result.toolCalls.map((c) => c.tool)).toEqual(['skill']);
  });

  it('layers per-trial isolation env vars over the process env', async () => {
    const runner = makeRunner();
    await runner.runTask(makeTask({ workspaceDir: '/tmp/trial-ws' }));

    const env = runner.lastCliOptions!.env!;
    const xdgRoot = path.join('/tmp/trial-ws', '.opencode-xdg');
    // opencode (Bun) trusts env.PWD over the spawn cwd — a stale PWD from
    // the launching shell re-anchors opencode away from the workspace.
    expect(env.PWD).toBe('/tmp/trial-ws');
    expect(env.XDG_CONFIG_HOME).toBe(path.join(xdgRoot, 'config'));
    expect(env.XDG_DATA_HOME).toBe(path.join(xdgRoot, 'data'));
    expect(env.XDG_CACHE_HOME).toBe(path.join(xdgRoot, 'cache'));
    expect(env.XDG_STATE_HOME).toBe(path.join(xdgRoot, 'state'));
    expect(env.OPENCODE_TEST_HOME).toBe(path.join(xdgRoot, 'home'));
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');
    expect(env.OPENCODE_PURE).toBe('1');
    // The workspace .opencode mount must stay discoverable.
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    // Provider auth (and PATH etc.) still inherited from the process env.
    expect(env.PATH ?? env.Path).toBeDefined();
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

  it('returns an error result on an error event (real nested NamedError shape)', async () => {
    const runner = new TestableOpenCodeRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      exitCode: 1,
      // Shape captured live from opencode 1.17.13 with a bad -m value.
      events: [{ type: 'error', error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_b62b8d5e' } } }],
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('Unexpected server error');
    expect(result.errorMessage).not.toContain('[object Object]');
  });

  it('extracts a message from a string error payload', async () => {
    const runner = new TestableOpenCodeRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      events: [{ type: 'error', error: 'flat string error' }],
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('flat string error');
    expect(result.errorMessage).not.toContain('[object Object]');
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
