/**
 * Gemini CLI Runner — EXPERIMENTAL.
 *
 * Built from the official Gemini CLI docs (headless mode, Agent Skills,
 * stream-json output), NOT yet verified against a live CLI on this machine —
 * captured transcripts wanted. Unit tests replay a hand-written SYNTHETIC
 * fixture (src/__tests__/fixtures/transcripts/gemini/synthetic-*.jsonl).
 *
 * Documented facts this implementation relies on (geminicli.com/docs, July 2026):
 * - Headless: `gemini -p "<prompt>" --output-format stream-json` emits JSONL
 *   events: init, message, tool_use (with `parameters`), tool_result, error,
 *   result (final, with aggregated `stats`). The plan's original guess was
 *   `--output-format json --yolo`; stream-json is preferred because the
 *   single-object json mode only reports aggregate tool COUNTS (no arguments),
 *   which would make SKILL.md-read detection impossible.
 * - Auto-approval: `--approval-mode yolo` (modern form of `--yolo`) — needed
 *   headlessly because the native `activate_skill` tool prompts for consent.
 * - Skills: first-class SKILL.md support; project-level discovery from
 *   `.gemini/skills/` (or the `.agents/skills/` alias). We mount at
 *   `.gemini/skills` (the canonical documented path).
 * - Invocation surfaces: the native `activate_skill` tool (primary), plus any
 *   read-style tool whose parameters reference a SKILL.md path (fallback,
 *   always counted — same promotion as the Codex runner).
 * - Install: npm install -g @google/gemini-cli; version via `gemini --version`.
 *
 * Isolation caveat: the user's global ~/.gemini settings and skills are NOT
 * isolated by this runner (no documented equivalent of codex
 * --ignore-user-config was found). Treat discovery metrics accordingly.
 */

import * as path from 'path';
import type {
  EvalTask,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { buildTokenUsage, extractErrorMessage, ROUGH_COST_PER_TOKEN } from './base-runner.js';
import { CliRunner, skillNameFromToolInput } from './cli-runner.js';
import type { CliTaskResultFields } from './cli-runner.js';
import type { CliJsonlResult } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';

export const GEMINI_CLI_INSTALL_HINT =
  'Gemini CLI not found on PATH. Install: npm install -g @google/gemini-cli';

const EXPERIMENTAL_WARNING =
  'Warning: the gemini runner is EXPERIMENTAL — built from documented output formats; ' +
  'not yet verified against a live CLI. Captured transcripts wanted ' +
  '(see src/__tests__/fixtures/transcripts/README.md).';

let warnedExperimental = false;

interface GeminiFoldState {
  /** Assistant message texts, joined at finalize. */
  texts: string[];
  numTurns: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
  /** True when a terminal result event (or json-mode response object) was seen. */
  sawResult: boolean;
  errorMessage?: string;
}

export class GeminiRunner extends CliRunner<GeminiFoldState> {
  get providerName(): string {
    return 'gemini';
  }

  protected readonly command = 'gemini';
  protected readonly installHint = GEMINI_CLI_INSTALL_HINT;

  /** Canonical documented project-level skills dir (`.agents/skills` is an alias). */
  override readonly skillsMountPath = path.join('.gemini', 'skills');

  protected override beforeRunTask(): void {
    if (!warnedExperimental) {
      warnedExperimental = true;
      console.warn(EXPERIMENTAL_WARNING);
    }
  }

  protected buildArgs(task: EvalTask): string[] {
    const args = [
      '-p', task.prompt,
      '--output-format', 'stream-json',
      // Auto-approve tool use, incl. the activate_skill consent prompt.
      '--approval-mode', 'yolo',
    ];

    // Skip -m for the framework default ('sonnet', a Claude alias): let the
    // Gemini CLI pick its own default model.
    const model = this.options.model;
    if (model && model !== DEFAULT_CONFIG.defaultAgentModel) {
      args.push('-m', model);
    }

    return args;
  }

  protected createInitialState(): GeminiFoldState {
    return {
      texts: [],
      numTurns: 0,
      skillLoads: [],
      toolCalls: [],
      sawResult: false,
    };
  }

  /**
   * Best-effort fold of one Gemini stream-json event. Field names for message
   * chunks are not fully documented, so several shapes are tolerated.
   */
  protected handleEvent(event: unknown, state: GeminiFoldState, logger?: SessionLogger): void {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;

    // json (single-object) mode fallback: { response, stats, error? }.
    if (typeof record.response === 'string' && record.type === undefined) {
      state.texts.push(record.response);
      state.sawResult = true;
      return;
    }

    switch (record.type) {
      case 'message': {
        // Tolerated shapes: {content: "..."} | {text: "..."} | {message:{content}}
        const role = (record.role as string) ?? 'assistant';
        const content = record.content ?? record.text
          ?? (record.message as Record<string, unknown> | undefined)?.content;
        if (role === 'assistant' && typeof content === 'string' && content) {
          state.texts.push(content);
          logger?.addTextMessage(content);
        }
        break;
      }

      case 'tool_use': {
        const toolName = (record.tool_name as string) ?? (record.name as string) ?? 'unknown';
        const parameters = record.parameters ?? record.input;
        state.toolCalls.push({
          tool: toolName,
          toolUseId: (record.tool_id as string) ?? '',
          timestamp: Date.now(),
          input: parameters,
        });
        logger?.addToolUse(toolName, parameters);

        // Primary surface: the native activate_skill tool.
        if (toolName === 'activate_skill') {
          const params = parameters as Record<string, unknown> | undefined;
          const skillName = (params?.skill as string) ?? (params?.name as string);
          if (skillName) state.skillLoads.push(skillName);
        } else {
          // Fallback surface: read-style tool touching a SKILL.md path.
          const skillName = skillNameFromToolInput(parameters);
          if (skillName) state.skillLoads.push(skillName);
        }
        break;
      }

      case 'error': {
        state.errorMessage =
          extractErrorMessage(record.message ?? record.error) ?? 'unknown error event';
        break;
      }

      case 'result': {
        state.sawResult = true;
        if (typeof record.response === 'string' && record.response) {
          state.texts.push(record.response);
        }
        const stats = record.stats as {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          tool_calls?: number;
        } | undefined;
        if (stats && (stats.input_tokens !== undefined || stats.output_tokens !== undefined)) {
          state.tokens = buildTokenUsage({
            input: stats.input_tokens,
            output: stats.output_tokens,
          });
        }
        state.numTurns = 1;
        break;
      }
    }
  }

  protected detectFailure(cli: CliJsonlResult, state: GeminiFoldState): string | null {
    if (state.errorMessage) return `reported an error: ${state.errorMessage}`;
    if (cli.exitCode !== 0) return `exited with code ${cli.exitCode}`;
    if (!state.sawResult) return 'exited without a result event';
    return null;
  }

  protected finalize(state: GeminiFoldState, cli: CliJsonlResult): CliTaskResultFields {
    const tokens = state.tokens;
    return {
      output: state.texts.join('\n\n'),
      durationMs: cli.durationMs,
      numTurns: state.numTurns,
      costUsd: tokens ? tokens.total * ROUGH_COST_PER_TOKEN : 0,
      skillLoads: state.skillLoads,
      toolCalls: state.toolCalls,
      tokens,
    };
  }
}
