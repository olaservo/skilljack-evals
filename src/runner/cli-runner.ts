/**
 * Abstract base class for CLI harness runners (claude-code, codex, gemini,
 * opencode).
 *
 * Owns everything the four CLI runners previously duplicated:
 * - the one-time-per-process security warning (emitted at construction),
 * - CLI preflight: a memoized detect() promise + ensureCliAvailable(),
 * - runTask orchestration: cwd/timeout resolution, spawning via the
 *   protected runCli() seam, the timedOut → error-result path, and the
 *   shared `<command> CLI <problem>: <stderr excerpt>` error shaping,
 * - INCREMENTAL event folding: events are reduced one at a time through the
 *   subclass handleEvent() reducer as the subprocess streams them (via
 *   RunCliJsonlOptions.onEvent), so full transcripts are never held in
 *   memory.
 *
 * Subclasses declare the CLI surface (`command`, `installHint`, optionally
 * `versionArgs`) and the parsing semantics (buildArgs, createInitialState,
 * handleEvent, detectFailure, finalize). Tests keep injecting fakes by
 * overriding the protected runCli()/detect() seams; a fake that resolves
 * with a full `events` array (fixture replay) without driving onEvent is
 * folded through the same reducer after the fact, so both paths produce
 * identical TaskResults.
 */

