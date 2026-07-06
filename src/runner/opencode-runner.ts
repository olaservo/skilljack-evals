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
 *   reasoning, cache: {read, write}}}` per step; we sum across steps
 *   (reasoning folds into output — codex-consistent) and count a turn only
 *   for non-`tool-calls` reasons (one step_finish per LLM API step).
 * - Model: `-m` takes `provider/model` (e.g. anthropic/claude-haiku-4-5);
 *   there are no aliases, so the framework-default alias is never forwarded.
 * - Install: npm install -g opencode-ai; version via `opencode --version`.
 *
 * Isolation (buildEnv): opencode has NO --ignore-user-config equivalent —
 * by default it reads ~/.config/opencode (config + skills), ~/.opencode,
 * ~/.claude/skills and ~/.agents/skills, and walks UP from cwd to the git
 * worktree root (which reaches this repo's own .claude/ when workspaces live
 * under <output>/workspaces). We isolate per trial with env vars: XDG_* dirs
 * redirected to a per-trial OS temp dir created in runTask and deleted after
 * the trial (NOT inside the workspace — verifiers enumerate the workspace,
 * docker bind-mounts it, and retention would persist opencode's db/logs),
 * OPENCODE_TEST_HOME (redirects the ~/.opencode and ~/.claude|~/.agents
 * home-dir scans), OPENCODE_DISABLE_EXTERNAL_SKILLS=1 (kills .claude/.agents
 * scans at home AND project level), and OPENCODE_PURE=1 (no external
 * plugins). OPENCODE_DISABLE_PROJECT_CONFIG is deliberately NOT set — it
 * would also disable discovery of the workspace's own .opencode skill mount.
 * PWD is pinned to the spawn cwd by CliRunner for all CLI runners because
 * opencode (Bun) trusts env.PWD over the real cwd — a stale PWD from the
 * launching shell re-anchors the whole session (and skill discovery).
 * Auth: provider env keys (e.g. ANTHROPIC_API_KEY) auto-enable the matching
 * provider; for `opencode auth login` (OAuth) users the real auth.json would
 * be hidden by the XDG_DATA_HOME redirect, so buildEnv forwards it via
 * OPENCODE_AUTH_CONTENT — re-read per trial, scoped to the requested
 * provider when -m is set, and rotated tokens are merged back into the real
 * auth.json after each trial (afterCliRun) so rotating OAuth providers keep
 * working across trials and the user's real login survives.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  EvalTask,
  ToolCallRecord,
} from '../types.js';
import { BUILTIN_AGENT_SKILLS } from '../types.js';
import { buildTokenUsage, extractErrorMessage } from './base-runner.js';
import { CliRunner, skillNameFromToolInput } from './cli-runner.js';
import type { CliTaskResultFields } from './cli-runner.js';
import type { CliJsonlResult } from '../harness/subprocess.js';
import type { SessionLogger } from '../session/session-logger.js';
import { DEFAULT_CONFIG } from '../config.js';

export const OPENCODE_CLI_INSTALL_HINT =
  'OpenCode CLI not found on PATH. Install: npm install -g opencode-ai';

/**
 * Files opencode's config bootstrap deposits into the workspace's .opencode/
 * dir every run (ensureGitignore + a background npm install of
 * @opencode-ai/plugin). Pruned after each trial so verifiers, docker mounts,
 * and workspace retention only see task state, never harness/CLI droppings.
 */
const OPENCODE_WORKSPACE_DROPPINGS = [
  'node_modules',
  'package.json',
  'package-lock.json',
  'bun.lock',
  '.gitignore',
];

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
   * CliRunner owns the per-invocation scratch dir (creation, buildEnv/
   * afterCliRun plumbing, removal with retries) — kept OUTSIDE the workspace
   * so verifiers, docker mounts, retention, and files_exist checks never see
   * opencode's internal db/logs/snapshots, and nothing lands in a user's
   * real project when task.workspaceDir is unset (direct API use).
   */
  protected override readonly needsScratchDir = true;

  /** The real opencode data dir (where `opencode auth login` stores auth.json). */
  private realDataDir(): string {
    // XDG spec (and opencode's xdg-basedir): empty XDG_DATA_HOME means unset.
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'opencode');
  }

  /**
   * The user's real opencode auth.json (OAuth logins: Claude subscription,
   * Copilot, ...), forwarded via OPENCODE_AUTH_CONTENT because the
   * XDG_DATA_HOME redirect hides the file itself. Read fresh per trial —
   * memoizing would replay tokens that a previous trial already rotated
   * (afterCliRun writes rotations back), and would turn a transient read
   * error into a whole-suite auth outage. When the trial pins a
   * provider/model, only that provider's entry is forwarded, keeping other
   * providers' refresh tokens out of the (fully auto-approved) agent's env.
   */
  private trialAuthContent(): string | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.realDataDir(), 'auth.json'), 'utf8');
    } catch {
      return undefined;
    }
    const model = this.options.model;
    const provider = model && model.includes('/') ? model.split('/')[0] : undefined;
    if (!provider) return raw;
    try {
      const all = JSON.parse(raw) as Record<string, unknown>;
      const entry = all[provider];
      return entry === undefined ? undefined : JSON.stringify({ [provider]: entry });
    } catch {
      return raw;
    }
  }

  /** Per-trial isolation env (see the header's Isolation section). */
  protected override buildEnv(_task: EvalTask, _workspaceDir: string, scratchDir?: string): NodeJS.ProcessEnv {
    if (!scratchDir) {
      throw new Error('opencode runner requires a per-trial scratch dir (needsScratchDir)');
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(scratchDir, 'config'),
      XDG_DATA_HOME: path.join(scratchDir, 'data'),
      XDG_CACHE_HOME: path.join(scratchDir, 'cache'),
      XDG_STATE_HOME: path.join(scratchDir, 'state'),
      OPENCODE_TEST_HOME: path.join(scratchDir, 'home'),
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_PURE: '1',
    };
    // `=== undefined` so an explicitly-empty value stays an opt-out.
    if (env.OPENCODE_AUTH_CONTENT === undefined) {
      const auth = this.trialAuthContent();
      if (auth) env.OPENCODE_AUTH_CONTENT = auth;
    }
    return env;
  }

  /**
   * Post-trial, pre-scratch-removal housekeeping (best-effort):
   * 1. Prune opencode's config-bootstrap droppings from the workspace
   *    .opencode/ dir (skills mount is untouched) so verifiers/retention see
   *    only task state. Only for pipeline-managed throwaway workspaces —
   *    never a user's own cwd, where .opencode may hold their real files.
   * 2. Persist rotated OAuth tokens: opencode writes refreshed tokens to the
   *    trial's redirected data dir, which is about to be deleted. Merging
   *    them back into the real auth.json keeps rotating providers working
   *    across trials (and preserves the user's real login). Skipped when the
   *    auth came from a caller-provided OPENCODE_AUTH_CONTENT.
   */
  protected override async afterCliRun(task: EvalTask, _workspaceDir: string, scratchDir?: string): Promise<void> {
    if (task.workspaceDir) {
      const dotOpencode = path.join(task.workspaceDir, '.opencode');
      await Promise.all(
        OPENCODE_WORKSPACE_DROPPINGS.map((name) =>
          fsp.rm(path.join(dotOpencode, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }).catch(() => {}),
        ),
      );
    }

    if (!scratchDir || process.env.OPENCODE_AUTH_CONTENT !== undefined) return;
    const trialAuthPath = path.join(scratchDir, 'data', 'opencode', 'auth.json');
    const trialRaw = await fsp.readFile(trialAuthPath, 'utf8').catch(() => undefined);
    if (!trialRaw) return;
    try {
      const trial = JSON.parse(trialRaw) as Record<string, unknown>;
      const realPath = path.join(this.realDataDir(), 'auth.json');
      const realRaw = await fsp.readFile(realPath, 'utf8').catch(() => undefined);
      const real = realRaw ? (JSON.parse(realRaw) as Record<string, unknown>) : {};
      const merged = { ...real, ...trial };
      const mergedJson = JSON.stringify(merged, null, 2);
      if (mergedJson !== realRaw) {
        await fsp.mkdir(path.dirname(realPath), { recursive: true });
        await fsp.writeFile(realPath, mergedJson, { encoding: 'utf8', mode: 0o600 });
      }
    } catch {
      // unparseable trial or real auth — leave the real file untouched
    }
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
   * Fold one OpenCode --format json event. Verified serialization (run.ts
   * emit()): the message part nests under `part` — `{type, timestamp,
   * sessionID, part: {...}}` — and `error` events nest under `error` instead.
   */
  protected handleEvent(event: unknown, state: OpenCodeFoldState, logger?: SessionLogger): void {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;

    if (record.type === 'error') {
      // Tolerate strings and the NamedError serializations ({data:
      // {message}}, {message}, {name}); `?? record.part` keeps the legacy
      // part-nested message shape working.
      state.errorMessage =
        extractErrorMessage(record.error ?? record.part) ?? 'unknown error event';
      return;
    }

    const part = record.part as Record<string, unknown> | undefined;
    if (!part) return;

    switch (record.type) {
      case 'text': {
        const text = part.text;
        if (typeof text === 'string' && text) {
          state.texts.push(text);
          logger?.addTextMessage(text);
        }
        state.sawCompletion = true;
        break;
      }

      case 'tool_use': {
        const toolName = (part.tool as string) ?? 'unknown';
        const toolState = part.state as Record<string, unknown> | undefined;
        const input = toolState?.input ?? part.input;
        state.toolCalls.push({
          tool: toolName,
          toolUseId: (part.callID as string) ?? '',
          timestamp: Date.now(),
          input,
        });
        logger?.addToolUse(toolName, input);

        // Primary surface: the native `skill` tool. Fallback surface:
        // read-style tool touching a SKILL.md path (matched on the tool
        // INPUT, so even a failed probe of a guessed path counts — filter
        // built-ins on both surfaces or baselines report phantom loads).
        if (toolName === 'skill') {
          const skillName = (input as Record<string, unknown> | undefined)?.name;
          if (typeof skillName === 'string' && skillName && !BUILTIN_AGENT_SKILLS.has(skillName)) {
            state.skillLoads.push(skillName);
          }
        } else {
          const skillName = skillNameFromToolInput(input);
          if (skillName && !BUILTIN_AGENT_SKILLS.has(skillName)) state.skillLoads.push(skillName);
        }
        break;
      }

      case 'step_finish': {
        state.sawCompletion = true;
        // One step_finish per LLM API step; only non-tool-call steps end an
        // assistant turn, keeping numTurns comparable to the other runners
        // (codex: turn.completed, claude: the CLI's num_turns).
        if (part.reason !== 'tool-calls') state.numTurns++;
        if (typeof part.cost === 'number') state.costUsd += part.cost;

        const tokens = part.tokens as {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        } | undefined;
        if (tokens) {
          state.tokenTotals ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          state.tokenTotals.input += tokens.input ?? 0;
          // opencode reports reasoning separately from output (session.ts
          // getUsage subtracts it); TokenUsage has no reasoning field, so
          // fold it into output — matching codex, whose output_tokens
          // already include reasoning.
          state.tokenTotals.output += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
          state.tokenTotals.cacheRead += tokens.cache?.read ?? 0;
          state.tokenTotals.cacheCreation += tokens.cache?.write ?? 0;
        }
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
