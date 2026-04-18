import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VercelAiRunner } from '../runner/vercel-ai-runner.js';
import type { EvalTask } from '../types.js';

// Mock skill discovery at module level (vitest hoists vi.mock calls)
vi.mock('../runner/skill-discovery.js', () => ({
  discoverSkills: vi.fn().mockResolvedValue([
    { name: 'greeting', description: 'A greeting skill', path: '/skills/greeting' },
  ]),
  stripFrontmatter: vi.fn((content: string) => content),
}));

// Mock fs/promises for loadSkill tool
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('# Greeting Skill\nSay hello warmly.'),
  stat: vi.fn().mockResolvedValue({ size: 100 }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const mockTask: EvalTask = {
  id: 'test-1',
  prompt: 'Say hello',
  expectedSkillLoad: 'greeting',
  criteria: [{ dimension: 'discovery', weight: 0.3, description: 'test' }],
  goldenChecklist: ['Says hello'],
};

/**
 * Testable subclass that overrides dynamicImport to inject mock modules.
 */
class TestableVercelAiRunner extends VercelAiRunner {
  public mockModules: Record<string, any> = {};

  protected override async dynamicImport(pkg: string, _hint: string): Promise<any> {
    if (this.mockModules[pkg]) return this.mockModules[pkg];
    throw new Error(`Module "${pkg}" not available`);
  }
}

function createMockAiModule(overrides: {
  generateTextResult?: any;
  generateTextError?: Error;
  generateTextImpl?: (opts: any) => Promise<any>;
} = {}) {
  let mockGenerateText;
  if (overrides.generateTextImpl) {
    mockGenerateText = vi.fn().mockImplementation(overrides.generateTextImpl);
  } else if (overrides.generateTextError) {
    mockGenerateText = vi.fn().mockRejectedValue(overrides.generateTextError);
  } else {
    mockGenerateText = vi.fn().mockResolvedValue(overrides.generateTextResult ?? {
      text: 'Hello!',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  }

  return {
    generateText: mockGenerateText,
    tool: vi.fn((config: any) => config),
    stepCountIs: vi.fn((n: number) => n),
  };
}

function createMockZodModule() {
  const mockDescribe = vi.fn().mockReturnValue('mock-zod-string');
  return {
    z: {
      object: vi.fn((schema: any) => schema),
      string: vi.fn(() => ({ describe: mockDescribe })),
    },
  };
}

function createMockProviderModule() {
  return {
    createOpenAI: vi.fn(() => vi.fn(() => 'mock-model')),
    createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
    createGoogleGenerativeAI: vi.fn(() => vi.fn(() => 'mock-model')),
  };
}

describe('VercelAiRunner', () => {
  let runner: TestableVercelAiRunner;
  let mockAi: ReturnType<typeof createMockAiModule>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAi = createMockAiModule();
    runner = new TestableVercelAiRunner({
      cwd: '/tmp/test',
      model: 'openai:gpt-5.2',
      skillsDir: '/skills',
    });
    runner.mockModules = {
      'ai': mockAi,
      'zod': createMockZodModule(),
      '@ai-sdk/openai': createMockProviderModule(),
    };
  });

  it('has correct provider name', () => {
    expect(runner.providerName).toBe('vercel-ai');
  });

  it('defines loadSkill, readFile, writeFile, bash tools', async () => {
    await runner.runTask(mockTask);

    expect(mockAi.generateText).toHaveBeenCalledOnce();
    const callArgs = mockAi.generateText.mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools.loadSkill).toBeDefined();
    expect(callArgs.tools.readFile).toBeDefined();
    expect(callArgs.tools.writeFile).toBeDefined();
    expect(callArgs.tools.bash).toBeDefined();
  });

  it('returns successful result with output and usage', async () => {
    const result = await runner.runTask(mockTask);

    expect(result.isError).toBe(false);
    expect(result.taskId).toBe('test-1');
    expect(result.output).toBe('Hello!');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('populates tokens from generateText usage (cache fields default to 0)', async () => {
    const result = await runner.runTask(mockTask);
    expect(result.tokens).toEqual({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheCreation: 0,
      total: 150,
    });
  });

  it('leaves tokens undefined when generateText does not return usage', async () => {
    mockAi.generateText.mockImplementation(async () => ({ text: 'Hello!' }));
    const result = await runner.runTask(mockTask);
    expect(result.tokens).toBeUndefined();
  });

  it('does NOT detect skill via readFile when countReadAsFallback is false', async () => {
    mockAi.generateText.mockImplementation(async (opts: any) => {
      opts.onStepFinish?.({
        toolCalls: [{
          toolName: 'readFile',
          args: { file_path: '/skills/greeting/SKILL.md' },
          toolCallId: 'tc-1',
        }],
      });
      return { text: 'Hello!', usage: { inputTokens: 100, outputTokens: 50 } };
    });

    const result = await runner.runTask(mockTask);
    expect(result.skillLoads).toEqual([]);
  });

  it('detects skill via readFile when countReadAsFallback is true', async () => {
    runner = new TestableVercelAiRunner({
      cwd: '/tmp/test',
      model: 'openai:gpt-5.2',
      skillsDir: '/skills',
      countReadAsFallback: true,
    });
    runner.mockModules = {
      'ai': mockAi,
      'zod': createMockZodModule(),
      '@ai-sdk/openai': createMockProviderModule(),
    };

    mockAi.generateText.mockImplementation(async (opts: any) => {
      opts.onStepFinish?.({
        toolCalls: [{
          toolName: 'readFile',
          args: { file_path: '/skills/greeting/SKILL.md' },
          toolCallId: 'tc-1',
        }],
      });
      return { text: 'Hello!', usage: { inputTokens: 100, outputTokens: 50 } };
    });

    const result = await runner.runTask(mockTask);
    expect(result.skillLoads).toContain('greeting');
  });

  it('tracks tool calls from onStepFinish', async () => {
    mockAi.generateText.mockImplementation(async (opts: any) => {
      opts.onStepFinish?.({
        toolCalls: [
          { toolName: 'loadSkill', args: { name: 'greeting' }, toolCallId: 'tc-1' },
          { toolName: 'bash', args: { command: 'echo hi' }, toolCallId: 'tc-2' },
        ],
      });
      return { text: 'Hello!', usage: { inputTokens: 100, outputTokens: 50 } };
    });

    const result = await runner.runTask(mockTask);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].tool).toBe('loadSkill');
    expect(result.toolCalls[1].tool).toBe('bash');
  });

  it('returns error result on SDK failure', async () => {
    runner.mockModules['ai'] = createMockAiModule({
      generateTextError: new Error('API rate limit'),
    });

    const result = await runner.runTask(mockTask);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('API rate limit');
    expect(result.taskId).toBe('test-1');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('throws when dynamic import fails (caught by runTaskWithTimeout)', async () => {
    runner.mockModules = {}; // No modules available

    await expect(runner.runTask(mockTask)).rejects.toThrow('not available');
  });
});
