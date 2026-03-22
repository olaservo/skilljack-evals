/**
 * GitHub Copilot SDK Runner
 *
 * Runs evaluation tasks using the GitHub Copilot SDK's agentic engine.
 * Communicates with the Copilot CLI via JSON-RPC (stdio transport).
 *
 * Supports GitHub token auth or BYOK (Bring Your Own Key) with
 * OpenAI, Anthropic, or Azure providers.
 *
 * @see https://github.com/github/copilot-sdk
 */

import type { EvalTask, ToolCallRecord, TaskResult } from '../types.js';
import { BaseRunner } from './base-runner.js';
import type { AgentRunnerOptions } from './agent-runner.js';
import type { EvalConfig } from '../config.js';
import type { SessionLogger } from '../session/session-logger.js';
import { isWriteAllowed } from './security.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * BYOK provider config for using your own API key.
 */
export interface CopilotProviderConfig {
  type?: 'openai' | 'azure' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
}

/**
 * Copilot SDK-specific options (extends shared options).
 */
export interface CopilotSdkRunnerOptions extends AgentRunnerOptions {
  /** GitHub token for Copilot authentication. */
  githubToken?: string;
  /**
   * BYOK provider config. When set, uses your own API key instead of GitHub auth.
   * @example { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...' }
   */
  provider?: CopilotProviderConfig;
}

export class CopilotSdkRunner extends BaseRunner {
  readonly providerName = 'copilot-sdk';
  private sdkOptions: CopilotSdkRunnerOptions;
  private client: any = null;
  private configDir: string | null = null;

  constructor(options: CopilotSdkRunnerOptions = {}, config?: EvalConfig) {
    super(options, config);
    this.sdkOptions = {
      ...this.options,
      githubToken: options.githubToken,
      provider: options.provider,
    };
  }

