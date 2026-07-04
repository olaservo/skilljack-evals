/**
 * Claude Code CLI Runner
 *
 * Drives the real Claude Code CLI (`claude -p`) as a subprocess per task and
 * parses its `--output-format stream-json` events into a TaskResult. Unlike
 * the SDK runner's in-process timeout, timeouts here kill the entire CLI
 * process tree via runCliJsonl — nothing leaks.
 *
 * `--setting-sources project` is REQUIRED: without it the user's global
 * ~/.claude settings/hooks leak into trials (verified during the v2 spike,
 * see src/__tests__/fixtures/transcripts/README.md).
 */

import type {
  EvalTask,
  TaskResult,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { isTextBlock, isToolUseBlock } from '../types.js';
import { BaseRunner, buildTokenUsage, skillNameFromReadPath } from './base-runner.js';
import { runCliJsonl, detectCli } from '../harness/subprocess.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';

export const CLAUDE_CLI_INSTALL_HINT =
  'Claude Code CLI not found on PATH. Install: npm install -g @anthropic-ai/claude-code';

/** Fields extracted from a stream-json transcript. */
interface ParsedTranscript {
  output: string;
  durationMs: number;
  numTurns: number;
  costUsd: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
  /** True when a terminal {"type":"result"} event was seen. */
  sawResult: boolean;
}

export class ClaudeCodeRunner extends BaseRunner {
  readonly providerName = 'claude-code';

  /** Lazy preflight result, shared across tasks. */
  private cliDetection: Promise<CliDetection> | undefined;

  /** Spawn the CLI. Protected so tests can inject a fake subprocess. */
  protected runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    return runCliJsonl(options);
  }

  /** Detect the CLI. Protected so tests can bypass the preflight. */
  protected detect(): Promise<CliDetection> {
    return detectCli('claude', ['--version'], { installHint: CLAUDE_CLI_INSTALL_HINT });
  }

  private async ensureCliAvailable(): Promise<void> {
    this.cliDetection ??= this.detect();
    const detection = await this.cliDetection;
    if (!detection.available) {
      throw new Error(detection.reason ?? CLAUDE_CLI_INSTALL_HINT);
    }
  }

  /**
   * Execute a single evaluation task via the Claude Code CLI.
   */
  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const startTime = Date.now();

    try {
      await this.ensureCliAvailable();

      // Per-trial workspace (when set) becomes the CLI cwd — its .claude/ is
      // the only settings source thanks to --setting-sources project.
      const cwd = task.workspaceDir ?? this.options.cwd ?? process.cwd();
      const timeoutMs = task.timeoutMs ?? this.options.taskTimeoutMs ?? 300000;
      const model = this.options.model ?? 'sonnet';

      const args = [
        '-p', task.prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', model,
        '--dangerously-skip-permissions',
        // REQUIRED: only load the workspace's .claude/, never ~/.claude.
        '--setting-sources', 'project',
      ];

      const cli = await this.runCli({
        command: 'claude',
        args,
        cwd,
        env: process.env,
        timeoutMs,
      });

      if (cli.timedOut) {
        return this.createErrorResult(
          task,
          `Task ${task.id} timed out after ${timeoutMs}ms`,
          cli.durationMs,
        );
      }

      const parsed = this.parseEvents(cli.events, logger);

      if (!parsed.sawResult || cli.exitCode !== 0) {
        const problem = !parsed.sawResult
          ? 'exited without a result event'
          : `exited with code ${cli.exitCode}`;
        const stderrExcerpt = cli.stderr.trim().slice(0, 500);
        return this.createErrorResult(
          task,
          `claude CLI ${problem}${stderrExcerpt ? `: ${stderrExcerpt}` : ''}`,
          cli.durationMs,
        );
      }

      return this.buildTaskResult(task, {
        output: parsed.output,
        durationMs: parsed.durationMs || cli.durationMs,
        numTurns: parsed.numTurns,
        costUsd: parsed.costUsd,
        skillLoads: parsed.skillLoads,
        toolCalls: parsed.toolCalls,
        tokens: parsed.tokens,
      });
    } catch (error) {
      return this.handleRunError(task, error, startTime, logger);
    }
  }

  /**
   * Parse Claude Code stream-json events into TaskResult fields.
   *
   * Real captured example: src/__tests__/fixtures/transcripts/claude-code/
   * greeting-with-skill.jsonl.
   */
  private parseEvents(events: unknown[], logger?: SessionLogger): ParsedTranscript {
    const parsed: ParsedTranscript = {
      output: '',
      durationMs: 0,
      numTurns: 0,
      costUsd: 0,
      skillLoads: [],
      toolCalls: [],
      sawResult: false,
    };

    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;
      const record = event as Record<string, unknown>;

      if (record.type === 'assistant') {
        const message = record.message as { content?: unknown[] } | undefined;
        const content = Array.isArray(message?.content) ? message.content : [];

        logger?.addAssistantMessage(content);

        for (const block of content) {
          if (isTextBlock(block)) {
            parsed.output += block.text;
            logger?.addTextMessage(block.text);
          }

          if (isToolUseBlock(block)) {
            const toolInput = block.input ?? {};

            parsed.toolCalls.push({
              tool: block.name,
              toolUseId: block.id,
              timestamp: Date.now(),
              input: toolInput,
            });

            logger?.addToolUse(block.name, toolInput);

            // Primary skill-invocation surface: the Skill tool.
            if (block.name === 'Skill') {
              const skillName = (toolInput.skill as string) || '';
              if (skillName) {
                parsed.skillLoads.push(skillName);
              }
            }

            // Fallback surface: Read of a SKILL.md under a skills dir.
            if (this.options.countReadAsFallback && block.name === 'Read') {
              const skillName = skillNameFromReadPath((toolInput.file_path as string) || '');
              if (skillName) {
                parsed.skillLoads.push(skillName);
              }
            }
          }
        }
      }

      if (record.type === 'result') {
        parsed.sawResult = true;
        parsed.durationMs = (record.duration_ms as number) ?? 0;
        parsed.numTurns = (record.num_turns as number) ?? 0;
        parsed.costUsd = (record.total_cost_usd as number) ?? 0;

        const usage = record.usage as {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        } | undefined;
        if (usage) {
          parsed.tokens = buildTokenUsage({
            input: usage.input_tokens,
            output: usage.output_tokens,
            cacheRead: usage.cache_read_input_tokens,
            cacheCreation: usage.cache_creation_input_tokens,
          });
        }

        if (typeof record.result === 'string' && record.result) {
          parsed.output = record.result;
        }
      }
    }

    return parsed;
  }
}
