/**
 * Runner factory — creates the appropriate AgentRunner based on config.
 *
 * Non-Claude runners are dynamically imported so their SDKs
 * are only required when actually used.
 */

import type { AgentRunner, AgentRunnerOptions } from './agent-runner.js';
import { ClaudeSdkRunner } from './claude-sdk-runner.js';
import type { ClaudeSdkRunnerOptions } from './claude-sdk-runner.js';
import type { RunnerType, EvalConfig } from '../config.js';

/**
 * Create the appropriate AgentRunner based on runner type.
 *
 * @param type - Runner type ('claude-sdk', 'vercel-ai', or 'openai-agents')
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
      return new ClaudeSdkRunner(options as ClaudeSdkRunnerOptions, config);

    case 'vercel-ai': {
      const { VercelAiRunner } = await import('./vercel-ai-runner.js').catch(() => {
        throw new Error(
          'Vercel AI SDK runner requires the "ai" and a provider package (e.g. "@ai-sdk/openai"). ' +
          'Install them with: npm install ai @ai-sdk/openai zod',
        );
      });
      return new VercelAiRunner(options, config);
    }

    case 'openai-agents': {
      const { OpenAiAgentsRunner } = await import('./openai-agents-runner.js').catch(() => {
        throw new Error(
          'OpenAI Agents SDK runner requires "@openai/agents". ' +
          'Install it with: npm install @openai/agents',
        );
      });
      return new OpenAiAgentsRunner(options, config);
    }

    default:
      throw new Error(`Unknown runner type: ${type}`);
  }
}
