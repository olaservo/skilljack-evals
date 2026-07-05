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
  TokenUsage,
} from '../types.js';
import {
  isAssistantMessage,
  isResultMessage,
  isTextBlock,
  isToolUseBlock,
} from '../types.js';
import { createPreToolUseHook } from './security.js';
import { BaseRunner, buildTokenUsage, skillNameFromReadPath } from './base-runner.js';
import type { SessionLogger } from '../session/session-logger.js';

export class ClaudeSdkRunner extends BaseRunner {
  readonly providerName = 'claude-sdk';

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
      let resultTokens: TokenUsage | undefined;

      // Per-trial workspace (when set) becomes the agent cwd, and writes inside
      // it are unrestricted — the workspace is throwaway isolation.
      const cwd = task.workspaceDir ?? this.options.cwd ?? process.cwd();
      const allowedWriteDirs = task.workspaceDir
        ? [task.workspaceDir]
        : this.options.allowedWriteDirs ?? [];

      const preToolUseHook = createPreToolUseHook(allowedWriteDirs, cwd);

      const q = query({
        prompt: task.prompt,
        options: {
          cwd,
          model: this.options.model,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['project'],
          allowedTools: [
            'Read', 'Write', 'Edit',
            'Glob', 'Grep', 'Bash',
            'Skill', 'Task',
          ],
          // 'dontAsk' keeps execution headless (no prompts) while still
          // consulting the PreToolUse hook per call. 'bypassPermissions' would
          // shadow the hook/canUseTool and disable the write restriction.
          permissionMode: 'dontAsk',
          hooks: {
            PreToolUse: [{ hooks: [preToolUseHook] }],
          },
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
              if (this.options.countReadAsFallback && toolName === 'Read') {
                const skillName = skillNameFromReadPath((toolInput.file_path as string) || '');
                if (skillName) {
                  skillLoads.push(skillName);
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

          const u = message.usage;
          if (u) {
            resultTokens = buildTokenUsage({
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens,
              cacheCreation: u.cache_creation_input_tokens,
            });
          }

          if (message.result) {
            resultOutput = message.result;
          }
        }
      }

      return this.buildTaskResult(task, {
        output: resultOutput,
        durationMs: resultDurationMs || (Date.now() - startTime),
        numTurns: resultNumTurns,
        costUsd: resultCostUsd,
        skillLoads,
        toolCalls,
        tokens: resultTokens,
      });
    } catch (error) {
      return this.handleRunError(task, error, startTime, logger);
    }
  }
}
