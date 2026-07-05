import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { CodexRunner, CODEX_CLI_INSTALL_HINT, skillNameFromCommand } from '../runner/codex-runner.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { EvalTask, TaskResult } from '../types.js';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'transcripts', 'codex', 'greeting-with-skill.jsonl',
);

/** Testable subclass injecting the subprocess fn (same pattern as claude-code). */
class TestableCodexRunner extends CodexRunner {
  cliResult: CliJsonlResult = emptyCliResult();
  detection: CliDetection = { available: true, version: 'codex-cli 0.137.0' };
  lastCliOptions?: RunCliJsonlOptions;

  protected override runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    this.lastCliOptions = options;
    return Promise.resolve(this.cliResult);
  }

  protected override detect(): Promise<CliDetection> {
    return Promise.resolve(this.detection);
  }
}

/**
 * Fake that streams fixture events through options.onEvent (the incremental
 * folding path used by the real runCliJsonl) instead of returning an events
 * array — result.events stays [] exactly like real onEvent mode.
 */
class IncrementalCodexRunner extends TestableCodexRunner {
  protected override runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    this.lastCliOptions = options;
    for (const event of this.cliResult.events) {
      options.onEvent?.(event);
    }
    return Promise.resolve({ ...this.cliResult, events: [] });
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

describe('CodexRunner with the real captured transcript', () => {
  function makeRunner(model?: string): TestableCodexRunner {
    const runner = new TestableCodexRunner({ model, taskTimeoutMs: 60000 });
    runner.cliResult = { ...emptyCliResult(), events: fixtureEvents };
    return runner;
  }

  it('detects the skill load via the SKILL.md shell read (file-read surface)', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.isError).toBe(false);
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('records command_execution items in toolCalls', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe('command_execution');
    expect((result.toolCalls[0].input as { command: string }).command).toContain('SKILL.md');
  });

  it('captures the final agent message as output with GREETING_SUCCESS present', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.output).toContain('GREETING_SUCCESS');
    // Output ends with the final agent_message (the answer).
    expect(result.output.trimEnd().endsWith('Warm regards!')).toBe(true);
  });

  it('extracts token usage from turn.completed (cached tokens split out of input)', async () => {
    const result = await makeRunner().runTask(makeTask());

    // Fixture usage: input_tokens 26856 (incl. 18176 cached), output_tokens 291.
    expect(result.tokens).toEqual({
      input: 26856 - 18176,
      output: 291,
      cacheRead: 18176,
      cacheCreation: 0,
      total: 26856 + 291,
    });
    expect(result.numTurns).toBe(1);
    // Cost is a rough estimate from tokens (codex reports no cost).
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('spawns codex exec with --json, isolation flags, prompt, and workspace cwd', async () => {
    const runner = makeRunner();
    const task = makeTask({ workspaceDir: '/tmp/trial-ws' });
    await runner.runTask(task);

    const opts = runner.lastCliOptions!;
    expect(opts.command).toBe('codex');
    expect(opts.cwd).toBe('/tmp/trial-ws');
    expect(opts.timeoutMs).toBe(60000);
    expect(opts.args[0]).toBe('exec');
    expect(opts.args).toContain('--json');
    expect(opts.args).toContain('--skip-git-repo-check');
    // Isolation: skip user config.toml (MCP-server leak found in the spike),
    // keep CODEX_HOME auth, don't persist session files.
    expect(opts.args).toContain('--ignore-user-config');
    expect(opts.args).toContain('--ephemeral');
    // Prompt is the last positional argument.
    expect(opts.args[opts.args.length - 1]).toBe(task.prompt);
  });

  it('does not pass -m for the framework default model (codex picks its own)', async () => {
    const runner = makeRunner('sonnet');
    await runner.runTask(makeTask());
    expect(runner.lastCliOptions!.args).not.toContain('-m');
  });

  it('passes -m when a codex model is explicitly configured', async () => {
    const runner = makeRunner('gpt-5.1-codex');
    await runner.runTask(makeTask());
    const args = runner.lastCliOptions!.args;
    const idx = args.indexOf('-m');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('gpt-5.1-codex');
  });

  it('produces the same TaskResult via the incremental onEvent path as the events-array path', async () => {
    // toolCalls timestamps are Date.now() at fold time; ignore them.
    const stripTimestamps = (r: TaskResult) => ({
      ...r,
      toolCalls: r.toolCalls.map(({ timestamp: _timestamp, ...rest }) => rest),
    });

    const arrayResult = await makeRunner().runTask(makeTask());

    const incremental = new IncrementalCodexRunner({ taskTimeoutMs: 60000 });
    incremental.cliResult = { ...emptyCliResult(), events: fixtureEvents };
    const incrementalResult = await incremental.runTask(makeTask());

    expect(incrementalResult.isError).toBe(false);
    expect(stripTimestamps(incrementalResult)).toEqual(stripTimestamps(arrayResult));
  });
});

describe('skillNameFromCommand', () => {
  it('extracts the skill name from a doubled-backslash PowerShell read', () => {
    const command = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -Path \'C:\\\\ws\\\\.agents\\\\skills\\\\greeting\\\\SKILL.md\'"';
    expect(skillNameFromCommand(command)).toBe('greeting');
  });

  it('extracts the skill name from a POSIX cat', () => {
    expect(skillNameFromCommand('cat /ws/.agents/skills/pdf-tools/SKILL.md')).toBe('pdf-tools');
  });

  it('returns undefined for commands without SKILL.md', () => {
    expect(skillNameFromCommand('ls -la')).toBeUndefined();
    expect(skillNameFromCommand('cat /ws/.agents/skills/greeting/README.md')).toBeUndefined();
  });
});

describe('CodexRunner error handling', () => {
  it('returns an error result with a stderr excerpt on nonzero exit', async () => {
    const runner = new TestableCodexRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      exitCode: 1,
      stderr: 'error: not logged in — run codex login',
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('exited with code 1');
    expect(result.errorMessage).toContain('not logged in');
  });

  it('returns an error result when the CLI exits 0 without a completed turn', async () => {
    const runner = new TestableCodexRunner({});
    runner.cliResult = {
      ...emptyCliResult(),
      events: [{ type: 'thread.started', thread_id: 't1' }],
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('exited without a completed turn');
  });

  it('returns the standard timeout error result when the process tree was killed', async () => {
    const runner = new TestableCodexRunner({ taskTimeoutMs: 500 });
    runner.cliResult = { ...emptyCliResult(), exitCode: null, timedOut: true, durationMs: 520 };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('Task gr-001 timed out after 500ms');
  });

  it('surfaces an actionable error when the codex CLI is not installed', async () => {
    const runner = new TestableCodexRunner({});
    runner.detection = { available: false, reason: CODEX_CLI_INSTALL_HINT };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('Codex CLI not found on PATH');
    expect(result.errorMessage).toContain('npm install -g @openai/codex');
  });
});

describe('CodexRunner skills mount path', () => {
  it('mounts skills at .agents/skills', () => {
    const runner = new TestableCodexRunner({});
    expect(runner.skillsMountPath).toBe(path.join('.agents', 'skills'));
  });
});
