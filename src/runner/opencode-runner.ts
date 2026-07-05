/**
 * OpenCode CLI Runner.
 *
 * Contract verified two ways against opencode v1.17.13: source-read of the
 * vendored repo (packages/opencode/src/cli/cmd/run.ts + packages/schema
 * session.ts + skill/tool/config modules) AND a live capture on 2026-07-05
 * (see src/__tests__/fixtures/transcripts/README.md; unit tests replay the
 * captured transcript fixtures/transcripts/opencode/greeting-with-skill.jsonl).
 *
 * Verified contract (opencode v1.17.13):
 * - Non-interactive: `opencode run --format json --auto "<prompt>"` emits a
 *   JSONL stream on stdout. Each event is `{type, timestamp, sessionID,
 *   ...data}` where data nests the message part under `part` (types
 *   step_start, step_finish, text, tool_use, reasoning) or, for `error`
 *   events, under `error`. `text` fires only when the part completes;
 *   `tool_use` fires only on state.status completed|error. `--auto` is
 *   REQUIRED: without it every permission ask (including the `skill` tool's
 *   own ask) is auto-REJECTED while the run still exits 0.
 * - Skills: native SKILL.md support; config-dir discovery matches
 *   `{skill,skills}/**\/SKILL.md`, so our `.opencode/skills/<name>/SKILL.md`
 *   mount is found via the project `.opencode` dir walk-up. Frontmatter
 *   `name:` is required; a missing `description:` keeps the skill out of the
 *   <available_skills> prompt list. A built-in `customize-opencode` skill is
 *   ALWAYS registered — filtered out of skillLoads so baselines stay clean.
 * - Invocation surface: the native `skill` tool (`skill({name})`,
 *   part.tool === "skill") → primary. Read-style tools touching a SKILL.md
 *   path are the fallback surface (always counted).
 * - step_finish parts carry `{reason, cost, tokens: {input, output,
 *   reasoning, cache: {read, write}}}` per step; we sum across steps.
 * - Model: `-m` takes `provider/model` (e.g. anthropic/claude-haiku-4-5);
 *   there are no aliases, so the framework-default alias is never forwarded.
 * - Install: npm install -g opencode-ai; version via `opencode --version`.
 *
 * Isolation (buildEnv): opencode has NO --ignore-user-config equivalent —
 * by default it reads ~/.config/opencode (config + skills), ~/.opencode,
 * ~/.claude/skills and ~/.agents/skills, and walks UP from cwd to the git
 * worktree root (which reaches this repo's own .claude/ when workspaces live
 * under <output>/workspaces). We isolate per trial with env vars: XDG_* dirs
 * redirected under the workspace (global config/data/cache/state),
 * OPENCODE_TEST_HOME (redirects the ~/.opencode and ~/.claude|~/.agents
 * home-dir scans), OPENCODE_DISABLE_EXTERNAL_SKILLS=1 (kills .claude/.agents
 * scans at home AND project level), and OPENCODE_PURE=1 (no external
 * plugins). OPENCODE_DISABLE_PROJECT_CONFIG is deliberately NOT set — it
 * would also disable discovery of the workspace's own .opencode skill mount.
 * PWD is pinned to the workspace because opencode (Bun) trusts env.PWD over
 * the real spawn cwd — a stale PWD from the launching shell re-anchors the
 * whole session (and skill discovery) to that directory. Auth survives
 * isolation via provider env keys (e.g. ANTHROPIC_API_KEY), which
 * auto-enable the matching provider.
 */

import * as path from 'path';
import type {
  EvalTask,
  ToolCallRecord,
} from '../types.js';
import { buildTokenUsage } from './base-runner.js';
import { CliRunner, skillNameFromToolInput } from './cli-runner.js';
import type { CliTaskResultFields } from './cli-runner.js';
import type { CliJsonlResult } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';

export const OPENCODE_CLI_INSTALL_HINT =
  'OpenCode CLI not found on PATH. Install: npm install -g opencode-ai';

/**
 * Extract a human-readable message from an opencode error payload: a plain
 * string, `{data: {message}}` (NamedError serialization), `{message}`, or
 * `{name}` — else a JSON dump so nothing degrades to "[object Object]".
 */
function extractErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error || undefined;
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const message = data?.message ?? record.message ?? record.name;
  if (typeof message === 'string' && message) return message;
  try {
    return JSON.stringify(error);
  } catch {
    return undefined;
  }
}

interface OpenCodeFoldState {
  /** Assistant text events, joined at finalize. */
  texts: string[];
  numTurns: number;
  costUsd: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  /** Raw token counters summed across step_finish events. */
  tokenTotals?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** True when at least one step_finish (or text) event was seen. */
  sawCompletion: boolean;
  errorMessage?: string;
}

export class OpenCodeRunner extends CliRunner<OpenCodeFoldState> {
  get providerName(): string {
    return 'opencode';
  }

  protected readonly command = 'opencode';
  protected readonly installHint = OPENCODE_CLI_INSTALL_HINT;

  /** OpenCode's native project-level skills dir (source: `{skill,skills}/`). */
  override readonly skillsMountPath = path.join('.opencode', 'skills');

