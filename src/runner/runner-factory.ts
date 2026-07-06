/**
 * Runner factory — creates the appropriate AgentRunner based on config.
 */

import * as path from 'path';
import type { AgentRunner, AgentRunnerOptions } from './agent-runner.js';
import { ClaudeSdkRunner } from './claude-sdk-runner.js';
import { ClaudeCodeRunner } from './claude-code-runner.js';
import { CodexRunner } from './codex-runner.js';
import { GeminiRunner } from './gemini-runner.js';
import { OpenCodeRunner } from './opencode-runner.js';
import { DEFAULT_SKILLS_MOUNT_PATH } from '../run/workspace.js';
import type { RunnerType, EvalConfig } from '../config.js';

/**
 * Workspace-relative skills mount path per runner type, WITHOUT constructing
 * a runner (validate needs the mount path for its oracle-gate workspace but
 * not a live runner — and CLI-runner constructors print a security warning).
 * Must mirror each runner class's skillsMountPath; runner-factory tests
 * assert the two never diverge.
 */
export const RUNNER_SKILLS_MOUNT_PATHS: Record<RunnerType, string> = {
  'claude-sdk': DEFAULT_SKILLS_MOUNT_PATH,
  'claude-code': DEFAULT_SKILLS_MOUNT_PATH,
  codex: path.join('.agents', 'skills'),
  gemini: path.join('.gemini', 'skills'),
  opencode: path.join('.opencode', 'skills'),
};

/**
 * Create the appropriate AgentRunner based on runner type.
 *
 * @param type - Runner type ('claude-sdk' | 'claude-code' | 'codex' |
 *   'gemini' | 'opencode'). gemini is EXPERIMENTAL (built from documented
 *   output formats, not yet verified against a live CLI).
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

    case 'codex':
      return new CodexRunner(options, config);

    case 'gemini':
      return new GeminiRunner(options, config);

    case 'opencode':
      return new OpenCodeRunner(options, config);

    default:
      throw new Error(`Unknown runner type: ${type}`);
  }
}
