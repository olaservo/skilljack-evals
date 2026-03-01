/**
 * OpenAI Agents SDK Runner
 *
 * Runs evaluation tasks using the OpenAI Agents SDK with native Agent Skills
 * support via shellTool() and ShellToolLocalSkill.
 *
 * Skills are passed as local skills to the shell tool, where the agent
 * discovers and uses them through the OpenAI Responses API's native mechanism.
 *
 * Requires: @openai/agents, openai
 */

import type { EvalTask, ToolCallRecord, TaskResult } from '../types.js';
import { BaseRunner } from './base-runner.js';
import type { SessionLogger } from '../session/session-logger.js';
import { discoverSkills, type SkillMetadata } from './skill-discovery.js';

import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================
// Local Shell Implementation
// ============================================

/**
 * Create a local shell implementation for the OpenAI Agents SDK shellTool.
 * Implements the Shell interface: { run(action: ShellAction): Promise<ShellResult> }
 * where ShellAction = { commands: string[], timeoutMs?: number, maxOutputLength?: number }
 * and ShellResult = { output: Array<{ stdout, stderr, outcome: { type, exitCode? } }> }
 */
function createLocalShell(cwd: string) {
  return {
    async run(action: { commands: string[]; timeoutMs?: number; maxOutputLength?: number }) {
      const output = [];
      const timeout = action.timeoutMs ?? 30000;
      const maxLen = action.maxOutputLength ?? 0;

      for (const command of action.commands) {
        try {
          let { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout,
            encoding: 'utf-8',
          });
          if (maxLen > 0) {
            stdout = (stdout ?? '').slice(0, maxLen);
            stderr = (stderr ?? '').slice(0, maxLen);
          }
          output.push({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            outcome: { type: 'exit' as const, exitCode: 0 },
          });
        } catch (err: unknown) {
          const execErr = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
          let stdout = execErr.stdout ?? '';
          let stderr = execErr.stderr ?? String(err);
          if (maxLen > 0) {
            stdout = stdout.slice(0, maxLen);
            stderr = stderr.slice(0, maxLen);
          }
          if (execErr.killed) {
            output.push({
              stdout,
              stderr,
              outcome: { type: 'timeout' as const },
            });
          } else {
            output.push({
              stdout,
              stderr,
              outcome: { type: 'exit' as const, exitCode: execErr.code ?? 1 },
            });
          }
        }
      }
      return { output };
    },
  };
}

// ============================================
// Response Parsing Helpers
// ============================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extract tool calls and skill activity from OpenAI Agents SDK run result.
 */
function extractFromRawResponses(
  rawResponses: Array<{ output: unknown[] }>,
): { toolCalls: ToolCallRecord[]; shellCommands: string[]; numTurns: number } {
  const toolCalls: ToolCallRecord[] = [];
  const shellCommands: string[] = [];

  for (const response of rawResponses) {
    for (const item of response.output) {
      const record = asRecord(item);
      if (!record) continue;

      const type = record.type as string;

      if (type === 'shell_call') {
        const action = asRecord(record.action) ?? asRecord(record.providerData);
        const commands = (action?.commands ?? action?.command) as string[] | undefined;
        if (commands) {
          for (const cmd of commands) {
            shellCommands.push(cmd);
            toolCalls.push({
              tool: 'shell',
              toolUseId: (record.id as string) ?? `shell-${Date.now()}`,
              timestamp: Date.now(),
              input: { command: cmd },
            });
          }
        }
      }

      if (type === 'function_call') {
        toolCalls.push({
          tool: (record.name as string) ?? 'unknown',
          toolUseId: (record.call_id as string) ?? (record.id as string) ?? `fn-${Date.now()}`,
          timestamp: Date.now(),
          input: record.arguments,
        });
      }
    }
  }

  // numTurns = number of raw responses (conversation turns), not tool calls
  return { toolCalls, shellCommands, numTurns: rawResponses.length };
}

/**
 * Detect skill loads from shell commands (e.g., cat SKILL.md).
 */
function detectSkillLoadsFromShellCommands(
  shellCommands: string[],
  localSkills: SkillMetadata[],
): string[] {
  const loads: string[] = [];

  for (const cmd of shellCommands) {
    // Detect reading SKILL.md files
    if (cmd.includes('SKILL.md') || cmd.includes('/skills/')) {
      for (const skill of localSkills) {
        if (cmd.includes(skill.path) || cmd.includes(skill.name)) {
          if (!loads.includes(skill.name)) {
            loads.push(skill.name);
          }
        }
      }
      // Fallback: extract from path pattern (strip trailing quotes/punctuation)
      const match = cmd.match(/skills\/([^/\s"']+)/);
      if (match && !loads.includes(match[1])) {
        loads.push(match[1]);
      }
    }
  }

  return loads;
}

// ============================================
// Runner
// ============================================

export class OpenAiAgentsRunner extends BaseRunner {
  readonly providerName = 'openai-agents';

  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    let Agent: any, run: any, shellTool: any;
    try {
      // Uses Function() constructor to prevent bundlers from statically
      // analyzing the import and failing at build time for optional deps.
      const mod = await (Function('pkg', 'return import(pkg)')('@openai/agents'));
      Agent = mod.Agent;
      run = mod.run;
      shellTool = mod.shellTool;
    } catch {
      throw new Error(
        'OpenAI Agents SDK runner requires "@openai/agents". ' +
        'Install it with: npm install @openai/agents',
      );
    }

    const startTime = Date.now();

    try {
      // 1. Build local skill entries from skills directory
      const localSkills = this.options.skillsDir
        ? await discoverSkills(this.options.skillsDir)
        : [];

      const cwd = this.options.cwd ?? process.cwd();
      const model = this.options.model ?? 'gpt-5.2';

      // 2. Create agent with shell tool + local skills
      const agent = new Agent({
        name: 'SkillEvalAgent',
        model,
        instructions: 'You are a helpful AI assistant. Use available skills when appropriate to help the user.',
        tools: [
          shellTool({
            environment: {
              type: 'local' as const,
              skills: localSkills,
            },
            shell: createLocalShell(cwd),
          }),
        ],
      });

      // 3. Run agent
      const result = await run(agent, task.prompt);

      // 4. Extract results
      const output = result.finalOutput ?? '';
      logger?.addTextMessage(typeof output === 'string' ? output : JSON.stringify(output));

      const { toolCalls, shellCommands, numTurns } = extractFromRawResponses(
        result.rawResponses as Array<{ output: unknown[] }>,
      );
      for (const tc of toolCalls) {
        logger?.addToolUse(tc.tool, tc.input);
      }

      // 5. Detect skill loads
      const skillLoads = detectSkillLoadsFromShellCommands(shellCommands, localSkills);

      // 6. Extract usage
      const usage = (result as unknown as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      // Rough cost estimate — actual pricing varies by model and provider
      const costUsd = totalTokens * 0.000003;

      return {
        taskId: task.id,
        prompt: task.prompt,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        durationMs: Date.now() - startTime,
        numTurns,
        costUsd,
        skillLoads: [...new Set(skillLoads)],
        toolCalls,
        isError: false,
        errorMessage: '',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.markAsError(errorMessage);

      return {
        taskId: task.id,
        prompt: task.prompt,
        output: '',
        durationMs: Date.now() - startTime,
        numTurns: 0,
        costUsd: 0,
        skillLoads: [],
        toolCalls: [],
        isError: true,
        errorMessage,
      };
    }
  }
}
