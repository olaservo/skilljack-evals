/**
 * Claude Code CLI Runner
 *
 * Drives the real Claude Code CLI (`claude -p`) as a subprocess per task and
 * folds its `--output-format stream-json` events into a TaskResult. Unlike
 * the SDK runner's in-process timeout, timeouts here kill the entire CLI
 * process tree via runCliJsonl — nothing leaks.
 *
 * `--setting-sources project` is REQUIRED: without it the user's global
 * ~/.claude settings/hooks leak into trials (verified during the v2 spike,
 * see src/__tests__/fixtures/transcripts/README.md).
 */

import type {
  EvalTask,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { isTextBlock, isToolUseBlock } from '../types.js';
import { buildTokenUsage, skillNameFromReadPath } from './base-runner.js';
import { CliRunner } from './cli-runner.js';
import type { CliTaskResultFields } from './cli-runner.js';
import type { CliJsonlResult } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';

export const CLAUDE_CLI_INSTALL_HINT =
  'Claude Code CLI not found on PATH. Install: npm install -g @anthropic-ai/claude-code';

/** Fields folded from a stream-json transcript. */
interface ClaudeCodeFoldState {
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

export class ClaudeCodeRunner extends CliRunner<ClaudeCodeFoldState> {
  get providerName(): string {
    return 'claude-code';
  }

  protected readonly command = 'claude';
  protected readonly installHint = CLAUDE_CLI_INSTALL_HINT;

  protected buildArgs(task: EvalTask): string[] {
    const model = this.options.model ?? 'sonnet';
    return [
      '-p', task.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--dangerously-skip-permissions',
      // REQUIRED: only load the workspace's .claude/, never ~/.claude — the
      // per-trial workspace cwd's .claude/ is the only settings source.
      '--setting-sources', 'project',
    ];
  }

  protected createInitialState(): ClaudeCodeFoldState {
    return {
      output: '',
      durationMs: 0,
      numTurns: 0,
      costUsd: 0,
      skillLoads: [],
      toolCalls: [],
      sawResult: false,
    };
  }

  /**
   * Fold one Claude Code stream-json event into the state.
   *
   * Real captured example: src/__tests__/fixtures/transcripts/claude-code/
   * greeting-with-skill.jsonl.
   */
  protected handleEvent(event: unknown, state: ClaudeCodeFoldState, logger?: SessionLogger): void {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;

    if (record.type === 'assistant') {
      const message = record.message as { content?: unknown[] } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];

      logger?.addAssistantMessage(content);

      for (const block of content) {
        if (isTextBlock(block)) {
          state.output += block.text;
          logger?.addTextMessage(block.text);
        }

        if (isToolUseBlock(block)) {
          const toolInput = block.input ?? {};

          state.toolCalls.push({
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
              state.skillLoads.push(skillName);
            }
          }

          // Fallback surface: Read of a SKILL.md under a skills dir.
          if (this.options.countReadAsFallback && block.name === 'Read') {
            const skillName = skillNameFromReadPath((toolInput.file_path as string) || '');
            if (skillName) {
              state.skillLoads.push(skillName);
            }
          }
        }
      }
    }

    if (record.type === 'result') {
      state.sawResult = true;
      state.durationMs = (record.duration_ms as number) ?? 0;
      state.numTurns = (record.num_turns as number) ?? 0;
      state.costUsd = (record.total_cost_usd as number) ?? 0;

      const usage = record.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      } | undefined;
      if (usage) {
        state.tokens = buildTokenUsage({
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheCreation: usage.cache_creation_input_tokens,
        });
      }

      if (typeof record.result === 'string' && record.result) {
        state.output = record.result;
      }
    }
  }

  protected detectFailure(cli: CliJsonlResult, state: ClaudeCodeFoldState): string | null {
    if (!state.sawResult) return 'exited without a result event';
    if (cli.exitCode !== 0) return `exited with code ${cli.exitCode}`;
    return null;
  }

  protected finalize(state: ClaudeCodeFoldState, cli: CliJsonlResult): CliTaskResultFields {
    return {
      output: state.output,
      durationMs: state.durationMs || cli.durationMs,
      numTurns: state.numTurns,
      costUsd: state.costUsd,
      skillLoads: state.skillLoads,
      toolCalls: state.toolCalls,
      tokens: state.tokens,
    };
  }
}
