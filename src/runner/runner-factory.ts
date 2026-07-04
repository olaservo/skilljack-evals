/**
 * Runner factory — creates the appropriate AgentRunner based on config.
 */

import type { AgentRunner, AgentRunnerOptions } from './agent-runner.js';
import { ClaudeSdkRunner } from './claude-sdk-runner.js';
import { ClaudeCodeRunner } from './claude-code-runner.js';
import type { RunnerType, EvalConfig } from '../config.js';

/**
 * Create the appropriate AgentRunner based on runner type.
 *
 * @param type - Runner type ('claude-sdk' | 'claude-code')
 * @param options - Runner options (cwd, model, timeout, etc.)
 * @param config - Optional pre-loaded EvalConfig. Passed through to BaseRunner
 *   so YAML file config values are respected. When omitted, BaseRunner falls
 *   back to loadConfigSync() (env vars + defaults only).
 */
export async function createRunner(
  type: RunnerType,
  options: AgentRunnerOptions,
  config?: EvalConfig,
): Promise<AgentRunner> {
  switch (type) {
    case 'claude-sdk':
      return new ClaudeSdkRunner(options, config);

    case 'claude-code':
      return new ClaudeCodeRunner(options, config);

    default:
      throw new Error(`Unknown runner type: ${type}`);
  }
}
