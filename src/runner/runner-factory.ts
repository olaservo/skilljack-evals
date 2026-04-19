/**
 * Runner factory — creates the appropriate AgentRunner based on config.
 *
 * Non-Claude runners are dynamically imported so their SDKs
 * are only required when actually used.
 */

import type { AgentRunner, AgentRunnerOptions } from './agent-runner.js';
import { ClaudeSdkRunner } from './claude-sdk-runner.js';
import type { RunnerType, EvalConfig } from '../config.js';

/**
 * Create the appropriate AgentRunner based on runner type.
 *
 * @param type - Runner type ('claude-sdk', 'vercel-ai', 'openai-agents', or 'copilot-sdk')
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

    case 'copilot-sdk': {
      const { CopilotSdkRunner } = await import('./copilot-sdk-runner.js').catch(() => {
        throw new Error(
          'Copilot SDK runner requires "@github/copilot-sdk". ' +
          'Install it with: npm install @github/copilot-sdk',
        );
      });
      return new CopilotSdkRunner(options, config);
    }

    case 'google-adk': {
      const { GoogleAdkRunner } = await import('./google-adk-runner.js');
      return new GoogleAdkRunner(options, config);
    }

    default:
      throw new Error(`Unknown runner type: ${type}`);
  }
}
