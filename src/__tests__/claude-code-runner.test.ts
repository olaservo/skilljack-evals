import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ClaudeCodeRunner, CLAUDE_CLI_INSTALL_HINT } from '../runner/claude-code-runner.js';
import { CodexRunner } from '../runner/codex-runner.js';
import { skillNameFromReadPath, resetCliRunnerSecurityWarningForTests } from '../runner/base-runner.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { EvalTask, TaskResult } from '../types.js';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'transcripts', 'claude-code', 'greeting-with-skill.jsonl',
);

/**
 * Testable subclass injecting the subprocess fn, mirroring the dynamicImport
 * injection pattern used by other runner tests.
 */
class TestableClaudeCodeRunner extends ClaudeCodeRunner {
  cliResult: CliJsonlResult = emptyCliResult();
  detection: CliDetection = { available: true, version: '2.1.200 (Claude Code)' };
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
class IncrementalClaudeCodeRunner extends TestableClaudeCodeRunner {
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

describe('ClaudeCodeRunner with the real captured transcript', () => {
  function makeRunner(): TestableClaudeCodeRunner {
    const runner = new TestableClaudeCodeRunner({ model: 'haiku', taskTimeoutMs: 60000 });
    runner.cliResult = { ...emptyCliResult(), events: fixtureEvents };
    return runner;
  }

  it('detects the skill load via the Skill tool', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.isError).toBe(false);
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('records the Skill tool_use in toolCalls', async () => {
    const result = await makeRunner().runTask(makeTask());

    const skillCall = result.toolCalls.find((c) => c.tool === 'Skill');
    expect(skillCall).toBeDefined();
    expect((skillCall!.input as { skill: string }).skill).toBe('greeting');
  });

  it('captures the final output, turns, cost, duration, and tokens from the result event', async () => {
    const result = await makeRunner().runTask(makeTask());

    expect(result.output).toContain('GREETING_SUCCESS');
    expect(result.numTurns).toBe(3);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.durationMs).toBe(6601);
    expect(result.tokens).toEqual({
      input: 19,
      output: 319,
      cacheRead: 51049,
      cacheCreation: 9112,
      total: 19 + 319 + 51049 + 9112,
    });
  });

  it('spawns claude with the required flags, prompt, model, and workspace cwd', async () => {
    const runner = makeRunner();
    const task = makeTask({ workspaceDir: '/tmp/trial-ws' });
    await runner.runTask(task);

    const opts = runner.lastCliOptions!;
    expect(opts.command).toBe('claude');
    expect(opts.cwd).toBe('/tmp/trial-ws');
    expect(opts.timeoutMs).toBe(60000);
    expect(opts.args.slice(0, 2)).toEqual(['-p', task.prompt]);
    expect(opts.args).toContain('--output-format');
    expect(opts.args).toContain('stream-json');
    expect(opts.args).toContain('--verbose');
    expect(opts.args).toContain('--dangerously-skip-permissions');
    const modelIdx = opts.args.indexOf('--model');
    expect(opts.args[modelIdx + 1]).toBe('haiku');
    // REQUIRED: prevents global ~/.claude settings/hooks leaking into trials.
    const sourcesIdx = opts.args.indexOf('--setting-sources');
    expect(opts.args[sourcesIdx + 1]).toBe('project');
  });

  it('prefers task.timeoutMs over the runner default', async () => {
    const runner = makeRunner();
    await runner.runTask(makeTask({ timeoutMs: 1234 }));
    expect(runner.lastCliOptions!.timeoutMs).toBe(1234);
  });

  it('produces the same TaskResult via the incremental onEvent path as the events-array path', async () => {
    // toolCalls timestamps are Date.now() at fold time; ignore them.
    const stripTimestamps = (r: TaskResult) => ({
      ...r,
      toolCalls: r.toolCalls.map(({ timestamp: _timestamp, ...rest }) => rest),
    });

    const arrayResult = await makeRunner().runTask(makeTask());

    const incremental = new IncrementalClaudeCodeRunner({ model: 'haiku', taskTimeoutMs: 60000 });
    incremental.cliResult = { ...emptyCliResult(), events: fixtureEvents };
    const incrementalResult = await incremental.runTask(makeTask());

    expect(incrementalResult.isError).toBe(false);
    expect(stripTimestamps(incrementalResult)).toEqual(stripTimestamps(arrayResult));
  });
});

describe('ClaudeCodeRunner skill-read fallback', () => {
  function readEvent(filePath: string): unknown {
    return {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: filePath } },
        ],
      },
    };
  }

  const resultEvent = {
    type: 'result',
    subtype: 'success',
    result: 'done',
    num_turns: 1,
    total_cost_usd: 0.001,
    duration_ms: 50,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };

  it('counts a SKILL.md Read as a skill load when countReadAsFallback is set', async () => {
    const runner = new TestableClaudeCodeRunner({ model: 'haiku', countReadAsFallback: true });
    runner.cliResult = {
      ...emptyCliResult(),
      events: [readEvent('C:\\ws\\.claude\\skills\\greeting\\SKILL.md'), resultEvent],
    };

    const result = await runner.runTask(makeTask());
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('ignores SKILL.md reads when countReadAsFallback is off', async () => {
    const runner = new TestableClaudeCodeRunner({ model: 'haiku' });
    runner.cliResult = {
      ...emptyCliResult(),
      events: [readEvent('/ws/.claude/skills/greeting/SKILL.md'), resultEvent],
    };

    const result = await runner.runTask(makeTask());
    expect(result.skillLoads).toEqual([]);
  });

  it('skillNameFromReadPath handles both path separators', () => {
    expect(skillNameFromReadPath('C:\\ws\\.claude\\skills\\greeting\\SKILL.md')).toBe('greeting');
    expect(skillNameFromReadPath('/ws/.claude/skills/greeting/SKILL.md')).toBe('greeting');
    expect(skillNameFromReadPath('/ws/src/index.ts')).toBeUndefined();
  });
});

