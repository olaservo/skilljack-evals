# Captured harness CLI transcripts (spike fixtures)

Real transcripts captured 2026-07-04 during the v2 harness spike, used as replay fixtures for harness adapter tests. Each was produced by running the CLI headless in a scratch workspace with the `greeting` skill (from `evals/example-greeting`) mounted at the harness's skill discovery path.

## claude-code (Claude Code 2.1.200)

Command: `claude -p "<prompt>" --output-format stream-json --verbose --model haiku --dangerously-skip-permissions` with skill at `.claude/skills/greeting/SKILL.md`, cwd = workspace.

Verified contract:

- `{"type":"system","subtype":"init"}` lists available tools including `Skill`, plus resolved model.
- Skill invocation surface: `assistant` event containing a `tool_use` block with `name: "Skill"`, `input: {"skill": "greeting"}` → surface `skill-tool`. `Read` of `*/SKILL.md` is the fallback surface `file-read`.
- Terminal `{"type":"result"}` event carries `subtype` (success), `num_turns`, `total_cost_usd`, full `usage` (input/output/cache tokens), and `result` (final text).
- **Isolation gap found**: the user's global `~/.claude` settings/hooks ran inside the trial (visible as `hook_started`/`hook_response` events). Adapters must pass `--setting-sources project` so only the workspace's `.claude/` is loaded.

## codex (codex-cli 0.137.0)

Command: `codex exec --json --skip-git-repo-check "<prompt>"` with skill at `.agents/skills/greeting/SKILL.md`, cwd = workspace.

Verified contract:

- Events: `thread.started` → `turn.started` → `item.started`/`item.completed` (item types seen: `agent_message`, `command_execution`) → `turn.completed`.
- Codex discovered the skill natively from `.agents/skills/` (no nudge): first `agent_message` announced using the `greeting` skill, then a `command_execution` item read the SKILL.md (PowerShell `Get-Content <path>/SKILL.md`).
- Skill invocation surfaces: `command_execution.command` containing a `SKILL.md` path (→ `file-read`); `agent_message` naming the skill is corroborating evidence only.
- Token usage IS present (Phase 5 finding, contra the original spike note): `turn.completed` carries `usage: {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`. `input_tokens` includes the cached tokens; the runner splits them out. No cost field — the runner estimates cost from tokens.
- **Isolation** (Phase 5 resolution): instead of a per-trial `CODEX_HOME`, the runner passes `--ignore-user-config` (skips `~/.codex/config.toml` — the MCP-server leak — while auth still uses `CODEX_HOME`) plus `--ephemeral` (no session files persisted). Verified end-to-end against codex-cli 0.137.0.

## opencode (opencode 1.17.13)

Captured 2026-07-05 (Windows). Command: `opencode run --format json --auto -m anthropic/claude-haiku-4-5 "<prompt>"` with skill at `.opencode/skills/greeting/SKILL.md`, cwd = workspace, isolation env set (below). Contract also cross-checked against the opencode v1.17.13 source (`packages/opencode/src/cli/cmd/run.ts`, `packages/schema/src/v1/session.ts`).

Verified contract:

- JSONL on stdout; every event is `{type, timestamp, sessionID, part: {...}}` — payloads nest under `part` (the `part.type` uses hyphens, e.g. `step-finish`, while the event `type` uses underscores). `error` events nest under `error` instead: `{type:"error", error:{name, data:{message, ref}}}` (captured live via a bad `-m`; exits 1).
- Event order seen live: `step_start` → `tool_use` (skill call) → `step_finish` (reason `tool-calls`) → `step_start` → `text` → `step_finish` (reason `stop`). `text` fires only when the part completes; `tool_use` only on `state.status` completed/error. No incremental deltas, no final-summary event.
- Skill invocation surface: native `skill` tool — `part.tool === "skill"`, `part.state.input.name === "greeting"`, title `Loaded skill: greeting` (→ `skill-tool`). Read-style tools touching a SKILL.md path are the `file-read` fallback. The CLI's built-in `customize-opencode` skill is ALWAYS registered (the skill list is never empty) — the runner excludes it from `skillLoads`.
- Each `step_finish` carries `part.cost` and `part.tokens {total, input, output, reasoning, cache:{read, write}}` PER STEP — the runner sums across steps.
- `--auto` is required: without it every permission ask (including the `skill` tool's own permission) is auto-rejected on stderr while the run still exits 0. Exit codes are otherwise forgiving — rely on the `error` event + completion signals, not exit code alone.
- `-m` takes `provider/model` (e.g. `anthropic/claude-haiku-4-5`), no aliases; auth via `ANTHROPIC_API_KEY` auto-enables the anthropic provider (no `opencode auth login` needed).
- **Isolation** (verified live — no `--ignore-user-config` equivalent exists; by default opencode reads `~/.config/opencode` config+skills, `~/.opencode`, `~/.claude/skills`, `~/.agents/skills`, and walks up from cwd to the git worktree root): the runner sets per-trial env `XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME/XDG_STATE_HOME` + `OPENCODE_TEST_HOME` (all under a per-trial OS temp dir, deleted after the trial — kept OUTSIDE the workspace so verifiers, docker mounts, and retention never see opencode's db/logs/snapshots), `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, and `OPENCODE_PURE=1`. Probe run confirmed `<available_skills>` contained only `greeting` + built-in `customize-opencode` despite `~/.claude/skills` and `~/.agents/skills` existing on the machine, and nothing was written to the real home dirs. `OPENCODE_DISABLE_PROJECT_CONFIG` must NOT be set (it would hide the workspace's own `.opencode/skills` mount). Auth: provider env keys pass through; because the `XDG_DATA_HOME` redirect hides the real `auth.json` (OAuth logins via `opencode auth login`), the runner forwards its content via `OPENCODE_AUTH_CONTENT`. Known cosmetic leak: the `opencode --version` preflight runs without the isolation env and creates empty `~/.config/opencode` + `~/.local/share/opencode/log` dirs — no effect on trials.
- **PWD pitfall** (found via a failing pipeline smoke, bisected live): opencode (Bun) trusts `env.PWD` over the real spawn cwd. When the harness inherits a stale `PWD` from the launching shell (e.g. Git Bash sitting at the repo root) and spreads `process.env`, opencode silently re-anchors its instance/session to that directory — the workspace's `.opencode/skills` mount becomes invisible while global skills still load. `CliRunner` therefore pins `PWD` to the spawn cwd for EVERY CLI runner (shell children reading `$PWD` and future Bun-based CLIs are equally exposed). (`git init` in the workspace does NOT help — the anchor follows PWD, not the nearest `.git`.)

## gemini — SYNTHETIC fixture only

The gemini CLI is not installed on the dev machine, so `gemini/synthetic-*.jsonl` is HAND-WRITTEN from the officially documented output shapes (July 2026 docs), NOT a captured transcript. The runner built on it is marked experimental; replace with a real capture when the CLI is available.

- gemini: `gemini -p "<prompt>" --output-format stream-json --approval-mode yolo` (docs-verified; the plan's `--output-format json --yolo` guess was revised — single-object json mode omits tool arguments, which SKILL.md-read detection needs). Skills discovered from `.gemini/skills/` (alias `.agents/skills/`); native `activate_skill` tool is the primary invocation surface.
