/**
 * Agent Runner interface and shared options.
 *
 * All runner implementations (Claude SDK, Vercel AI SDK, OpenAI Agents SDK, Copilot SDK)
 * implement this interface to produce TaskResult objects consumed by the scorer.
 */

import type {
  EvalTask,
  TaskResult,
} from '../types.js';
import type { SessionLogger } from '../session/session-logger.js';

/**
 * Options shared by all runner implementations.
 */
export interface AgentRunnerOptions {
  /** Working directory for agent execution */
  cwd?: string;
  /** Model identifier (format depends on runner) */
  model?: string;
  /** Per-task timeout in ms */
  taskTimeoutMs?: number;
  /**
   * Directories the agent is allowed to write to.
   * NOTE: Only enforced for structured file-write tools (writeFile, Write/Edit).
   * Bash/shell tools can bypass these restrictions.
   */
  allowedWriteDirs?: string[];
  /** Path to skills directory (for non-Claude runners that handle discovery natively) */
  skillsDir?: string;
  /**
   * Count indirect reads of SKILL.md (via Read/readFile tools) as skill
   * discovery. When false (default), only explicit loadSkill/Skill tool
   * calls are counted. Set true for models that bypass the loadSkill tool.
   * Note: Does not apply to the OpenAI Agents runner, which uses shell-based
   * skill detection as its native mechanism.
   */
  countReadAsFallback?: boolean;
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
  /** Human-readable provider name (e.g., 'claude-sdk') */
  readonly providerName: string;

  /**
   * Workspace-relative directory where this harness discovers Agent Skills
   * (e.g. '.claude/skills' for Claude runners, '.agents/skills' for Codex).
   * The pipeline mounts each task's skills here when creating trial workspaces.
   */
  readonly skillsMountPath: string;

  /** Run a single task and produce a TaskResult */
  runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult>;

  /** Run a task with timeout protection */
  runTaskWithTimeout(
    task: EvalTask,
    timeoutMs?: number,
    logger?: SessionLogger,
  ): Promise<TaskResult>;

  /** Release runner resources (e.g., child processes). Called after all tasks complete. */
  dispose?(): Promise<void>;
}
