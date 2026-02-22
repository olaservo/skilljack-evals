/**
 * Skill Evaluation Runner - Claude Agent SDK
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
  SkillEvaluation,
  ToolCallRecord,
  TaskResult,
  RunnerOptions,
} from '../types.js';
import {
  isAssistantMessage,
  isResultMessage,
  isTextBlock,
  isToolUseBlock,
} from '../types.js';
import { createToolPolicy } from './security.js';
import { loadConfigSync } from '../config.js';
import type { SessionLogger } from '../session/session-logger.js';

export class SkillEvalRunner {
  private options: Required<RunnerOptions>;

  constructor(options: RunnerOptions = {}) {
    const config = loadConfigSync();

    this.options = {
      cwd: options.cwd ?? process.cwd(),
      parallel: options.parallel ?? false,
      model: options.model ?? config.defaultAgentModel,
      settingSources: options.settingSources ?? ['project'],
      countReadAsFallback: options.countReadAsFallback ?? false,
      allowedWriteDirs: options.allowedWriteDirs ?? config.allowedWriteDirs,
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
        this.options.allowedWriteDirs,
        this.options.cwd
      );

      const q = query({
        prompt: task.prompt,
        options: {
          cwd: this.options.cwd,
          model: this.options.model,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: this.options.settingSources,
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
              if (this.options.countReadAsFallback && toolName === 'Read') {
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

  /**
   * Execute a task with timeout protection.
   */
  async runTaskWithTimeout(
    task: EvalTask,
    timeoutMs?: number,
    logger?: SessionLogger
  ): Promise<TaskResult> {
    const config = loadConfigSync();
    const timeout = timeoutMs ?? config.taskTimeoutMs;

    const timeoutPromise = new Promise<TaskResult>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Task ${task.id} timed out after ${timeout}ms`)),
        timeout
      );
    });

    try {
      return await Promise.race([this.runTask(task, logger), timeoutPromise]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.markAsError(errorMessage);

      return {
        taskId: task.id,
        prompt: task.prompt,
        output: '',
        durationMs: timeout,
        numTurns: 0,
        costUsd: 0,
        skillLoads: [],
        toolCalls: [],
        isError: true,
        errorMessage,
      };
    }
  }

  /**
   * Run all tasks in an evaluation suite.
   */
  async runAll(
    evaluation: SkillEvaluation,
    createLogger?: (task: EvalTask) => SessionLogger
  ): Promise<TaskResult[]> {
    if (this.options.parallel) {
      const results = await Promise.allSettled(
        evaluation.tasks.map((task) => {
          const logger = createLogger?.(task);
          return this.runTaskWithTimeout(task, undefined, logger);
        })
      );

      return results.map((result, i) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }
        const task = evaluation.tasks[i];
        return {
          taskId: task.id,
          prompt: task.prompt,
          output: '',
          durationMs: 0,
          numTurns: 0,
          costUsd: 0,
          skillLoads: [],
          toolCalls: [],
          isError: true,
          errorMessage: result.reason?.message || 'Unknown error',
        };
      });
    }

    const results: TaskResult[] = [];
    for (const task of evaluation.tasks) {
      console.log(`Running task ${task.id}: ${task.prompt.slice(0, 60)}...`);
      const logger = createLogger?.(task);
      const result = await this.runTaskWithTimeout(task, undefined, logger);
      results.push(result);

      if (result.isError) {
        console.error(`  ERROR: ${result.errorMessage}`);
      } else {
        console.log(`  Skills loaded: ${result.skillLoads.join(', ') || 'none'}`);
        console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s | Cost: $${result.costUsd.toFixed(4)}`);
      }
    }
    return results;
  }
}
