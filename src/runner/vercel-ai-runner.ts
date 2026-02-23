/**
 * Vercel AI SDK Runner
 *
 * Runs evaluation tasks using the Vercel AI SDK's native Agent Skills pattern.
 * Uses generateText() with a loadSkill tool, readFile tool, and bash tool —
 * following the cookbook guide at:
 * https://sdk.vercel.ai/docs/guides/agent-skills
 *
 * Supports any model provider via the Vercel AI SDK registry pattern:
 *   "openai:gpt-5.2", "anthropic:claude-sonnet-4-6", "google:gemini-2.0-flash"
 */

import type { EvalTask, ToolCallRecord, TaskResult } from '../types.js';
import { BaseRunner } from './base-runner.js';
import type { SessionLogger } from '../session/session-logger.js';

import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';

// ============================================
// Skill Discovery (per Agent Skills spec)
// ============================================

interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

/**
 * Discover skills in a directory by scanning for SKILL.md files
 * and parsing their YAML frontmatter.
 */
async function discoverSkills(skillsDir: string): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];

  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    try {
      const content = await fs.readFile(skillFile, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      if (frontmatter.name && frontmatter.description) {
        skills.push({
          name: frontmatter.name,
          description: frontmatter.description,
          path: path.resolve(skillDir),
        });
      }
    } catch {
      continue;
    }
  }

  return skills;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      result[key] = value;
    }
  }
  return result;
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

/**
 * Build the system prompt section listing available skills.
 */
function buildSkillsPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return '';

  const skillsList = skills
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n');

  return `## Skills

Use the \`loadSkill\` tool to load a skill when the user's request
would benefit from specialized instructions.

Available skills:
${skillsList}
`;
}

// ============================================
// Model Resolution
// ============================================

/**
 * Dynamically import a module, throwing a helpful error if missing.
 */
async function dynamicImport(pkg: string, installHint: string): Promise<any> {
  try {
    return await (Function('pkg', 'return import(pkg)')(pkg));
  } catch {
    throw new Error(`${pkg} is required. Install with: npm install ${installHint}`);
  }
}

/**
 * Resolve a model string like "openai:gpt-5.2" into a Vercel AI SDK
 * LanguageModel instance via dynamic provider import.
 */
async function resolveModel(modelString: string): Promise<any> {
  // Parse "provider:model" format
  const colonIdx = modelString.indexOf(':');
  if (colonIdx === -1) {
    // Default to OpenAI if no provider prefix
    const { createOpenAI } = await dynamicImport('@ai-sdk/openai', '@ai-sdk/openai');
    const openai = createOpenAI();
    return openai(modelString);
  }

  const provider = modelString.slice(0, colonIdx);
  const model = modelString.slice(colonIdx + 1);

  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await dynamicImport('@ai-sdk/openai', '@ai-sdk/openai');
      const openai = createOpenAI();
      return openai(model);
    }
    case 'anthropic': {
      const { createAnthropic } = await dynamicImport('@ai-sdk/anthropic', '@ai-sdk/anthropic');
      const anthropic = createAnthropic();
      return anthropic(model);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await dynamicImport('@ai-sdk/google', '@ai-sdk/google');
      const google = createGoogleGenerativeAI();
      return google(model);
    }
    default:
      throw new Error(
        `Unknown provider "${provider}". Supported: openai, anthropic, google. ` +
        `Use format "provider:model" (e.g. "openai:gpt-5.2").`,
      );
  }
}

// ============================================
// Runner
// ============================================

export class VercelAiRunner extends BaseRunner {
  readonly providerName = 'vercel-ai';

  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const { generateText, tool: defineTool } = await dynamicImport('ai', 'ai');
    const { z } = await dynamicImport('zod', 'zod');

    const skillLoads: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const startTime = Date.now();

