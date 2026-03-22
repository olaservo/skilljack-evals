import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopilotSdkRunner } from '../runner/copilot-sdk-runner.js';
import type { EvalTask } from '../types.js';

const mockTask: EvalTask = {
  id: 'test-1',
  prompt: 'Say hello',
  expectedSkillLoad: 'greeting',
  criteria: [{ dimension: 'discovery', weight: 0.3, description: 'test' }],
  goldenChecklist: ['Says hello'],
};

/**
 * Testable subclass that overrides dynamicImport to inject mock modules
 * and exposes the internal client for assertions.
 */
class TestableCopilotSdkRunner extends CopilotSdkRunner {
  public mockModules: Record<string, any> = {};

  protected override async dynamicImport(pkg: string, _hint: string): Promise<any> {
    if (this.mockModules[pkg]) return this.mockModules[pkg];
    throw new Error(`Module "${pkg}" not available`);
  }

  /** Expose internal client for test assertions. */
  get _client(): any {
    return (this as any).client;
  }
}

/** Create mock session/client functions. */
function createMocks(overrides: {
  sendResult?: any;
  sendError?: Error;
} = {}) {
  const session = {
    sendAndWait: vi.fn(async () => {
      if (overrides.sendError) throw overrides.sendError;
      return overrides.sendResult ?? {
        type: 'assistant.message',
        data: { content: 'Hello!' },
      };
    }),
    disconnect: vi.fn(async () => {}),
  };

  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const createSession = vi.fn(async () => session);

  // Use a proper function constructor so `new` works
  const CopilotClientClass = function CopilotClient(this: any) {
    this.start = start;
    this.stop = stop;
    this.createSession = createSession;
  };

  const sdkModule = {
    CopilotClient: CopilotClientClass,
    approveAll: () => ({ kind: 'approved' as const }),
  };

  return { session, start, stop, createSession, sdkModule };
}

