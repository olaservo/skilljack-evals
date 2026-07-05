/**
 * OpenCode CLI Runner — EXPERIMENTAL.
 *
 * Built from the official OpenCode docs (opencode.ai/docs) and source
 * (anomalyco/opencode run.ts / session schema), NOT yet verified against a
 * live CLI on this machine — captured transcripts wanted. Unit tests replay a
 * hand-written SYNTHETIC fixture
 * (src/__tests__/fixtures/transcripts/opencode/synthetic-*.jsonl).
 *
 * Documented facts this implementation relies on (July 2026):
 * - Non-interactive: `opencode run --format json --auto "<prompt>"` emits a
 *   JSONL stream of events `{type, timestamp, sessionID, ...data}` with types
 *   text, tool_use, step_start, step_finish, error. The plan's original guess
 *   included `--print-logs`; that flag only mirrors logs to stderr, so it is
 *   omitted. `--auto` is REQUIRED: without it non-interactive permission
 *   requests are auto-REJECTED (docs/permissions).
 * - Skills: native SKILL.md support. Project-level discovery from
 *   `.opencode/skills/<name>/SKILL.md` (PLURAL `skills` — the plan's
 *   `.opencode/skill` guess was wrong per current docs), plus Claude-compat
 *   `.claude/skills/` and `.agents/skills/`. We mount at `.opencode/skills`.
 * - Invocation surface: the native `skill` tool, invoked as
 *   `skill({name: "<skill-name>"})` → primary. Read-style tools touching a
 *   SKILL.md path are the fallback surface (always counted).
 * - step_finish events carry `{cost, tokens: {input, output, reasoning,
 *   cache: {read, write}}}`.
 * - Install: npm install -g opencode-ai; version via `opencode --version`.
 *
 * Isolation caveat: the user's global config (~/.config/opencode) AND global
 * skills (~/.claude/skills, ~/.agents/skills) are in scope by default and may
 * contaminate discovery metrics. OPENCODE_CONFIG_DIR may displace the global
 * config dir, but whether it also displaces global skill discovery is
 * undocumented — left to a live-CLI verification pass.
 */

import * as path from 'path';
import type {
  EvalTask,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { buildTokenUsage } from './base-runner.js';
import { CliRunner, skillNameFromToolInput } from './cli-runner.js';
import type { CliTaskResultFields } from './cli-runner.js';
import type { CliJsonlResult } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';

export const OPENCODE_CLI_INSTALL_HINT =
  'OpenCode CLI not found on PATH. Install: npm install -g opencode-ai';

const EXPERIMENTAL_WARNING =
  'Warning: the opencode runner is EXPERIMENTAL — built from documented output formats; ' +
  'not yet verified against a live CLI. Captured transcripts wanted ' +
  '(see src/__tests__/fixtures/transcripts/README.md).';

let warnedExperimental = false;

interface OpenCodeFoldState {
  /** Assistant text events, joined at finalize. */
  texts: string[];
  numTurns: number;
  costUsd: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
  /** True when at least one step_finish (or text) event was seen. */
  sawCompletion: boolean;
  errorMessage?: string;
}

export class OpenCodeRunner extends CliRunner<OpenCodeFoldState> {
  get providerName(): string {
    return 'opencode';
  }

  protected readonly command = 'opencode';
  protected readonly installHint = OPENCODE_CLI_INSTALL_HINT;

  /** OpenCode's native project-level skills dir (docs: plural `skills`). */
  override readonly skillsMountPath = path.join('.opencode', 'skills');

  protected override beforeRunTask(): void {
    if (!warnedExperimental) {
      warnedExperimental = true;
      console.warn(EXPERIMENTAL_WARNING);
    }
  }

  protected buildArgs(task: EvalTask): string[] {
    const args = [
      'run',
      '--format', 'json',
      // Auto-approve permissions not explicitly denied; without this,
      // non-interactive permission requests are rejected.
      '--auto',
    ];

    // Skip -m for the framework default ('sonnet', a Claude alias without
    // OpenCode's required provider/model form): use the user's default model.
    const model = this.options.model;
    if (model && model !== DEFAULT_CONFIG.defaultAgentModel) {
      args.push('--model', model);
    }

    args.push(task.prompt);

    return args;
  }

  protected createInitialState(): OpenCodeFoldState {
    return {
      texts: [],
      numTurns: 0,
      costUsd: 0,
      skillLoads: [],
      toolCalls: [],
      sawCompletion: false,
    };
  }

  /**
   * Best-effort fold of one OpenCode --format json event. Events are the
   * message parts spread into `{type, timestamp, sessionID, ...part}`; a
   * nested `part` object is also tolerated.
   */
  protected handleEvent(event: unknown, state: OpenCodeFoldState, logger?: SessionLogger): void {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;
    const part = (record.part as Record<string, unknown> | undefined) ?? record;

    switch (record.type) {
      case 'text': {
        const text = (part.text as string) ?? (record.text as string);
        if (typeof text === 'string' && text) {
          state.texts.push(text);
          logger?.addTextMessage(text);
        }
        state.sawCompletion = true;
        break;
      }

      case 'tool_use': {
        const toolName = (part.tool as string) ?? (record.tool as string) ?? 'unknown';
        const toolState = part.state as Record<string, unknown> | undefined;
        const input = toolState?.input ?? part.input;
        state.toolCalls.push({
          tool: toolName,
          toolUseId: (part.callID as string) ?? '',
          timestamp: Date.now(),
          input,
        });
        logger?.addToolUse(toolName, input);

        // Primary surface: the native `skill` tool.
        if (toolName === 'skill') {
          const skillName = (input as Record<string, unknown> | undefined)?.name;
          if (typeof skillName === 'string' && skillName) {
            state.skillLoads.push(skillName);
          }
        } else {
          // Fallback surface: read-style tool touching a SKILL.md path.
          const skillName = skillNameFromToolInput(input);
          if (skillName) state.skillLoads.push(skillName);
        }
        break;
      }

      case 'step_finish': {
        state.sawCompletion = true;
        state.numTurns++;
        const cost = (part.cost as number) ?? (record.cost as number);
        if (typeof cost === 'number') state.costUsd += cost;

        const tokens = (part.tokens ?? record.tokens) as {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        } | undefined;
        if (tokens) {
          state.tokens = buildTokenUsage({
            input: tokens.input,
            output: tokens.output,
            cacheRead: tokens.cache?.read,
            cacheCreation: tokens.cache?.write,
          });
        }
        break;
      }

      case 'error': {
        const message = (part.message as string) ?? (record.error as string);
        state.errorMessage = message ? String(message) : 'unknown error event';
        break;
      }
    }
  }

  protected detectFailure(cli: CliJsonlResult, state: OpenCodeFoldState): string | null {
    if (state.errorMessage) return `reported an error: ${state.errorMessage}`;
    if (cli.exitCode !== 0) return `exited with code ${cli.exitCode}`;
    if (!state.sawCompletion) return 'exited without completing a step';
    return null;
  }

  protected finalize(state: OpenCodeFoldState, cli: CliJsonlResult): CliTaskResultFields {
    return {
      output: state.texts.join('\n\n'),
      durationMs: cli.durationMs,
      numTurns: state.numTurns,
      costUsd: state.costUsd,
      skillLoads: state.skillLoads,
      toolCalls: state.toolCalls,
      tokens: state.tokens,
    };
  }
}