    try {
      // 1. Discover skills
      const skills = this.options.skillsDir
        ? await discoverSkills(this.options.skillsDir)
        : [];

      // 2. Build system prompt with skill metadata
      const skillsPrompt = buildSkillsPrompt(skills);
      const systemPrompt = skillsPrompt
        ? `You are a helpful AI assistant.\n\n${skillsPrompt}`
        : 'You are a helpful AI assistant.';

      // 3. Resolve model
      const model = await resolveModel(this.options.model ?? 'openai:gpt-5.2');

      const cwd = this.options.cwd ?? process.cwd();

      // 4. Define tools (per Vercel AI SDK cookbook pattern)
      const tools = {
        loadSkill: defineTool({
          description: 'Load a skill to get specialized instructions',
          parameters: z.object({
            name: z.string().describe('The skill name to load'),
          }),
          execute: async ({ name }: { name: string }) => {
            const skill = skills.find(
              s => s.name.toLowerCase() === name.toLowerCase(),
            );
            if (!skill) {
              return { error: `Skill '${name}' not found` };
            }
            const content = await fs.readFile(
              path.join(skill.path, 'SKILL.md'),
              'utf-8',
            );
            const body = stripFrontmatter(content);
            skillLoads.push(skill.name);
            return { skillDirectory: skill.path, content: body };
          },
        }),
        readFile: defineTool({
          description: 'Read the contents of a file',
          parameters: z.object({
            file_path: z.string().describe('Absolute or relative path to the file'),
          }),
          execute: async ({ file_path }: { file_path: string }) => {
            const resolved = path.isAbsolute(file_path)
              ? file_path
              : path.join(cwd, file_path);
            try {
              return await fs.readFile(resolved, 'utf-8');
            } catch (err) {
              return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        }),
        writeFile: defineTool({
          description: 'Write content to a file',
          parameters: z.object({
            file_path: z.string().describe('Absolute or relative path to the file'),
            content: z.string().describe('Content to write'),
          }),
          execute: async ({ file_path, content }: { file_path: string; content: string }) => {
            const resolved = path.isAbsolute(file_path)
              ? file_path
              : path.join(cwd, file_path);
            try {
              await fs.mkdir(path.dirname(resolved), { recursive: true });
              await fs.writeFile(resolved, content);
              return `File written: ${resolved}`;
            } catch (err) {
              return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        }),
        bash: defineTool({
          description: 'Execute a bash command',
          parameters: z.object({
            command: z.string().describe('The command to execute'),
          }),
          execute: async ({ command }: { command: string }) => {
            try {
              const output = execSync(command, {
                cwd,
                encoding: 'utf-8',
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              return output;
            } catch (err: unknown) {
              const execErr = err as { stderr?: string; message?: string };
              return `Error: ${execErr.stderr || execErr.message || String(err)}`;
            }
          },
        }),
      };

      // 5. Run agent
      let stepCount = 0;

      const result = await generateText({
        model,
        system: systemPrompt,
        prompt: task.prompt,
        tools,
        maxSteps: 20,
        onStepFinish: (event: { toolCalls?: Array<{ toolName: string; args: unknown; toolCallId: string }> }) => {
          stepCount++;
          if (event.toolCalls) {
            for (const tc of event.toolCalls) {
              toolCalls.push({
                tool: tc.toolName,
                toolUseId: tc.toolCallId,
                timestamp: Date.now(),
                input: tc.args,
              });
              logger?.addToolUse(tc.toolName, tc.args);

              // Detect skill loads from readFile calls to SKILL.md
              if (tc.toolName === 'readFile') {
                const filePath = (tc.args as { file_path?: string })?.file_path ?? '';
                if (filePath.includes('SKILL.md') || filePath.includes('/skills/')) {
                  const match = filePath.match(/skills\/([^/]+)/);
                  if (match && !skillLoads.includes(match[1])) {
                    skillLoads.push(match[1]);
                  }
                }
              }
            }
          }
        },
      });

      const output = result.text ?? '';
      logger?.addTextMessage(output);

      // Extract usage info
      const usage = result.usage ?? { promptTokens: 0, completionTokens: 0 };
      const totalTokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
      // Rough cost estimate (varies by model)
      const costUsd = totalTokens * 0.000003;

      return {
        taskId: task.id,
        prompt: task.prompt,
        output,
        durationMs: Date.now() - startTime,
        numTurns: stepCount,
        costUsd,
        skillLoads: [...new Set(skillLoads)],
        toolCalls,
        isError: false,
        errorMessage: '',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.markAsError(errorMessage);

      return {
        taskId: task.id,
        prompt: task.prompt,
        output: '',
        durationMs: Date.now() - startTime,
        numTurns: 0,
        costUsd: 0,
        skillLoads: [],
        toolCalls: [],
        isError: true,
        errorMessage,
      };
    }
  }
}
