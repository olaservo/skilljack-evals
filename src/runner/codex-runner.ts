/**
 * Codex CLI Runner
 *
 * Drives the OpenAI Codex CLI (`codex exec --json`) as a subprocess per task
 * and parses its JSONL event stream into a TaskResult. Verified against
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
  TaskResult,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { BaseRunner, buildTokenUsage, ROUGH_COST_PER_TOKEN } from './base-runner.js';
import { runCliJsonl, detectCli } from '../harness/subprocess.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';

export const CODEX_CLI_INSTALL_HINT =
  'Codex CLI not found on PATH. Install: npm install -g @openai/codex';

/**
 * Extract a skill name from a shell command string when it references a
 * SKILL.md under a skills directory. Handles Windows commands where
 * backslashes appear doubled inside quoted PowerShell arguments (e.g.
 * `...\\.agents\\skills\\greeting\\SKILL.md`).
 */
export function skillNameFromCommand(command: string): string | undefined {
  if (!command || !command.includes('SKILL.md')) return undefined;
  const normalized = command.replace(/[\\/]+/g, '/');
  const match = normalized.match(/skills\/([^/'"\s]+)\/SKILL\.md/);
  return match ? match[1] : undefined;
}

/** Fields extracted from a codex exec --json event stream. */
interface ParsedCodexTranscript {
  /** All agent_message texts joined; ends with the final answer. */
  output: string;
  numTurns: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
  /** True when at least one turn.completed event was seen. */
  sawTurnCompleted: boolean;
}

export class CodexRunner extends BaseRunner {
  readonly providerName = 'codex';

  /** Codex discovers project-level skills from .agents/skills/ (spike-verified). */
  override readonly skillsMountPath = path.join('.agents', 'skills');

  /** Lazy preflight result, shared across tasks. */
  private cliDetection: Promise<CliDetection> | undefined;

  /** Spawn the CLI. Protected so tests can inject a fake subprocess. */
  protected runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    return runCliJsonl(options);
  }

  /** Detect the CLI. Protected so tests can bypass the preflight. */
  protected detect(): Promise<CliDetection> {
    return detectCli('codex', ['--version'], { installHint: CODEX_CLI_INSTALL_HINT });
  }

  private async ensureCliAvailable(): Promise<void> {
    this.cliDetection ??= this.detect();
    const detection = await this.cliDetection;
    if (!detection.available) {
      throw new Error(detection.reason ?? CODEX_CLI_INSTALL_HINT);
    }
  }

  /**
   * Execute a single evaluation task via the Codex CLI.
   */
  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const startTime = Date.now();

    try {
      await this.ensureCliAvailable();

      const cwd = task.workspaceDir ?? this.options.cwd ?? process.cwd();
      const timeoutMs = task.timeoutMs ?? this.options.taskTimeoutMs ?? 300000;

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

      const cli = await this.runCli({
        command: 'codex',
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

      if (cli.exitCode !== 0 || !parsed.sawTurnCompleted) {
        const problem = cli.exitCode !== 0
          ? `exited with code ${cli.exitCode}`
          : 'exited without a completed turn';
        const stderrExcerpt = cli.stderr.trim().slice(0, 500);
        return this.createErrorResult(
          task,
          `codex CLI ${problem}${stderrExcerpt ? `: ${stderrExcerpt}` : ''}`,
          cli.durationMs,
        );
      }

      return this.buildTaskResult(task, {
        output: parsed.output,
        durationMs: cli.durationMs,
        numTurns: parsed.numTurns,
        // Codex does not report cost; estimate from tokens when available.
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
   * Parse codex exec --json events into TaskResult fields.
   */
  private parseEvents(events: unknown[], logger?: SessionLogger): ParsedCodexTranscript {
    const parsed: ParsedCodexTranscript = {
      output: '',
      numTurns: 0,
      skillLoads: [],
      toolCalls: [],
      sawTurnCompleted: false,
    };

    const messages: string[] = [];

    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;
      const record = event as Record<string, unknown>;

      if (record.type === 'item.completed') {
        const item = record.item as Record<string, unknown> | undefined;
        if (!item) continue;

        if (item.type === 'agent_message' && typeof item.text === 'string') {
          messages.push(item.text);
          logger?.addTextMessage(item.text);
        }

        if (item.type === 'command_execution' && typeof item.command === 'string') {
          parsed.toolCalls.push({
            tool: 'command_execution',
            toolUseId: typeof item.id === 'string' ? item.id : '',
            timestamp: Date.now(),
            input: { command: item.command },
          });
          logger?.addToolUse('command_execution', { command: item.command });

          // Primary invocation surface for Codex: a shell read of SKILL.md.
          const skillName = skillNameFromCommand(item.command);
          if (skillName) {
            parsed.skillLoads.push(skillName);
          }
        }
      }

      if (record.type === 'turn.completed') {
        parsed.sawTurnCompleted = true;
        parsed.numTurns++;

        const usage = record.usage as {
          input_tokens?: number;
          cached_input_tokens?: number;
          output_tokens?: number;
        } | undefined;
        if (usage) {
          // codex input_tokens INCLUDES cached tokens; split them out so
          // TokenUsage.total = input + output + cacheRead stays correct.
          const cached = usage.cached_input_tokens ?? 0;
          parsed.tokens = buildTokenUsage({
            input: Math.max(0, (usage.input_tokens ?? 0) - cached),
            output: usage.output_tokens,
            cacheRead: cached,
          });
        }
      }
    }

    parsed.output = messages.join('\n\n');
    return parsed;
  }
}