describe('CopilotSdkRunner', () => {
  let runner: TestableCopilotSdkRunner;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    runner = new TestableCopilotSdkRunner({
      cwd: '/tmp/test',
      model: 'gpt-5',
      skillsDir: '/skills',
    });
    runner.mockModules = {
      '@github/copilot-sdk': mocks.sdkModule,
    };
  });

  it('has correct provider name', () => {
    expect(runner.providerName).toBe('copilot-sdk');
  });

  it('creates client and session', async () => {
    await runner.runTask(mockTask);

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.createSession).toHaveBeenCalledOnce();

    const sessionConfig = mocks.createSession.mock.calls[0][0];
    expect(sessionConfig.model).toBe('gpt-5');
    expect(sessionConfig.workingDirectory).toBe('/tmp/test');
    expect(sessionConfig.skillDirectories).toEqual(['/skills']);
    expect(sessionConfig.onPermissionRequest).toBeDefined();
    expect(sessionConfig.hooks).toBeDefined();
    expect(sessionConfig.onEvent).toBeDefined();
  });

  it('returns successful result with output', async () => {
    const result = await runner.runTask(mockTask);

    expect(result.isError).toBe(false);
    expect(result.taskId).toBe('test-1');
    expect(result.output).toBe('Hello!');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBe(0);
  });

  it('sends task prompt via sendAndWait', async () => {
    await runner.runTask(mockTask);

    expect(mocks.session.sendAndWait).toHaveBeenCalledOnce();
    const [options, timeout] = mocks.session.sendAndWait.mock.calls[0];
    expect(options.prompt).toBe('Say hello');
    expect(timeout).toBe(300000);
  });

  it('disconnects session after task', async () => {
    await runner.runTask(mockTask);
    expect(mocks.session.disconnect).toHaveBeenCalledOnce();
  });

  it('tracks tool calls from onPostToolUse hook', async () => {
    mocks.createSession.mockImplementation(async (config: any) => {
      const session = {
        sendAndWait: vi.fn(async () => {
          config.hooks.onPostToolUse({
            toolName: 'Read',
            toolArgs: { file_path: '/tmp/test/file.txt' },
            toolResult: { textResultForLlm: 'file content', resultType: 'success' },
          });
          config.hooks.onPostToolUse({
            toolName: 'Bash',
            toolArgs: { command: 'echo hi' },
            toolResult: { textResultForLlm: 'hi', resultType: 'success' },
          });
          return { type: 'assistant.message', data: { content: 'Done!' } };
        }),
        disconnect: vi.fn(async () => {}),
      };
      return session;
    });

    const result = await runner.runTask(mockTask);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].tool).toBe('Read');
    expect(result.toolCalls[1].tool).toBe('Bash');
  });

  it('detects skill loads from skill.invoked events', async () => {
    mocks.createSession.mockImplementation(async (config: any) => {
      const session = {
        sendAndWait: vi.fn(async () => {
          config.onEvent({
            type: 'skill.invoked',
            data: { name: 'greeting', path: '/skills/greeting/SKILL.md' },
          });
          return { type: 'assistant.message', data: { content: 'Hello!' } };
        }),
        disconnect: vi.fn(async () => {}),
      };
      return session;
    });

    const result = await runner.runTask(mockTask);
    expect(result.skillLoads).toContain('greeting');
  });

  it('deduplicates skill loads', async () => {
    mocks.createSession.mockImplementation(async (config: any) => {
      const session = {
        sendAndWait: vi.fn(async () => {
          config.onEvent({
            type: 'skill.invoked',
            data: { name: 'greeting', path: '/skills/greeting/SKILL.md' },
          });
          config.onEvent({
            type: 'skill.invoked',
            data: { name: 'greeting', path: '/skills/greeting/SKILL.md' },
          });
          return { type: 'assistant.message', data: { content: 'Hello!' } };
        }),
        disconnect: vi.fn(async () => {}),
      };
      return session;
    });

    const result = await runner.runTask(mockTask);
    expect(result.skillLoads).toEqual(['greeting']);
  });

  it('returns error result on sendAndWait failure', async () => {
    mocks.session.sendAndWait.mockRejectedValue(new Error('Connection lost'));

    const result = await runner.runTask(mockTask);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('Connection lost');
    expect(result.taskId).toBe('test-1');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error result when dynamic import fails', async () => {
    runner.mockModules = {}; // No modules available

    const result = await runner.runTask(mockTask);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('not available');
  });

  it('passes provider config for BYOK', async () => {
    const byokMocks = createMocks();
    runner = new TestableCopilotSdkRunner({
      cwd: '/tmp/test',
      model: 'gpt-5',
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      },
    });
    runner.mockModules = {
      '@github/copilot-sdk': byokMocks.sdkModule,
    };

    await runner.runTask(mockTask);

    const sessionConfig = byokMocks.createSession.mock.calls[0][0];
    expect(sessionConfig.provider).toEqual({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
  });

  it('reuses client across multiple tasks', async () => {
    await runner.runTask(mockTask);
    await runner.runTask({ ...mockTask, id: 'test-2' });

    // Client should only be started once (lazy singleton)
    expect(mocks.start).toHaveBeenCalledOnce();
    // But sessions are created per task
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
  });

  it('dispose stops the client', async () => {
    await runner.runTask(mockTask);
    await runner.dispose();

    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('dispose cleans up temp config directory', async () => {
    await runner.runTask(mockTask);

    // Verify configDir was created
    const configDir = (runner as any).configDir;
    expect(configDir).toBeTruthy();

    await runner.dispose();

    // Verify configDir was cleaned up
    expect((runner as any).configDir).toBeNull();
  });

  it('falls back to textChunks when sendAndWait returns no content', async () => {
    mocks.createSession.mockImplementation(async (config: any) => {
      const session = {
        sendAndWait: vi.fn(async () => {
          config.onEvent({
            type: 'assistant.message',
            data: { content: 'Streamed response' },
          });
          return undefined; // No response from sendAndWait
        }),
        disconnect: vi.fn(async () => {}),
      };
      return session;
    });

    const result = await runner.runTask(mockTask);
    expect(result.output).toBe('Streamed response');
  });

  describe('BYOK auto-detection from environment variables', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.COPILOT_GITHUB_TOKEN;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('auto-detects OpenAI provider for non-claude model with OPENAI_API_KEY', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-openai';
      const autoMocks = createMocks();
      const autoRunner = new TestableCopilotSdkRunner({
        cwd: '/tmp/test',
        model: 'gpt-5',
      });
      autoRunner.mockModules = { '@github/copilot-sdk': autoMocks.sdkModule };

      await autoRunner.runTask(mockTask);

      const sessionConfig = autoMocks.createSession.mock.calls[0][0];
      expect(sessionConfig.provider).toEqual({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-openai',
      });
    });

    it('auto-detects Anthropic provider for claude model with ANTHROPIC_API_KEY', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
      const autoMocks = createMocks();
      const autoRunner = new TestableCopilotSdkRunner({
        cwd: '/tmp/test',
        model: 'claude-sonnet-4-6',
      });
      autoRunner.mockModules = { '@github/copilot-sdk': autoMocks.sdkModule };

      await autoRunner.runTask(mockTask);

      const sessionConfig = autoMocks.createSession.mock.calls[0][0];
      expect(sessionConfig.provider).toEqual({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-test-anthropic',
      });
    });

    it('falls back to OpenAI key for claude model when no Anthropic key', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-openai';
      const autoMocks = createMocks();
      const autoRunner = new TestableCopilotSdkRunner({
        cwd: '/tmp/test',
        model: 'claude-sonnet-4-6',
      });
      autoRunner.mockModules = { '@github/copilot-sdk': autoMocks.sdkModule };

      await autoRunner.runTask(mockTask);

      const sessionConfig = autoMocks.createSession.mock.calls[0][0];
      expect(sessionConfig.provider).toEqual({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-openai',
      });
    });

    it('falls back to Anthropic key for non-claude model when no OpenAI key', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
      const autoMocks = createMocks();
      const autoRunner = new TestableCopilotSdkRunner({
        cwd: '/tmp/test',
        model: 'gpt-5',
      });
      autoRunner.mockModules = { '@github/copilot-sdk': autoMocks.sdkModule };

      await autoRunner.runTask(mockTask);

      const sessionConfig = autoMocks.createSession.mock.calls[0][0];
      expect(sessionConfig.provider).toEqual({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-test-anthropic',
      });
    });

    it('does not set provider when no API keys are available', async () => {
      const autoMocks = createMocks();
      const autoRunner = new TestableCopilotSdkRunner({
        cwd: '/tmp/test',
        model: 'gpt-5',
      });
      autoRunner.mockModules = { '@github/copilot-sdk': autoMocks.sdkModule };

      await autoRunner.runTask(mockTask);

      const sessionConfig = autoMocks.createSession.mock.calls[0][0];
      expect(sessionConfig.provider).toBeUndefined();
    });

    it('skips auto-detection when Copilot token is set', async () => {
      process.env.COPILOT_GITHUB_TOKEN = 'ghp-test-token';
      process.env.OPENAI_API_KEY = 'sk-test-openai';
      const autoMocks = createMocks();
      const autoRunner = new TestableCopilotSdkRunner({
        cwd: '/tmp/test',
        model: 'gpt-5',
      });
      autoRunner.mockModules = { '@github/copilot-sdk': autoMocks.sdkModule };

      await autoRunner.runTask(mockTask);

      const sessionConfig = autoMocks.createSession.mock.calls[0][0];
      expect(sessionConfig.provider).toBeUndefined();
    });
  });

  it('does not set skillDirectories when skillsDir is not provided', async () => {
    runner = new TestableCopilotSdkRunner({
      cwd: '/tmp/test',
      model: 'gpt-5',
    });
    runner.mockModules = {
      '@github/copilot-sdk': mocks.sdkModule,
    };

    await runner.runTask(mockTask);

    const sessionConfig = mocks.createSession.mock.calls[0][0];
    expect(sessionConfig.skillDirectories).toBeUndefined();
  });
});
