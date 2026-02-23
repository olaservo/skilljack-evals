/**
 * Agent Runner interface and shared options.
 *
 * All runner implementations (Claude SDK, Vercel AI SDK, OpenAI Agents SDK)
 * implement this interface to produce TaskResult objects consumed by the scorer.
 */

import type {
  EvalTask,
  SkillEvaluation,
  TaskResult,
} from '../types.js';
import type { SessionLogger } from '../session/session-logger.js';

/**
 * Options shared by all runner implementations.
 */
export interface AgentRunnerOptions {
  /** Working directory for agent execution */
  cwd?: string;
  /** Run tasks in parallel */
  parallel?: boolean;
  /** Model identifier (format depends on runner) */
  model?: string;
  /** Per-task timeout in ms */
  taskTimeoutMs?: number;
  /** Directories the agent is allowed to write to */
  allowedWriteDirs?: string[];
  /** Path to skills directory (for non-Claude runners that handle discovery natively) */
  skillsDir?: string;
}

/**
 * Interface that all agent runners must implement.
 *
 * Each runner is responsible for:
 * 1. Executing tasks against an agent using its native SDK
 * 2. Populating TaskResult with skill loads, tool calls, and output
 * 3. Handling skill discovery via the framework's native mechanism
 */
export interface AgentRunner {
  /** Human-readable provider name (e.g., 'claude-sdk', 'vercel-ai', 'openai-agents') */
  readonly providerName: string;

  /** Run a single task and produce a TaskResult */
  runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult>;

  /** Run a task with timeout protection */
  runTaskWithTimeout(
    task: EvalTask,
    timeoutMs?: number,
    logger?: SessionLogger,
  ): Promise<TaskResult>;

  /** Run all tasks in an evaluation suite */
  runAll(
    evaluation: SkillEvaluation,
    createLogger?: (task: EvalTask) => SessionLogger,
  ): Promise<TaskResult[]>;
}
