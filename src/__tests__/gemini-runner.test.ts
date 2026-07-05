/**
 * GeminiRunner tests — EXPERIMENTAL runner, replayed against a SYNTHETIC
 * fixture (hand-written from documented output shapes, NOT captured from a
 * live CLI). Replace with a captured transcript when gemini-cli is available.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GeminiRunner, GEMINI_CLI_INSTALL_HINT } from '../runner/gemini-runner.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { EvalTask } from '../types.js';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'transcripts', 'gemini', 'synthetic-greeting-with-skill.jsonl',
);

class TestableGeminiRunner extends GeminiRunner {
  cliResult: CliJsonlResult = emptyCliResult();
  detection: CliDetection = { available: true, version: '0.49.0' };
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

describe('GeminiRunner with the synthetic transcript', () => {
  function makeRunner(model?: string): TestableGeminiRunner {
    const runner = new TestableGeminiRunner({ model, taskTimeoutMs: 60000 });
    runner.cliResult = { ...emptyCliResult(), events: fixtureEvents };
    return runner;
  }

  it('detects the skill load via the activate_skill tool', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.isError).toBe(false);
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('captures assistant messages as output with GREETING_SUCCESS present', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.output).toContain('GREETING_SUCCESS');
    expect(result.output.trimEnd().endsWith('Warm regards!')).toBe(true);
  });

  it('records tool_use events in toolCalls and extracts tokens from result stats', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe('activate_skill');
    expect(result.tokens).toEqual({ input: 90, output: 40, cacheRead: 0, cacheCreation: 0, total: 130 });
  });

  it('spawns gemini with stream-json, yolo approval, prompt, and workspace cwd', async () => {
    const runner = makeRunner();
    const task = makeTask({ workspaceDir: '/tmp/trial-ws' });
    await runner.runTask(task);

    const opts = runner.lastCliOptions!;
    expect(opts.command).toBe('gemini');
    expect(opts.cwd).toBe('/tmp/trial-ws');
    expect(opts.args.slice(0, 2)).toEqual(['-p', task.prompt]);
    const fmtIdx = opts.args.indexOf('--output-format');
    expect(opts.args[fmtIdx + 1]).toBe('stream-json');
    const approvalIdx = opts.args.indexOf('--approval-mode');
    expect(opts.args[approvalIdx + 1]).toBe('yolo');
  });

  it('does not pass -m for the framework default model', async () => {
    const runner = makeRunner('sonnet');
    await runner.runTask(makeTask());
    expect(runner.lastCliOptions!.args).not.toContain('-m');
  });

  it('counts a read-tool SKILL.md access as the fallback invocation surface', async () => {
    const runner = new TestableGeminiRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      events: [
        { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: '/ws/.gemini/skills/greeting/SKILL.md' } },
        { type: 'result', status: 'success', stats: {} },
      ],
    };

    const result = await runner.runTask(makeTask());
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('mounts skills at .gemini/skills', () => {
    expect(new TestableGeminiRunner({}).skillsMountPath).toBe(path.join('.gemini', 'skills'));
  });
});

describe('GeminiRunner error handling', () => {
  it('returns an error result on nonzero exit', async () => {
    const runner = new TestableGeminiRunner({});
    runner.cliResult = { ...emptyCliResult(), exitCode: 2, stderr: 'auth required' };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('exited with code 2');
    expect(result.errorMessage).toContain('auth required');
  });

  it('returns an error result on an error event', async () => {
    const runner = new TestableGeminiRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      events: [{ type: 'error', message: 'quota exceeded' }],
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('quota exceeded');
  });

  it('returns the standard timeout error result', async () => {
    const runner = new TestableGeminiRunner({ taskTimeoutMs: 500 });
    runner.cliResult = { ...emptyCliResult(), exitCode: null, timedOut: true, durationMs: 520 };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('Task gr-001 timed out after 500ms');
  });

  it('surfaces an actionable error when the gemini CLI is not installed', async () => {
    const runner = new TestableGeminiRunner({});
    runner.detection = { available: false, reason: GEMINI_CLI_INSTALL_HINT };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('npm install -g @google/gemini-cli');
  });
});
