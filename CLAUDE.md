# CLAUDE.md

CLI for evaluating [Agent Skills](https://agentskills.io/home) - a format for extending AI agent capabilities. Runs standalone or as a GitHub Action.

## Key Files

- `src/cli.ts` - CLI entry point (run, score, report, validate, create-task, cache)
- `src/types.ts` - TypeScript interfaces
- `src/config.ts` - Centralized config (file + env + CLI precedence)
- `src/task/schema.ts` - Task-package frontmatter schema (checks, verifier, metadata)
- `src/task/load.ts` - Task-package loader/validator (task.md frontmatter + prompt body)
- `src/task/scaffold.ts` - `create-task` scaffolding (task.md, verifier, oracle stubs)
- `src/pipeline.ts` - Full pipeline orchestrator (load → workspace → run → verify → score → report)
- `src/run/workspace.ts` - Per-trial throwaway workspaces (seed files + skills mount)
- `src/score/verifier.ts` - Cross-platform verifier/oracle executor (reward contract)
- `src/runner/claude-sdk-runner.ts` - Claude Agent SDK runner
- `src/runner/base-runner.ts` - Shared runner base class (timeout wrapper)
- `src/runner/runner-factory.ts` - Runner selection factory
- `src/runner/security.ts` - PreToolUse write restrictions
- `src/scorer/scorer.ts` - Score orchestrator (deterministic + judge merge)
- `src/scorer/deterministic.ts` - Activation/marker/tool-call/contains/regex/js/file-exists checks
- `src/scorer/judge.ts` - LLM-as-judge scoring (SkillJudge)
- `src/cache/response-cache.ts` - Content-addressed cache of TaskResult by execution inputs
- `src/utils/concurrency.ts` - Bounded-concurrency helper used by runner + judge
- `src/session/session-logger.ts` - Event capture and session logging
- `src/report/report.ts` - Markdown + JSON report generation
- `src/report/html-report.ts` - Interactive static HTML report
- `src/report/github-summary.ts` - Condensed GitHub Actions summary
- `src/index.ts` - Public API exports
- `action/action.yml` + `action/index.ts` - GitHub Action entry point

## Commands

```bash
npm run build           # Compile TypeScript to dist/
npm run bundle:action   # Build + bundle GitHub Action (action/dist/index.cjs)
npm run dev             # Run CLI in dev mode (tsx)
npm run typecheck       # Type check without emitting
npm run start           # Run compiled CLI
```

**Important:** When changing scorer, task loader, types, or pipeline code, run `npm run bundle:action` before committing to keep the GitHub Action bundle in sync.

## Architecture

```
Task packages → Config → Per-trial workspace → Runner (Claude SDK) → Verifier → Scorer (deterministic + LLM judge) → Report
```

## Task packages

A task is a directory containing `task.md` (YAML frontmatter + markdown prompt body). `skilljack-evals run <path>` accepts a single task-package dir or a suite dir of task packages. Frontmatter: `id` (defaults to dir name), `difficulty`/`category`/`tags`, `expected_skill`, `expect_skill_invocation` (false = anti-trigger test), `timeout_ms`, `verifier: { timeout_ms, command }`, `checks:` (lite checks: `contains`, `not_contains`, `regex`, `marker`, `tool_calls`, `no_tool_calls`, `files_exist`, `javascript`), `assertions:` (judge-graded checklist). Optional dirs: `environment/skills/` (task-level skills; falls back to suite-level `<suite>/skills/`), `environment/workspace/` (seed files), `verifier/verify.*`, `oracle/solve.*`. `--skills-dir` overrides skills for all tasks (candidate injection). `validate <path>` runs schema checks plus the oracle gate (oracle → verifier must yield reward 1.0; skip with `--no-oracle`).

## Workspaces and verifiers

Each trial runs in a throwaway workspace (`<output>/workspaces/<taskId>/run-<n>/`) with seed files copied in and skills mounted at `.claude/skills/`; retention via `--keep-workspaces all|failures|none` (default failures). Verifiers run with cwd = workspace and env contract `SKILLJACK_OUTPUT_FILE`, `SKILLJACK_TRAJECTORY_FILE`, `SKILLJACK_TASK_DIR`, `SKILLJACK_REWARD_FILE`; reward = reward-file float 0..1 if written, else exit code (0→1). Dispatch by extension: `.mjs`/`.js` → node, `.py` → py/python, `.sh` → bash (error with docker hint when missing), `.ps1` → powershell; `verifier.command` overrides.

Note: a v2 redesign is in progress (SkillsBench-aligned task packages + real-harness CLI adapters). The four non-Claude SDK runners (vercel-ai, openai-agents, copilot-sdk, google-adk) were removed in v2 Phase 1; real-harness adapters (claude-code, codex, gemini, opencode) land in later phases.

## Runners

Two runners selected via `--runner` flag:
- `claude-sdk` (default) — uses Claude Agent SDK, model aliases like `sonnet`, `haiku`, `opus`
- `claude-code` — drives the real Claude Code CLI (`claude -p --output-format stream-json --setting-sources project`) as a subprocess per task; requires `claude` on PATH (`npm install -g @anthropic-ai/claude-code`); timeouts kill the whole CLI process tree (`src/harness/subprocess.ts`)

## Scoring

Two methods, run independently or together:
- **Deterministic** (free): skill activation, lite `checks:` (marker, tool calls, contains/not_contains, regex, sandboxed javascript, files_exist), plus the verifier outcome when the task has one (reward < 1 → failed)
- **LLM Judge** (~$0.001/task): discovery (0/1), adherence (1-5), output quality (1-5), grading `assertions:` with evidence
- **Weighted Score** (0-1): `w_d * discovery + w_a * ((adherence-1)/4) + w_o * ((output-1)/4)`
- **Blind A/B Comparison** (`--blind-compare`, requires `--compare`): anonymized judge evaluation to detect scoring bias

## Concurrency and caching

- `--concurrency N` / `EVAL_RUNNER_CONCURRENCY` / `runner.concurrency`: max tasks in flight (1=sequential default, 0=unlimited). Applied by the pipeline's `runPhase` via `withConcurrencyLimit`.
- Response cache: TaskResult keyed by SHA-256 of `{taskId, prompt, model, runnerType, skillsHash, environmentHash, timeout, allowedWriteDirs, runIndex}`. Skill and environment-seed hashes invalidate on content change. Tasks with a verifier, a workspace seed, or a `files_exist` check bypass the cache. Manage with `skilljack-evals cache clear`; bypass with `--skip-cache` (read-only skip) or `--bust-cache` (disable fully).

## Failure Categories

- `discovery_failure` - Agent didn't load skill
- `false_positive` - Agent loaded a skill it shouldn't have
- `instruction_ambiguity` - Agent misinterpreted instructions
- `missing_guidance` - Skill didn't cover needed case
- `agent_error` - Agent made mistake despite guidance

## Dependencies

- `@anthropic-ai/claude-agent-sdk` - Claude SDK runner + LLM judge
- `commander` - CLI framework
- `js-yaml` - Parse evaluation YAML files
- `dotenv` - Environment configuration
- `@actions/core` (dev) - GitHub Action support

## Environment

Requires `ANTHROPIC_API_KEY` in environment or `.env` file.

For Bedrock: set `CLAUDE_CODE_USE_BEDROCK=1` + AWS env vars.

## Config Precedence

YAML defaults → `eval.config.yaml` → env vars (`EVAL_*`) → CLI flags