  /** Check for Copilot token at call time to avoid stale reads. */
  private get hasCopilotToken(): boolean {
    return !!(this.sdkOptions.githubToken ?? process.env.COPILOT_GITHUB_TOKEN);
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

  /**
   * Get or create a lazy CopilotClient singleton.
   * Reused across tasks to avoid per-task server startup overhead.
   */
  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    const sdk = await this.dynamicImport(
      '@github/copilot-sdk',
      '@github/copilot-sdk',
    );

    // Isolated config directory prevents user-level commands/skills from
    // interfering with evaluation. Override all platform-specific paths
    // (XDG on Linux/macOS, APPDATA/HOME/USERPROFILE on Windows).
    this.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilljack-copilot-'));
    const configDir = this.configDir;
    const isolatedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v) isolatedEnv[k] = v;
    }
    isolatedEnv.XDG_CONFIG_HOME = configDir;
    isolatedEnv.XDG_STATE_HOME = configDir;
    isolatedEnv.APPDATA = configDir;
    isolatedEnv.LOCALAPPDATA = configDir;
    isolatedEnv.HOME = configDir;
    isolatedEnv.USERPROFILE = configDir;

    const clientOptions: Record<string, any> = {
      cwd: this.options.cwd,
      env: isolatedEnv,
    };

    // Auth: explicit Copilot token > env vars > logged-in user.
    // Skip the generic GITHUB_TOKEN — it typically lacks Copilot permissions
    // (e.g., the auto-generated token in GitHub Actions).
    const token = this.sdkOptions.githubToken
      ?? process.env.COPILOT_GITHUB_TOKEN;

    if (token) {
      clientOptions.githubToken = token;
    } else if (!this.sdkOptions.provider) {
      // Only use logged-in user when no BYOK API keys are in the environment.
      // BYOK auto-detection in runTask() sets a session-level provider that
      // takes precedence over client auth, but avoiding conflicting configs
      // is cleaner than relying on that override behavior.
      const hasApiKeys = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
      if (!hasApiKeys) {
        clientOptions.useLoggedInUser = true;
      }
    }

    try {
      this.client = new sdk.CopilotClient(clientOptions);
      await this.client.start();
    } catch (err) {
      // Clean up temp dir if client creation fails to prevent orphaned directories
      try {
        fs.rmSync(this.configDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
      this.configDir = null;
      throw err;
    }
    return this.client;
  }

  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const skillLoads: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const textChunks: string[] = [];
    let numTurns = 0;
    const startTime = Date.now();

    try {
      const client = await this.getClient();

      const cwd = this.options.cwd ?? process.cwd();
      const allowedWriteDirs = this.options.allowedWriteDirs ?? [];

      // Build session config
      const sessionConfig: Record<string, any> = {
        model: this.options.model ?? 'gpt-5',
        workingDirectory: cwd,

        // Permission handler: approve reads/shell, restrict writes
        onPermissionRequest: (request: any) => {
          if (request.kind === 'write') {
            const filePath = request.path ?? request.filePath ?? '';
            if (filePath && !isWriteAllowed(filePath, allowedWriteDirs, cwd)) {
              return { kind: 'denied' };
            }
          }
          return { kind: 'approved' };
        },

        // Hooks for tool call tracking + skill detection
        hooks: {
          onPostToolUse: (input: any) => {
            const toolName = input.toolName ?? '';
            const toolArgs = input.toolArgs ?? {};

            toolCalls.push({
              tool: toolName,
              toolUseId: `copilot-${toolCalls.length}`,
              timestamp: Date.now(),
              input: toolArgs,
            });
            logger?.addToolUse(toolName, toolArgs);

            // Detect skill loads from tool calls that access SKILL.md.
            // Check both tool args (view/read path) and tool result text
            // (grep/glob results that reference skill files).
            {
              const filePath: string = toolArgs.path ?? toolArgs.file_path ?? '';
              const resultText: string = input.toolResult?.textResultForLlm ?? '';
              const combined = filePath + '\n' + resultText;
              const normalized = combined.replace(/\\/g, '/');

              // Match all occurrences of skills/<name> in args or results
              const skillPattern = /[/.]claude\/skills\/([^/\s]+)/g;
              let m;
              while ((m = skillPattern.exec(normalized)) !== null) {
                if (!skillLoads.includes(m[1])) {
                  skillLoads.push(m[1]);
                }
              }
              // Also match standalone skills/<name>/SKILL.md paths that lack
              // the .claude/ prefix (e.g., the skillsDir path passed directly).
              // Require a word boundary or path separator before "skills/" to
              // avoid matching unrelated directories like "other-skills/".
              const skillMdPattern = /(?:^|[\s/])skills\/([^/\s]+)\/SKILL\.md/g;
              while ((m = skillMdPattern.exec(normalized)) !== null) {
                if (!skillLoads.includes(m[1])) {
                  skillLoads.push(m[1]);
                }
              }
            }
          },
        },

        // Event handler for tracking assistant messages + skill invocations.
        // Primary skill detection: skill.invoked events (fires when CLI
        // natively loads skills via skillDirectories — currently broken in
        // @github/copilot v1.0.10, see github/copilot-sdk#629).
        // Fallback: file-browsing detection in onPostToolUse above.
        onEvent: (event: any) => {
          if (event.type === 'assistant.message') {
            const content = event.data?.content ?? '';
            textChunks.push(content);
            numTurns++;
            logger?.addAssistantMessage([{ type: 'text', text: content }]);
          } else if (event.type === 'skill.invoked') {
            const skillName = event.data?.name;
            if (skillName && !skillLoads.includes(skillName)) {
              skillLoads.push(skillName);
            }
          }
        },
      };

      // Skill directories for native skill loading (must be absolute).
      // When the SDK bug (github/copilot-sdk#629) is fixed, this will
      // inject skills into the session context and fire skill.invoked events.
      if (this.options.skillsDir) {
        const absSkillsDir = path.isAbsolute(this.options.skillsDir)
          ? this.options.skillsDir
          : path.resolve(cwd, this.options.skillsDir);
        sessionConfig.skillDirectories = [absSkillsDir];
      }

      // BYOK provider config: explicit > auto-detect from model + API keys.
      // Auto-detect enables CI usage without a Copilot-enabled token.
      if (this.sdkOptions.provider) {
        sessionConfig.provider = this.sdkOptions.provider;
      } else if (!this.hasCopilotToken) {
        const model = sessionConfig.model ?? '';
        const isAnthropicModel = model.startsWith('claude');
        const openaiKey = process.env.OPENAI_API_KEY;
        const anthropicKey = process.env.ANTHROPIC_API_KEY;

        // Prefer the provider matching the model, fall back to whatever key is available
        const preferredKey = isAnthropicModel ? anthropicKey : openaiKey;
        const fallbackKey = isAnthropicModel ? openaiKey : anthropicKey;
        const apiKey = preferredKey ?? fallbackKey;

        if (apiKey) {
          const useAnthropic = apiKey === anthropicKey;
          sessionConfig.provider = {
            type: useAnthropic ? 'anthropic' : 'openai',
            baseUrl: useAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
            apiKey,
          };
        }
      }

      const session = await client.createSession(sessionConfig);

      try {
        // Send task and wait for completion
        const timeout = this.options.taskTimeoutMs ?? 300000;
        const response = await session.sendAndWait(
          { prompt: task.prompt },
          timeout,
        );

        const output = response?.data?.content ?? textChunks.join('\n');
        if (output && textChunks.length === 0) {
          logger?.addTextMessage(output);
        }

        return {
          taskId: task.id,
          prompt: task.prompt,
          output,
          durationMs: Date.now() - startTime,
          numTurns,
          costUsd: 0, // Copilot SDK doesn't expose per-token cost
          skillLoads: [...new Set(skillLoads)],
          toolCalls,
          isError: false,
          errorMessage: '',
        };
      } finally {
        await session.disconnect();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.markAsError(errorMessage);
      return this.createErrorResult(task, errorMessage, Date.now() - startTime);
    }
  }

  /**
   * Stop the shared client and clean up temp config directory.
   * Called after runAll() completes.
   */
  async dispose(): Promise<void> {
    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        // Ignore shutdown errors
      }
      this.client = null;
    }
    if (this.configDir) {
      try {
        fs.rmSync(this.configDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      this.configDir = null;
    }
  }
}
