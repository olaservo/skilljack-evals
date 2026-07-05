/**
 * Codex CLI Runner
 *
 * Drives the OpenAI Codex CLI (`codex exec --json`) as a subprocess per task
 * and folds its JSONL event stream into a TaskResult. Verified against
 * codex-cli 0.137.0 (real captured transcript:
 * src/__tests__/fixtures/transcripts/codex/greeting-with-skill.jsonl).
 *
 * Event contract (thread.started → turn.started → item.started/item.completed
 * → turn.completed):
 * - `item.completed` with `item.type: "agent_message"` carries assistant text;
 *   the last agent_message is the final answer.
 * - `item.completed` with `item.type: "command_execution"` carries executed
 *   shell commands. Codex has no Skill tool — it discovers skills natively
 *   from `.agents/skills/` and reads SKILL.md via shell commands, so a
 *   command containing a SKILL.md path IS the primary skill-invocation
 *   surface (file-read), not a fallback.
 * - `turn.completed` carries `usage` with input_tokens / cached_input_tokens /
 *   output_tokens (+ reasoning_output_tokens, included in output_tokens).
 *
 * Config isolation: `--ignore-user-config` skips the user's ~/.codex
 * config.toml (MCP servers, hooks, etc. — the leak found in the v2 spike)
 * while still using CODEX_HOME for auth. `--ephemeral` avoids persisting
 * session files. No temp CODEX_HOME copy is needed.
 *
 * Model: when the configured model is the framework default ('sonnet', a
 * Claude alias meaningless to Codex), no `-m` flag is passed and Codex uses
 * its own default model. Pass --model <codex-model> explicitly to override.
 */

import * as path from 'path';
import type {
  EvalTask,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { buildTokenUsage, ROUGH_COST_PER_TOKEN } from './base-runner.js';
import { CliRunner, skillNameFromCommand } from './cli-runner.js';
import type { CliTaskResultFields } from './cli-runner.js';
import type { CliJsonlResult } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';

// skillNameFromCommand now lives in cli-runner.ts (it is shared by the
// gemini/opencode fallback surface too); re-exported here, its original
// home, because src/index.ts and external consumers import it from this
// module.
export { skillNameFromCommand };

export const CODEX_CLI_INSTALL_HINT =
  'Codex CLI not found on PATH. Install: npm install -g @openai/codex';

/** Fields folded from a codex exec --json event stream. */
interface CodexFoldState {
  /** All agent_message texts, joined at finalize; ends with the final answer. */
  messages: string[];
  numTurns: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
  /** True when at least one turn.completed event was seen. */
  sawTurnCompleted: boolean;
}

export class CodexRunner extends CliRunner<CodexFoldState> {
  get providerName(): string {
    return 'codex';
  }

  protected readonly command = 'codex';
  protected readonly installHint = CODEX_CLI_INSTALL_HINT;

  /** Codex discovers project-level skills from .agents/skills/ (spike-verified). */
  override readonly skillsMountPath = path.join('.agents', 'skills');

  protected buildArgs(task: EvalTask): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      // Isolation: skip the user's ~/.codex config.toml (MCP servers etc.)
      // while keeping CODEX_HOME-based auth. Verified against the spike leak.
      '--ignore-user-config',
      // Don't persist eval-trial session files to the user's machine.
      '--ephemeral',
    ];

    // Only pass -m when the model was set to something other than the
    // framework default (a Claude alias): Codex picks its own default.
    const model = this.options.model;
    if (model && model !== DEFAULT_CONFIG.defaultAgentModel) {
      args.push('-m', model);
    }

    // Prompt as positional arg. stdin is closed immediately by runCliJsonl,
    // so codex's "append piped stdin" behavior appends nothing.
    args.push(task.prompt);

    return args;
  }

  protected createInitialState(): CodexFoldState {
    return {
      messages: [],
      numTurns: 0,
      skillLoads: [],
      toolCalls: [],
      sawTurnCompleted: false,
    };
  }

  /**
   * Fold one codex exec --json event into the state.
   */
  protected handleEvent(event: unknown, state: CodexFoldState, logger?: SessionLogger): void {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;

    if (record.type === 'item.completed') {
      const item = record.item as Record<string, unknown> | undefined;
      if (!item) return;

      if (item.type === 'agent_message' && typeof item.text === 'string') {
        state.messages.push(item.text);
        logger?.addTextMessage(item.text);
      }

      if (item.type === 'command_execution' && typeof item.command === 'string') {
        state.toolCalls.push({
          tool: 'command_execution',
          toolUseId: typeof item.id === 'string' ? item.id : '',
          timestamp: Date.now(),
          input: { command: item.command },
        });
        logger?.addToolUse('command_execution', { command: item.command });

        // Primary invocation surface for Codex: a shell read of SKILL.md.
        const skillName = skillNameFromCommand(item.command);
        if (skillName) {
          state.skillLoads.push(skillName);
        }
      }
    }

    if (record.type === 'turn.completed') {
      state.sawTurnCompleted = true;
      state.numTurns++;

      const usage = record.usage as {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      } | undefined;
      if (usage) {
        // codex input_tokens INCLUDES cached tokens; split them out so
        // TokenUsage.total = input + output + cacheRead stays correct.
        const cached = usage.cached_input_tokens ?? 0;
        state.tokens = buildTokenUsage({
          input: Math.max(0, (usage.input_tokens ?? 0) - cached),
          output: usage.output_tokens,
          cacheRead: cached,
        });
      }
    }
  }

  protected detectFailure(cli: CliJsonlResult, state: CodexFoldState): string | null {
    if (cli.exitCode !== 0) return `exited with code ${cli.exitCode}`;
    if (!state.sawTurnCompleted) return 'exited without a completed turn';
    return null;
  }

  protected finalize(state: CodexFoldState, cli: CliJsonlResult): CliTaskResultFields {
    const tokens = state.tokens;
    return {
      output: state.messages.join('\n\n'),
      durationMs: cli.durationMs,
      numTurns: state.numTurns,
      // Codex does not report cost; estimate from tokens when available.
      costUsd: tokens ? tokens.total * ROUGH_COST_PER_TOKEN : 0,
      skillLoads: state.skillLoads,
      toolCalls: state.toolCalls,
      tokens,
    };
  }
}
