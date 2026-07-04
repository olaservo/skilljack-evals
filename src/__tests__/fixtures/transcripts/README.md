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

## gemini / opencode — SYNTHETIC fixtures only

Neither CLI is installed on the dev machine, so `gemini/synthetic-*.jsonl` and `opencode/synthetic-*.jsonl` are HAND-WRITTEN from the officially documented output shapes (July 2026 docs), NOT captured transcripts. The runners built on them are marked experimental; replace these with real captures when the CLIs are available.

- gemini: `gemini -p "<prompt>" --output-format stream-json --approval-mode yolo` (docs-verified; the plan's `--output-format json --yolo` guess was revised — single-object json mode omits tool arguments, which SKILL.md-read detection needs). Skills discovered from `.gemini/skills/` (alias `.agents/skills/`); native `activate_skill` tool is the primary invocation surface.
- opencode: `opencode run --format json --auto "<prompt>"` (docs-verified; the plan's `--print-logs` is stderr-only diagnostics and was dropped, and `--auto` is required because non-interactive permission requests are otherwise auto-rejected). Skills discovered from `.opencode/skills/` (PLURAL — the plan's `.opencode/skill` guess was wrong); native `skill` tool is the primary invocation surface; `step_finish` events carry cost + tokens.
