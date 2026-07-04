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
- No token usage observed in this event stream; check `turn.completed` fields / other flags when building the adapter (Phase 5).
- **Isolation gap found**: the user's global `~/.codex` config leaked (an MCP server connection attempt appeared on stderr). Adapters must set `CODEX_HOME` to a per-trial config dir.

## Not yet captured

- `gemini` and `opencode` are not installed on the dev machine; capture their transcripts when building those adapters (Phase 5). Expected commands: `gemini -p "<prompt>" --output-format json --yolo`, `opencode run --format json "<prompt>"` — verify at implementation time.