import type {
  EvalTask,
  TaskResult,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { BaseRunner, warnCliRunnerSecurity } from './base-runner.js';
import { runCliJsonl, detectCli } from '../harness/subprocess.js';
import type { RunCliJsonlOptions, CliJsonlResult, CliDetection } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import type { AgentRunnerOptions } from './agent-runner.js';
import type { EvalConfig } from '../config.js';

/**
 * Extract a skill name from a shell command string when it references a
 * SKILL.md under a skills directory. Handles Windows commands where
 * backslashes appear doubled inside quoted PowerShell arguments (e.g.
 * `...\\.agents\\skills\\greeting\\SKILL.md`).
 *
 * (Also re-exported from codex-runner.ts, its original home, for API
 * stability — Codex uses it as the PRIMARY skill-invocation surface.)
 */
export function skillNameFromCommand(command: string): string | undefined {
  if (!command || !command.includes('SKILL.md')) return undefined;
  const normalized = command.replace(/[\\/]+/g, '/');
  const match = normalized.match(/skills\/([^/'"\s]+)\/SKILL\.md/);
  return match ? match[1] : undefined;
}

/**
 * Scan a tool input/parameters object for any string referencing a SKILL.md
 * path. The fallback skill-invocation surface for read-style tools (used by
 * the gemini and opencode runners, which previously each had a byte-similar
 * private copy).
 */
export function skillNameFromToolInput(input: unknown): string | undefined {
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

/** Fields a CLI runner's finalize() produces for BaseRunner.buildTaskResult. */
export interface CliTaskResultFields {
  output: string;
  durationMs: number;
  numTurns: number;
  costUsd: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  tokens?: TokenUsage;
}

export abstract class CliRunner<TState> extends BaseRunner {
  /** Executable spawned for tasks and the version preflight (e.g. 'claude'). */
  protected abstract readonly command: string;

  /** Args for the version preflight. */
  protected readonly versionArgs: string[] = ['--version'];

  /** Actionable install message used when the CLI is missing. */
  protected abstract readonly installHint: string;

  /** Lazy preflight result, shared across tasks. */
  private cliDetection: Promise<CliDetection> | undefined;

  constructor(options: AgentRunnerOptions = {}, config?: EvalConfig) {
    super(options, config);
    // NOTE: providerName must be implemented as a GETTER in subclasses —
    // prototype accessors are visible while this base constructor runs,
    // whereas an ES2022 instance field would still be undefined here. The
    // cast silences TS2715 (abstract member access in a constructor), which
    // is exactly the deliberate pattern described above.
    warnCliRunnerSecurity((this as { providerName: string }).providerName);
  }

  /** Spawn the CLI. Protected so tests can inject a fake subprocess. */
  protected runCli(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
    return runCliJsonl(options);
  }

  /** Detect the CLI. Protected so tests can bypass the preflight. */
  protected detect(): Promise<CliDetection> {
    return detectCli(this.command, this.versionArgs, { installHint: this.installHint });
  }

  private async ensureCliAvailable(): Promise<void> {
    this.cliDetection ??= this.detect();
    const detection = await this.cliDetection;
    if (!detection.available) {
      throw new Error(detection.reason ?? this.installHint);
    }
  }

  /**
   * Hook invoked at the start of every runTask, before the CLI preflight
   * (and outside the error-handling try). Experimental runners override it
   * to print their once-per-process warning at first runTask.
   */
  protected beforeRunTask(): void {}

  /** Build the CLI argument vector for a task. */
  protected abstract buildArgs(task: EvalTask): string[];

  /** Create the empty fold state a fresh task starts from. */
  protected abstract createInitialState(): TState;

  /**
   * Reducer: fold one parsed JSONL event into the state. Called once per
   * event, in stream order — either incrementally while the subprocess runs
   * (onEvent) or over a fixture events array after runCli resolves.
   */
  protected abstract handleEvent(event: unknown, state: TState, logger?: SessionLogger): void;

  /**
   * Decide failure from the exit code + folded state. Return the `problem`
   * fragment for the `<command> CLI <problem>` error message, or null when
   * the run succeeded.
   */
  protected abstract detectFailure(cli: CliJsonlResult, state: TState): string | null;

  /** Build the final TaskResult fields from the folded state. */
  protected abstract finalize(state: TState, cli: CliJsonlResult): CliTaskResultFields;

  /**
   * Execute a single evaluation task via the CLI.
   */
  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const startTime = Date.now();

    this.beforeRunTask();

    try {
      await this.ensureCliAvailable();

      // Per-trial workspace (when set) becomes the CLI cwd.
      const cwd = task.workspaceDir ?? this.options.cwd ?? process.cwd();
      const timeoutMs = task.timeoutMs ?? this.options.taskTimeoutMs ?? 300000;

      const state = this.createInitialState();

      // Reducer errors are captured (not thrown) so a mid-stream failure
      // cannot blow up inside the subprocess stdout handler; the first one
      // is rethrown below into the standard handleRunError path.
      let reducerError: unknown;
      let sawReducerError = false;
      const foldEvent = (event: unknown): void => {
        if (sawReducerError) return;
        try {
          this.handleEvent(event, state, logger);
        } catch (err) {
          sawReducerError = true;
          reducerError = err;
        }
      };

      const cli = await this.runCli({
        command: this.command,
        args: this.buildArgs(task),
        cwd,
        env: process.env,
        timeoutMs,
        onEvent: foldEvent,
      });

      if (cli.timedOut) {
        return this.createErrorResult(
          task,
          `Task ${task.id} timed out after ${timeoutMs}ms`,
          cli.durationMs,
        );
      }

      // Compatibility path: runCliJsonl leaves events empty in onEvent mode,
      // but a test fake may resolve with a full fixture events array without
      // ever driving onEvent — fold those through the same reducer so both
      // paths produce identical results.
      for (const event of cli.events) {
        foldEvent(event);
      }

      if (sawReducerError) {
        throw reducerError instanceof Error ? reducerError : new Error(String(reducerError));
      }

      const problem = this.detectFailure(cli, state);
      if (problem !== null) {
        const stderrExcerpt = cli.stderr.trim().slice(0, 500);
        return this.createErrorResult(
          task,
          `${this.command} CLI ${problem}${stderrExcerpt ? `: ${stderrExcerpt}` : ''}`,
          cli.durationMs,
        );
      }

      return this.buildTaskResult(task, this.finalize(state, cli));
    } catch (error) {
      return this.handleRunError(task, error, startTime, logger);
    }
  }
}
