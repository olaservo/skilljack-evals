/**
 * Abstract base runner with shared timeout and orchestration logic.
 *
 * Concrete runners only need to implement runTask(). The timeout wrapper
 * and sequential/parallel orchestration are identical across all providers.
 */

import type { AgentRunner, AgentRunnerOptions } from './agent-runner.js';
import type {
  EvalTask,
  TaskResult,
  TokenUsage,
  ToolCallRecord,
} from '../types.js';
import { loadConfigSync } from '../config.js';
import type { EvalConfig } from '../config.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_SKILLS_MOUNT_PATH } from '../run/workspace.js';

/**
 * Rough per-token cost for runners without per-model pricing data. Calibrated
 * near Sonnet input rates — accurate enough to compare runs within a model
 * family, not accurate enough for billing.
 */
export const ROUGH_COST_PER_TOKEN = 0.000003;

let warnedCliRunnerSecurity = false;

/**
 * One-time-per-process security warning shared by all CLI runners. The CLI
 * harnesses (claude-code, codex, gemini, opencode) run the real agent fully
 * auto-approved on the host — v1's allowedWriteDirs restriction only survives
 * in the claude-sdk runner's PreToolUse hook, so users must be told the agent
 * is unrestricted here.
 */
export function warnCliRunnerSecurity(providerName: string): void {
  if (warnedCliRunnerSecurity) return;
  warnedCliRunnerSecurity = true;
  console.warn(
    `⚠ ${providerName} runs the agent with all permissions granted on this host (no write restrictions). ` +
    'Run only skills/tasks you trust; --sandbox docker isolates verifiers, not the agent.',
  );
}

/** Test hook: re-arm the one-time CLI runner security warning. */
export function resetCliRunnerSecurityWarningForTests(): void {
  warnedCliRunnerSecurity = false;
}

/**
 * Normalize a runner-provided usage snapshot into TokenUsage, enforcing
 * `total = input + output + cacheRead + cacheCreation`. Returns undefined
 * when the runner did not surface any usage.
 */
export function buildTokenUsage(
  raw: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined,
): TokenUsage | undefined {
  if (!raw) return undefined;
  const input = raw.input ?? 0;
  const output = raw.output ?? 0;
  const cacheRead = raw.cacheRead ?? 0;
  const cacheCreation = raw.cacheCreation ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    total: input + output + cacheRead + cacheCreation,
  };
}

/**
 * Extract a human-readable message from a CLI error payload: a plain string,
 * `{data: {message}}` (opencode NamedError serialization), `{message}`, or
 * `{name}` — else a JSON dump so nothing degrades to "[object Object]".
 * Shared by the CLI runners' error-event handlers.
 */
export function extractErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error || undefined;
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const message = data?.message ?? record.message ?? record.name;
  if (typeof message === 'string' && message) return message;
  try {
    return JSON.stringify(error);
  } catch {
    return undefined;
  }
}

/**
 * Extract a skill name from a Read tool file path when it points inside a
 * skills directory (the SKILL.md read fallback used when countReadAsFallback
 * is set). Handles both / and \ separators. Returns undefined when the path
 * is not a skill read.
 */
export function skillNameFromReadPath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.includes('SKILL.md') && !normalized.includes('/skills/')) return undefined;
  const match = normalized.match(/skills\/([^/]+)/);
  return match ? match[1] : undefined;
}

export abstract class BaseRunner implements AgentRunner {
  abstract readonly providerName: string;

  /**
   * Workspace-relative skill discovery path for this harness. Claude runners
   * use '.claude/skills'; CLI harnesses with a different convention (Codex:
   * '.agents/skills', OpenCode: '.opencode/skills') override this.
   */
  readonly skillsMountPath: string = DEFAULT_SKILLS_MOUNT_PATH;

  protected options: AgentRunnerOptions;

  /** Read-only access to resolved runner options (for testing and introspection). */
  get runnerOptions(): Readonly<AgentRunnerOptions> {
    return this.options;
  }

  /**
   * @param options - Runner options (cwd, model, timeout, etc.)
   * @param config - Pre-loaded EvalConfig. If omitted, falls back to
   *   loadConfigSync() which only reads env vars + defaults (no YAML file).
   *   The pipeline always passes a fully-loaded config, but direct API users
   *   should call loadConfig() first and pass the result here.
   */
  constructor(options: AgentRunnerOptions = {}, config?: EvalConfig) {
    const resolvedConfig = config ?? loadConfigSync();

    this.options = {
      cwd: options.cwd ?? process.cwd(),
      model: options.model ?? resolvedConfig.defaultAgentModel,
      taskTimeoutMs: options.taskTimeoutMs ?? resolvedConfig.taskTimeoutMs,
      allowedWriteDirs: options.allowedWriteDirs ?? resolvedConfig.allowedWriteDirs,
      skillsDir: options.skillsDir,
      countReadAsFallback: options.countReadAsFallback ?? false,
    };
  }

  /**
   * Create a standardized error TaskResult.
   */
  protected createErrorResult(
    task: EvalTask,
    errorMessage: string,
    durationMs: number,
  ): TaskResult {
    return {
      taskId: task.id,
      prompt: task.prompt,
      output: '',
      durationMs,
      numTurns: 0,
      costUsd: 0,
      skillLoads: [],
      toolCalls: [],
      isError: true,
      errorMessage,
    };
  }

  /**
   * Build a successful TaskResult. Dedupes skillLoads.
   */
  protected buildTaskResult(
    task: EvalTask,
    fields: {
      output: string;
      durationMs: number;
      numTurns: number;
      costUsd: number;
      skillLoads: string[];
      toolCalls: ToolCallRecord[];
      tokens?: TokenUsage;
    },
  ): TaskResult {
    return {
      taskId: task.id,
      prompt: task.prompt,
      output: fields.output,
      durationMs: fields.durationMs,
      numTurns: fields.numTurns,
      costUsd: fields.costUsd,
      skillLoads: [...new Set(fields.skillLoads)],
      toolCalls: fields.toolCalls,
      isError: false,
      errorMessage: '',
      tokens: fields.tokens,
    };
  }

  /**
   * Handle a caught error inside runTask: log it and build an error TaskResult.
   */
  protected handleRunError(
    task: EvalTask,
    error: unknown,
    startTime: number,
    logger?: SessionLogger,
  ): TaskResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger?.markAsError(errorMessage);
    return this.createErrorResult(task, errorMessage, Date.now() - startTime);
  }

  /**
   * Dynamically import a module, throwing a helpful error if missing.
   * Protected to allow test subclasses to inject mocks.
   */
  protected async dynamicImport(pkg: string, installHint: string): Promise<any> {
    try {
      return await (Function('pkg', 'return import(pkg)')(pkg));
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : '';
      throw new Error(`${pkg} is required${detail}. Install with: npm install ${installHint}`);
    }
  }

  abstract runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult>;

  /**
   * Execute a task with timeout protection.
   *
   * Timeout precedence: explicit argument > task.timeoutMs > runner option > 5min.
   */
  async runTaskWithTimeout(
    task: EvalTask,
    timeoutMs?: number,
    logger?: SessionLogger,
  ): Promise<TaskResult> {
    const timeout = timeoutMs ?? task.timeoutMs ?? this.options.taskTimeoutMs ?? 300000;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeout);

    try {
      return await Promise.race([
        this.runTask(task, logger),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`Task ${task.id} timed out after ${timeout}ms`)),
          );
        }),
      ]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.markAsError(errorMessage);
      return this.createErrorResult(task, errorMessage, timeout);
    } finally {
      clearTimeout(abortTimer);
    }
  }
}
