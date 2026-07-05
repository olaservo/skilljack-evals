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
  TaskResult,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { BaseRunner, buildTokenUsage, warnCliRunnerSecurity } from './base-runner.js';
import { runCliJsonl, detectCli } from '../harness/subprocess.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { EvalConfig } from '../config.js';
import type { AgentRunnerOptions } from './agent-runner.js';
import { skillNameFromCommand } from './codex-runner.js';

export const OPENCODE_CLI_INSTALL_HINT =
  'OpenCode CLI not found on PATH. Install: npm install -g opencode-ai';

const EXPERIMENTAL_WARNING =
  'Warning: the opencode runner is EXPERIMENTAL — built from documented output formats; ' +
  'not yet verified against a live CLI. Captured transcripts wanted ' +
  '(see src/__tests__/fixtures/transcripts/README.md).';

let warnedExperimental = false;

interface ParsedOpenCodeTranscript {
  output: string;
  numTurns: number;
  costUsd: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
  /** True when at least one step_finish (or text) event was seen. */
  sawCompletion: boolean;
  errorMessage?: string;
}

/** Scan a tool input object for any string referencing a SKILL.md path. */
function skillNameFromInput(input: unknown): string | undefined {
  if (typeof input === 'string') return skillNameFromCommand(input);
  if (typeof input !== 'object' || input === null) return undefined;
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      const name = skillNameFromCommand(value);
      if (name) return name;
    }
  }
  return undefined;
}

export class OpenCodeRunner extends BaseRunner {
  readonly providerName = 'opencode';

  /** OpenCode's native project-level skills dir (docs: plural `skills`). */
  override readonly skillsMountPath = path.join('.opencode', 'skills');

  private cliDetection: Promise<CliDetection> | undefined;

  constructor(options: AgentRunnerOptions = {}, config?: EvalConfig) {
    super(options, config);
    warnCliRunnerSecurity(this.providerName);
  }

  /** Spawn the CLI. Protected so tests can inject a fake subprocess. */
  protected runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    return runCliJsonl(options);
  }

  /** Detect the CLI. Protected so tests can bypass the preflight. */
  protected detect(): Promise<CliDetection> {
    return detectCli('opencode', ['--version'], { installHint: OPENCODE_CLI_INSTALL_HINT });
  }

  private async ensureCliAvailable(): Promise<void> {
    this.cliDetection ??= this.detect();
    const detection = await this.cliDetection;
    if (!detection.available) {
      throw new Error(detection.reason ?? OPENCODE_CLI_INSTALL_HINT);
    }
  }

  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const startTime = Date.now();

    if (!warnedExperimental) {
      warnedExperimental = true;
      console.warn(EXPERIMENTAL_WARNING);
    }

    try {
      await this.ensureCliAvailable();

      const cwd = task.workspaceDir ?? this.options.cwd ?? process.cwd();
      const timeoutMs = task.timeoutMs ?? this.options.taskTimeoutMs ?? 300000;

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

      const cli = await this.runCli({
        command: 'opencode',
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

      if (cli.exitCode !== 0 || !parsed.sawCompletion || parsed.errorMessage) {
        const problem = parsed.errorMessage
          ? `reported an error: ${parsed.errorMessage}`
          : cli.exitCode !== 0
            ? `exited with code ${cli.exitCode}`
            : 'exited without completing a step';
        const stderrExcerpt = cli.stderr.trim().slice(0, 500);
        return this.createErrorResult(
          task,
          `opencode CLI ${problem}${stderrExcerpt ? `: ${stderrExcerpt}` : ''}`,
          cli.durationMs,
        );
      }

      return this.buildTaskResult(task, {
        output: parsed.output,
        durationMs: cli.durationMs,
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
   * Best-effort parse of OpenCode --format json events. Events are the
   * message parts spread into `{type, timestamp, sessionID, ...part}`; a
   * nested `part` object is also tolerated.
   */
  private parseEvents(events: unknown[], logger?: SessionLogger): ParsedOpenCodeTranscript {
    const parsed: ParsedOpenCodeTranscript = {
      output: '',
      numTurns: 0,
      costUsd: 0,
      skillLoads: [],
      toolCalls: [],
      sawCompletion: false,
    };

    const texts: string[] = [];

    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;
      const record = event as Record<string, unknown>;
      const part = (record.part as Record<string, unknown> | undefined) ?? record;

      switch (record.type) {
        case 'text': {
          const text = (part.text as string) ?? (record.text as string);
          if (typeof text === 'string' && text) {
            texts.push(text);
            logger?.addTextMessage(text);
          }
          parsed.sawCompletion = true;
          break;
        }

        case 'tool_use': {
          const toolName = (part.tool as string) ?? (record.tool as string) ?? 'unknown';
          const state = part.state as Record<string, unknown> | undefined;
          const input = state?.input ?? part.input;
          parsed.toolCalls.push({
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
              parsed.skillLoads.push(skillName);
            }
          } else {
            // Fallback surface: read-style tool touching a SKILL.md path.
            const skillName = skillNameFromInput(input);
            if (skillName) parsed.skillLoads.push(skillName);
          }
          break;
        }

        case 'step_finish': {
          parsed.sawCompletion = true;
          parsed.numTurns++;
          const cost = (part.cost as number) ?? (record.cost as number);
          if (typeof cost === 'number') parsed.costUsd += cost;

          const tokens = (part.tokens ?? record.tokens) as {
            input?: number;
            output?: number;
            reasoning?: number;
            cache?: { read?: number; write?: number };
          } | undefined;
          if (tokens) {
            parsed.tokens = buildTokenUsage({
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
          parsed.errorMessage = message ? String(message) : 'unknown error event';
          break;
        }
      }
    }

    parsed.output = texts.join('\n\n');
    return parsed;
  }
}
