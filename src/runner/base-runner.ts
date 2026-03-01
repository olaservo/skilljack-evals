/**
 * Abstract base runner with shared timeout and orchestration logic.
 *
 * Concrete runners only need to implement runTask(). The timeout wrapper
 * and sequential/parallel orchestration are identical across all providers.
 */

import type { AgentRunner, AgentRunnerOptions } from './agent-runner.js';
import type {
  EvalTask,
  SkillEvaluation,
  TaskResult,
} from '../types.js';
import { loadConfigSync } from '../config.js';
import type { EvalConfig } from '../config.js';
import type { SessionLogger } from '../session/session-logger.js';

export abstract class BaseRunner implements AgentRunner {
  abstract readonly providerName: string;
  protected options: AgentRunnerOptions;

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
      parallel: options.parallel ?? false,
      model: options.model ?? resolvedConfig.defaultAgentModel,
      taskTimeoutMs: options.taskTimeoutMs ?? resolvedConfig.taskTimeoutMs,
      allowedWriteDirs: options.allowedWriteDirs ?? resolvedConfig.allowedWriteDirs,
      skillsDir: options.skillsDir,
    };
  }

  abstract runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult>;

  /**
   * Execute a task with timeout protection.
   */
  async runTaskWithTimeout(
    task: EvalTask,
    timeoutMs?: number,
    logger?: SessionLogger,
  ): Promise<TaskResult> {
    const timeout = timeoutMs ?? this.options.taskTimeoutMs ?? 300000;

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
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.markAsError(errorMessage);

      return {
        taskId: task.id,
        prompt: task.prompt,
        output: '',
        durationMs: timeout,
        numTurns: 0,
        costUsd: 0,
        skillLoads: [],
        toolCalls: [],
        isError: true,
        errorMessage,
      };
    } finally {
      clearTimeout(abortTimer);
    }
  }

  /**
   * Run all tasks in an evaluation suite.
   */
  async runAll(
    evaluation: SkillEvaluation,
    createLogger?: (task: EvalTask) => SessionLogger,
  ): Promise<TaskResult[]> {
    if (this.options.parallel) {
      const results = await Promise.allSettled(
        evaluation.tasks.map((task) => {
          const logger = createLogger?.(task);
          return this.runTaskWithTimeout(task, undefined, logger);
        }),
      );

      return results.map((result, i) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }
        const task = evaluation.tasks[i];
        return {
          taskId: task.id,
          prompt: task.prompt,
          output: '',
          durationMs: 0,
          numTurns: 0,
          costUsd: 0,
          skillLoads: [],
          toolCalls: [],
          isError: true,
          errorMessage: result.reason?.message || 'Unknown error',
        };
      });
    }

    const results: TaskResult[] = [];
    for (const task of evaluation.tasks) {
      console.log(`Running task ${task.id}: ${task.prompt.slice(0, 60)}...`);
      const logger = createLogger?.(task);
      const result = await this.runTaskWithTimeout(task, undefined, logger);
      results.push(result);

      if (result.isError) {
        console.error(`  ERROR: ${result.errorMessage}`);
      } else {
        console.log(`  Skills loaded: ${result.skillLoads.join(', ') || 'none'}`);
        console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s | Cost: $${result.costUsd.toFixed(4)}`);
      }
    }
    return results;
  }
}
