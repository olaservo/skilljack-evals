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
  TaskResult,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { BaseRunner, buildTokenUsage, ROUGH_COST_PER_TOKEN } from './base-runner.js';
import { runCliJsonl, detectCli } from '../harness/subprocess.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';
import { skillNameFromCommand } from './codex-runner.js';

export const GEMINI_CLI_INSTALL_HINT =
  'Gemini CLI not found on PATH. Install: npm install -g @google/gemini-cli';

const EXPERIMENTAL_WARNING =
  'Warning: the gemini runner is EXPERIMENTAL — built from documented output formats; ' +
  'not yet verified against a live CLI. Captured transcripts wanted ' +
  '(see src/__tests__/fixtures/transcripts/README.md).';

let warnedExperimental = false;

interface ParsedGeminiTranscript {
  output: string;
  numTurns: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
  /** True when a terminal result event (or json-mode response object) was seen. */
  sawResult: boolean;
  errorMessage?: string;
}

/** Scan a tool_use parameters object for any string referencing a SKILL.md path. */
function skillNameFromParameters(parameters: unknown): string | undefined {
  if (typeof parameters === 'string') return skillNameFromCommand(parameters);
  if (typeof parameters !== 'object' || parameters === null) return undefined;
  for (const value of Object.values(parameters as Record<string, unknown>)) {
    if (typeof value === 'string') {
      const name = skillNameFromCommand(value);
      if (name) return name;
    }
  }
  return undefined;
}

export class GeminiRunner extends BaseRunner {
  readonly providerName = 'gemini';

  /** Canonical documented project-level skills dir (`.agents/skills` is an alias). */
  override readonly skillsMountPath = path.join('.gemini', 'skills');

  private cliDetection: Promise<CliDetection> | undefined;

  /** Spawn the CLI. Protected so tests can inject a fake subprocess. */
  protected runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    return runCliJsonl(options);
  }

  /** Detect the CLI. Protected so tests can bypass the preflight. */
  protected detect(): Promise<CliDetection> {
    return detectCli('gemini', ['--version'], { installHint: GEMINI_CLI_INSTALL_HINT });
  }

  private async ensureCliAvailable(): Promise<void> {
    this.cliDetection ??= this.detect();
    const detection = await this.cliDetection;
    if (!detection.available) {
      throw new Error(detection.reason ?? GEMINI_CLI_INSTALL_HINT);
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

      const cli = await this.runCli({
        command: 'gemini',
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

      if (cli.exitCode !== 0 || !parsed.sawResult || parsed.errorMessage) {
        const problem = parsed.errorMessage
          ? `reported an error: ${parsed.errorMessage}`
          : cli.exitCode !== 0
            ? `exited with code ${cli.exitCode}`
            : 'exited without a result event';
        const stderrExcerpt = cli.stderr.trim().slice(0, 500);
        return this.createErrorResult(
          task,
          `gemini CLI ${problem}${stderrExcerpt ? `: ${stderrExcerpt}` : ''}`,
          cli.durationMs,
        );
      }

      return this.buildTaskResult(task, {
        output: parsed.output,
        durationMs: cli.durationMs,
        numTurns: parsed.numTurns,
        costUsd: parsed.tokens ? parsed.tokens.total * ROUGH_COST_PER_TOKEN : 0,
        skillLoads: parsed.skillLoads,
        toolCalls: parsed.toolCalls,
        tokens: parsed.tokens,
      });
    } catch (error) {
      return this.handleRunError(task, error, startTime, logger);
    }
  }

  /**
   * Best-effort parse of Gemini stream-json events. Field names for message
   * chunks are not fully documented, so several shapes are tolerated.
   */
  private parseEvents(events: unknown[], logger?: SessionLogger): ParsedGeminiTranscript {
    const parsed: ParsedGeminiTranscript = {
      output: '',
      numTurns: 0,
      skillLoads: [],
      toolCalls: [],
      sawResult: false,
    };

    const texts: string[] = [];

    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;
      const record = event as Record<string, unknown>;

      // json (single-object) mode fallback: { response, stats, error? }.
      if (typeof record.response === 'string' && record.type === undefined) {
        texts.push(record.response);
        parsed.sawResult = true;
        continue;
      }

      switch (record.type) {
        case 'message': {
          // Tolerated shapes: {content: "..."} | {text: "..."} | {message:{content}}
          const role = (record.role as string) ?? 'assistant';
          const content = record.content ?? record.text
            ?? (record.message as Record<string, unknown> | undefined)?.content;
          if (role === 'assistant' && typeof content === 'string' && content) {
            texts.push(content);
            logger?.addTextMessage(content);
          }
          break;
        }

        case 'tool_use': {
          const toolName = (record.tool_name as string) ?? (record.name as string) ?? 'unknown';
          const parameters = record.parameters ?? record.input;
          parsed.toolCalls.push({
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
            if (skillName) parsed.skillLoads.push(skillName);
          } else {
            // Fallback surface: read-style tool touching a SKILL.md path.
            const skillName = skillNameFromParameters(parameters);
            if (skillName) parsed.skillLoads.push(skillName);
          }
          break;
        }

        case 'error': {
          const message = (record.message as string) ?? (record.error as string);
          parsed.errorMessage = message ? String(message) : 'unknown error event';
          break;
        }

        case 'result': {
          parsed.sawResult = true;
          if (typeof record.response === 'string' && record.response) {
            texts.push(record.response);
          }
          const stats = record.stats as {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            tool_calls?: number;
          } | undefined;
          if (stats && (stats.input_tokens !== undefined || stats.output_tokens !== undefined)) {
            parsed.tokens = buildTokenUsage({
              input: stats.input_tokens,
              output: stats.output_tokens,
            });
          }
          parsed.numTurns = 1;
          break;
        }
      }
    }

    parsed.output = texts.join('\n\n');
    return parsed;
  }
}
