/**
 * Runner factory — creates the appropriate AgentRunner based on config.
 *
 * Non-Claude runners are dynamically imported so their SDKs
 * are only required when actually used.
 */

import type { AgentRunner, AgentRunnerOptions } from './agent-runner.js';
import { ClaudeSdkRunner } from './claude-sdk-runner.js';
import type { ClaudeSdkRunnerOptions } from './claude-sdk-runner.js';
import type { RunnerType } from '../config.js';

export async function createRunner(
  type: RunnerType,
  options: AgentRunnerOptions,
): Promise<AgentRunner> {
  switch (type) {
    case 'claude-sdk':
      return new ClaudeSdkRunner(options as ClaudeSdkRunnerOptions);

    case 'vercel-ai': {
      const { VercelAiRunner } = await import('./vercel-ai-runner.js').catch(() => {
        throw new Error(
          'Vercel AI SDK runner requires the "ai" and a provider package (e.g. "@ai-sdk/openai"). ' +
          'Install them with: npm install ai @ai-sdk/openai zod',
        );
      });
      return new VercelAiRunner(options);
    }

    case 'openai-agents': {
      const { OpenAiAgentsRunner } = await import('./openai-agents-runner.js').catch(() => {
        throw new Error(
          'OpenAI Agents SDK runner requires "@openai/agents". ' +
          'Install it with: npm install @openai/agents',
        );
      });
      return new OpenAiAgentsRunner(options);
    }

    default:
      throw new Error(`Unknown runner type: ${type}`);
  }
}
