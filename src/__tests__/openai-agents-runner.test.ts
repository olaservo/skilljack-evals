import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAiAgentsRunner, detectSkillLoadsFromShellCommands } from '../runner/openai-agents-runner.js';
import type { EvalTask } from '../types.js';
import type { SkillMetadata } from '../runner/skill-discovery.js';

// Mock skill discovery at module level
vi.mock('../runner/skill-discovery.js', () => ({
  discoverSkills: vi.fn().mockResolvedValue([
    { name: 'greeting', description: 'A greeting skill', path: '/skills/greeting' },
  ]),
  stripFrontmatter: vi.fn((content: string) => content),
}));

const mockTask: EvalTask = {
  id: 'test-1',
  prompt: 'Say hello',
  expectedSkillLoad: 'greeting',
  criteria: [{ dimension: 'discovery', weight: 0.3, description: 'test' }],
  goldenChecklist: ['Says hello'],
};

// ============================================
// Tests for detectSkillLoadsFromShellCommands
// ============================================

describe('detectSkillLoadsFromShellCommands', () => {
  const skills: SkillMetadata[] = [
    { name: 'greeting', description: 'A greeting skill', path: '/skills/greeting' },
    { name: 'calculator', description: 'Math skill', path: '/skills/calculator' },
  ];

  it('detects skill load from cat SKILL.md command', () => {
    const cmds = ['cat /skills/greeting/SKILL.md'];
    const loads = detectSkillLoadsFromShellCommands(cmds, skills);
    expect(loads).toContain('greeting');
  });

  it('detects skill load from path containing /skills/', () => {
    const cmds = ['less /skills/calculator/SKILL.md'];
    const loads = detectSkillLoadsFromShellCommands(cmds, skills);
    expect(loads).toContain('calculator');
  });

  it('returns empty for unrelated commands', () => {
    const cmds = ['ls -la', 'echo hello', 'npm install'];
    const loads = detectSkillLoadsFromShellCommands(cmds, skills);
    expect(loads).toEqual([]);
  });

  it('deduplicates skill loads', () => {
    const cmds = [
      'cat /skills/greeting/SKILL.md',
      'cat /skills/greeting/SKILL.md',
    ];
    const loads = detectSkillLoadsFromShellCommands(cmds, skills);
    const greetingCount = loads.filter(l => l === 'greeting').length;
    expect(greetingCount).toBe(1);
  });

  it('detects multiple different skills', () => {
    const cmds = [
      'cat /skills/greeting/SKILL.md',
      'cat /skills/calculator/SKILL.md',
    ];
    const loads = detectSkillLoadsFromShellCommands(cmds, skills);
    expect(loads).toContain('greeting');
    expect(loads).toContain('calculator');
  });

  it('handles quoted paths in commands', () => {
    const cmds = ['cat "/skills/greeting/SKILL.md"'];
    const loads = detectSkillLoadsFromShellCommands(cmds, skills);
    expect(loads).toContain('greeting');
  });

  it('does not detect unregistered skills from path fallback', () => {
    const cmds = ['ls /home/user/.claude/skills/unknown-skill/'];
    const loads = detectSkillLoadsFromShellCommands(cmds, skills);
    expect(loads).toEqual([]);
  });
});

// ============================================
// Tests for OpenAiAgentsRunner
// ============================================

/**
 * Testable subclass that overrides importAgentsSdk to inject mocks.
 */
class TestableOpenAiAgentsRunner extends OpenAiAgentsRunner {
  public mockSdk: any;

  protected override async importAgentsSdk() {
    if (!this.mockSdk) throw new Error('SDK not available');
    return this.mockSdk;
  }
}

/** Mock Agent class that stores config and can be used with `new`. */
class MockAgent {
  config: any;
  constructor(config: any) {
    this.config = config;
  }
}

function createMockSdk(runResult?: any) {
  return {
    Agent: MockAgent,
    run: vi.fn().mockResolvedValue(runResult ?? {
      finalOutput: 'Hello from the agent!',
      rawResponses: [],
    }),
    shellTool: vi.fn().mockReturnValue({ type: 'shell_tool' }),
  };
}

describe('OpenAiAgentsRunner', () => {
  let runner: TestableOpenAiAgentsRunner;

  beforeEach(() => {
    vi.clearAllMocks();

    runner = new TestableOpenAiAgentsRunner({
      cwd: '/tmp/test',
      model: 'gpt-5.2',
      skillsDir: '/skills',
    });

    runner.mockSdk = createMockSdk();
  });

  it('has correct provider name', () => {
    expect(runner.providerName).toBe('openai-agents');
  });

  it('creates agent and returns successful result', async () => {
    const result = await runner.runTask(mockTask);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('Hello from the agent!');
    expect(result.taskId).toBe('test-1');
    expect(runner.mockSdk.run).toHaveBeenCalledOnce();
  });

  it('passes model and instructions to agent', async () => {
    await runner.runTask(mockTask);
    // The first arg to run() is the agent instance
    const agent = runner.mockSdk.run.mock.calls[0][0] as MockAgent;
    expect(agent.config.model).toBe('gpt-5.2');
    expect(agent.config.name).toBe('SkillEvalAgent');
    expect(agent.config.instructions).toBeDefined();
  });

  it('throws when SDK import fails (caught by runTaskWithTimeout)', async () => {
    runner.mockSdk = null;

    await expect(runner.runTask(mockTask)).rejects.toThrow('SDK not available');
  });

  it('returns error result when agent run fails', async () => {
    runner.mockSdk = createMockSdk();
    runner.mockSdk.run.mockRejectedValue(new Error('Agent execution failed'));

    const result = await runner.runTask(mockTask);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('Agent execution failed');
  });

  it('detects skill loads from shell commands in raw responses', async () => {
    runner.mockSdk = createMockSdk({
      finalOutput: 'Hello!',
      rawResponses: [{
        output: [{
          type: 'shell_call',
          id: 's1',
          action: { commands: ['cat /skills/greeting/SKILL.md'] },
        }],
      }],
    });

    const result = await runner.runTask(mockTask);
    expect(result.skillLoads).toContain('greeting');
  });

  it('extracts tool calls from raw responses', async () => {
    runner.mockSdk = createMockSdk({
      finalOutput: 'Hello!',
      rawResponses: [{
        output: [
          {
            type: 'shell_call',
            id: 's1',
            action: { commands: ['echo hello'] },
          },
          {
            type: 'function_call',
            name: 'myFunc',
            call_id: 'f1',
            arguments: '{"key":"value"}',
          },
        ],
      }],
    });

    const result = await runner.runTask(mockTask);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].tool).toBe('shell');
    expect(result.toolCalls[1].tool).toBe('myFunc');
  });

  it('counts turns from raw responses', async () => {
    runner.mockSdk = createMockSdk({
      finalOutput: 'Done!',
      rawResponses: [
        { output: [] },
        { output: [] },
        { output: [] },
      ],
    });

    const result = await runner.runTask(mockTask);
    expect(result.numTurns).toBe(3);
  });
});
