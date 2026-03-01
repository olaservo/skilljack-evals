/**
 * Claude Agent SDK Runner
 *
 * Runs evaluation tasks against an agent using the Claude Agent SDK.
 * Supports local skill delivery (.claude/skills/) with both Anthropic API
 * and Bedrock (via CLAUDE_CODE_USE_BEDROCK=1 env var).
 *
 * Security: Uses permissionMode 'bypassPermissions' for automated execution,
 * with file writes restricted via canUseTool callback to allowedWriteDirs only.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  EvalTask,
  ToolCallRecord,
  TaskResult,
} from '../types.js';
import {
  isAssistantMessage,
  isResultMessage,
  isTextBlock,
  isToolUseBlock,
} from '../types.js';
import { createToolPolicy } from './security.js';
import { BaseRunner } from './base-runner.js';
import type { AgentRunnerOptions } from './agent-runner.js';
import type { SessionLogger } from '../session/session-logger.js';

/**
 * Claude SDK-specific options (extends shared options).
 */
export interface ClaudeSdkRunnerOptions extends AgentRunnerOptions {
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** Count Read calls to SKILL.md as skill discovery (default: false) */
  countReadAsFallback?: boolean;
}

export class ClaudeSdkRunner extends BaseRunner {
  readonly providerName = 'claude-sdk';
  private sdkOptions: ClaudeSdkRunnerOptions;

  constructor(options: ClaudeSdkRunnerOptions = {}) {
    super(options);
    this.sdkOptions = {
      ...this.options,
      settingSources: options.settingSources ?? ['project'],
      countReadAsFallback: options.countReadAsFallback ?? false,
    };
  }

  /**
   * Execute a single evaluation task.
   */
  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const skillLoads: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const startTime = Date.now();

    try {
      let resultOutput = '';
      let resultDurationMs = 0;
      let resultNumTurns = 0;
      let resultCostUsd = 0;

      const toolPolicy = createToolPolicy(
        this.options.allowedWriteDirs ?? [],
        this.options.cwd ?? process.cwd(),
      );

      const q = query({
        prompt: task.prompt,
        options: {
          cwd: this.options.cwd,
          model: this.options.model,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: this.sdkOptions.settingSources,
          allowedTools: [
            'Read', 'Write', 'Edit',
            'Glob', 'Grep', 'Bash',
            'Skill', 'Task',
          ],
          permissionMode: 'bypassPermissions',
          canUseTool: toolPolicy,
        },
      });

      for await (const message of q) {
        // Process assistant messages
        if (isAssistantMessage(message)) {
          const content = message.message.content;

          logger?.addAssistantMessage(content as unknown[]);

          for (const block of content) {
            if (isTextBlock(block)) {
              resultOutput += block.text;
              logger?.addTextMessage(block.text);
            }

            if (isToolUseBlock(block)) {
              const toolName = block.name;
              const toolInput = block.input;

              toolCalls.push({
                tool: toolName,
                toolUseId: block.id,
                timestamp: Date.now(),
                input: toolInput,
              });

              logger?.addToolUse(toolName, toolInput);

              // Detect skill loading via Skill tool
              if (toolName === 'Skill') {
                const skillName = (toolInput.skill as string) || '';
                if (skillName) {
                  skillLoads.push(skillName);
                }
              }

              // Optionally detect via Read calls to SKILL.md
              if (this.sdkOptions.countReadAsFallback && toolName === 'Read') {
                const filePath = (toolInput.file_path as string) || '';
                if (filePath.includes('SKILL.md') || filePath.includes('/skills/')) {
                  const match = filePath.match(/skills\/([^/]+)/);
                  if (match) {
                    skillLoads.push(match[1]);
                  }
                }
              }
            }
          }
        }

        // Capture final metrics from result message
        if (isResultMessage(message)) {
          resultDurationMs = message.duration_ms ?? 0;
          resultNumTurns = message.num_turns ?? 0;
          resultCostUsd = message.total_cost_usd ?? 0;

          if (message.result) {
            resultOutput = message.result;
          }
        }
      }

      return {
        taskId: task.id,
        prompt: task.prompt,
        output: resultOutput,
        durationMs: resultDurationMs || (Date.now() - startTime),
        numTurns: resultNumTurns,
        costUsd: resultCostUsd,
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