  /**
   * Per-trial isolation env (see the header's Isolation section). All dirs
   * live under the workspace so retention/cleanup follows the workspace
   * policy; opencode creates them on demand.
   */
  protected override buildEnv(_task: EvalTask, workspaceDir: string): NodeJS.ProcessEnv {
    const xdgRoot = path.join(workspaceDir, '.opencode-xdg');
    return {
      ...process.env,
      // opencode (Bun) trusts env.PWD over the real spawn cwd. A stale PWD
      // inherited from the launching shell (e.g. Git Bash at the repo root)
      // silently re-anchors opencode there, hiding the workspace's
      // .opencode/skills mount. Found live; must match the spawn cwd.
      PWD: workspaceDir,
      XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
      XDG_DATA_HOME: path.join(xdgRoot, 'data'),
      XDG_CACHE_HOME: path.join(xdgRoot, 'cache'),
      XDG_STATE_HOME: path.join(xdgRoot, 'state'),
      OPENCODE_TEST_HOME: path.join(xdgRoot, 'home'),
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_PURE: '1',
    };
  }

  protected buildArgs(task: EvalTask): string[] {
    const args = [
      'run',
      '--format', 'json',
      // Auto-approve permissions not explicitly denied; without this,
      // non-interactive permission requests are rejected.
      '--auto',
    ];

    // Skip -m for the framework default ('sonnet', a Claude alias without
    // OpenCode's required provider/model form): use the user's default model.
    const model = this.options.model;
    if (model && model !== DEFAULT_CONFIG.defaultAgentModel) {
      args.push('--model', model);
    }

    args.push(task.prompt);

    return args;
  }

  protected createInitialState(): OpenCodeFoldState {
    return {
      texts: [],
      numTurns: 0,
      costUsd: 0,
      skillLoads: [],
      toolCalls: [],
      sawCompletion: false,
    };
  }

  /**
   * Best-effort fold of one OpenCode --format json event. Events are the
   * message parts spread into `{type, timestamp, sessionID, ...part}`; a
   * nested `part` object is also tolerated.
   */
  protected handleEvent(event: unknown, state: OpenCodeFoldState, logger?: SessionLogger): void {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;
    const part = (record.part as Record<string, unknown> | undefined) ?? record;

    switch (record.type) {
      case 'text': {
        const text = (part.text as string) ?? (record.text as string);
        if (typeof text === 'string' && text) {
          state.texts.push(text);
          logger?.addTextMessage(text);
        }
        state.sawCompletion = true;
        break;
      }

      case 'tool_use': {
        const toolName = (part.tool as string) ?? (record.tool as string) ?? 'unknown';
        const toolState = part.state as Record<string, unknown> | undefined;
        const input = toolState?.input ?? part.input;
        state.toolCalls.push({
          tool: toolName,
          toolUseId: (part.callID as string) ?? '',
          timestamp: Date.now(),
          input,
        });
        logger?.addToolUse(toolName, input);

        // Primary surface: the native `skill` tool. The built-in
        // `customize-opencode` skill ships with the CLI and is always
        // registered, so loading it must not count as a skill invocation.
        if (toolName === 'skill') {
          const skillName = (input as Record<string, unknown> | undefined)?.name;
          if (typeof skillName === 'string' && skillName && skillName !== 'customize-opencode') {
            state.skillLoads.push(skillName);
          }
        } else {
          // Fallback surface: read-style tool touching a SKILL.md path.
          const skillName = skillNameFromToolInput(input);
          if (skillName) state.skillLoads.push(skillName);
        }
        break;
      }

      case 'step_finish': {
        state.sawCompletion = true;
        state.numTurns++;
        const cost = (part.cost as number) ?? (record.cost as number);
        if (typeof cost === 'number') state.costUsd += cost;

        const tokens = (part.tokens ?? record.tokens) as {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        } | undefined;
        if (tokens) {
          state.tokenTotals ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          state.tokenTotals.input += tokens.input ?? 0;
          state.tokenTotals.output += tokens.output ?? 0;
          state.tokenTotals.cacheRead += tokens.cache?.read ?? 0;
          state.tokenTotals.cacheCreation += tokens.cache?.write ?? 0;
        }
        break;
      }

      case 'error': {
        // Real shape: {type: "error", error: <session error object>} — the
        // payload nests under `error`, not `part`. Tolerate strings and the
        // various NamedError serializations ({data: {message}}, {message}).
        state.errorMessage = extractErrorMessage(record.error ?? part) ?? 'unknown error event';
        break;
      }
    }
  }

  protected detectFailure(cli: CliJsonlResult, state: OpenCodeFoldState): string | null {
    if (state.errorMessage) return `reported an error: ${state.errorMessage}`;
    if (cli.exitCode !== 0) return `exited with code ${cli.exitCode}`;
    if (!state.sawCompletion) return 'exited without completing a step';
    return null;
  }

  protected finalize(state: OpenCodeFoldState, cli: CliJsonlResult): CliTaskResultFields {
    return {
      output: state.texts.join('\n\n'),
      durationMs: cli.durationMs,
      numTurns: state.numTurns,
      costUsd: state.costUsd,
      skillLoads: state.skillLoads,
      toolCalls: state.toolCalls,
      tokens: buildTokenUsage(state.tokenTotals),
    };
  }
}