describe('ClaudeCodeRunner error handling', () => {
  it('returns an error result with a stderr excerpt on nonzero exit', async () => {
    const runner = new TestableClaudeCodeRunner({ model: 'haiku' });
    runner.cliResult = {
      ...emptyCliResult(),
      exitCode: 1,
      stderr: 'Invalid API key. Please run /login',
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('exited without a result event');
    expect(result.errorMessage).toContain('Invalid API key');
  });

  it('returns an error result when the CLI exits 0 without a result event', async () => {
    const runner = new TestableClaudeCodeRunner({ model: 'haiku' });
    runner.cliResult = {
      ...emptyCliResult(),
      events: [{ type: 'system', subtype: 'init' }],
    };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('exited without a result event');
  });

  it('returns the standard timeout error result when the process tree was killed', async () => {
    const runner = new TestableClaudeCodeRunner({ model: 'haiku', taskTimeoutMs: 500 });
    runner.cliResult = { ...emptyCliResult(), exitCode: null, timedOut: true, durationMs: 520 };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('Task gr-001 timed out after 500ms');
  });

  it('surfaces an actionable error when the claude CLI is not installed', async () => {
    const runner = new TestableClaudeCodeRunner({ model: 'haiku' });
    runner.detection = { available: false, reason: CLAUDE_CLI_INSTALL_HINT };

    const result = await runner.runTask(makeTask());

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('Claude Code CLI not found on PATH');
    expect(result.errorMessage).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('CLI runner security warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once per process that the agent runs unrestricted, on first CLI runner construction', () => {
    resetCliRunnerSecurityWarningForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new ClaudeCodeRunner({ model: 'haiku' });

    const securityWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('no write restrictions'));
    expect(securityWarnings).toHaveLength(1);
    expect(String(securityWarnings[0][0])).toContain('claude-code runs the agent with all permissions granted on this host');
    expect(String(securityWarnings[0][0])).toContain('--sandbox docker isolates verifiers, not the agent');

    // Constructing more CLI runners does not repeat the warning.
    new ClaudeCodeRunner({ model: 'haiku' });
    new CodexRunner({ model: 'gpt-5.2-codex' });
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('no write restrictions'))).toHaveLength(1);
  });
});
