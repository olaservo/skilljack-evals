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
import { runFixtureScript } from './fixture-runner.js';

export abstract class BaseRunner implements AgentRunner {
  abstract readonly providerName: string;
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
   * Execute a task with timeout protection and fixture setup/teardown.
   *
   * If the task has a fixture with setup/teardown scripts, they are executed
   * around the task: setup before, teardown after (in a finally block).
   * Setup failure skips the task. Teardown failure warns but does not fail.
   */
  async runTaskWithTimeout(
    task: EvalTask,
    timeoutMs?: number,
    logger?: SessionLogger,
  ): Promise<TaskResult> {
    const timeout = timeoutMs ?? this.options.taskTimeoutMs ?? 300000;
    const cwd = this.options.cwd ?? process.cwd();
    const fixture = task.fixture;

    let taskResult: TaskResult | undefined;

    try {
      // Run fixture setup if defined
      if (fixture?.setup) {
        const setupResult = await runFixtureScript(fixture.setup, cwd);
        if (!setupResult.success) {
          taskResult = this.createErrorResult(
            task,
            `Fixture setup failed: ${setupResult.errorMessage}`,
            0,
          );
          return taskResult;
        }
      }

      // Run the task with timeout
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), timeout);

      try {
        const result = await Promise.race([
          this.runTask(task, logger),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () =>
              reject(new Error(`Task ${task.id} timed out after ${timeout}ms`)),
            );
          }),
        ]);
        taskResult = result;
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger?.markAsError(errorMessage);
        taskResult = this.createErrorResult(task, errorMessage, timeout);
        return taskResult;
      } finally {
        clearTimeout(abortTimer);
      }
    } finally {
      // Run fixture teardown if defined (always, even after setup failure)
      if (fixture?.teardown) {
        try {
          const teardownResult = await runFixtureScript(fixture.teardown, cwd);
          if (!teardownResult.success) {
            console.warn(
              `Fixture teardown failed for task ${task.id}: ${teardownResult.errorMessage}`,
            );
          }
        } catch (teardownError) {
          console.warn(
            `Fixture teardown threw for task ${task.id}: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`,
          );
        }
      }
    }
  }
}
