# CLAUDE.md

CLI for evaluating [Agent Skills](https://agentskills.io/home) - a format for extending AI agent capabilities. Runs standalone or as a GitHub Action.

## Key Files

- `src/cli.ts` - CLI entry point (run, score, report, validate, create-eval, parse)
- `src/types.ts` - TypeScript interfaces
- `src/config.ts` - Centralized config (file + env + CLI precedence)
- `src/parser.ts` - YAML parsing, validation, template generation
- `src/pipeline.ts` - Full pipeline orchestrator (run → score → report)
- `src/runner/runner.ts` - Claude Agent SDK runner (SkillEvalRunner)
- `src/runner/vercel-ai-runner.ts` - Vercel AI SDK runner
- `src/runner/openai-agents-runner.ts` - OpenAI Agents SDK runner
- `src/runner/copilot-sdk-runner.ts` - GitHub Copilot SDK runner
- `src/runner/base-runner.ts` - Shared runner base class
- `src/runner/runner-factory.ts` - Runner selection factory
- `src/runner/skill-setup.ts` - Copy/cleanup skills in .claude/skills/
- `src/runner/security.ts` - canUseTool write restrictions
- `src/scorer/scorer.ts` - Score orchestrator (deterministic + judge merge)
- `src/scorer/deterministic.ts` - Marker/tool-call checks (free, fast)
- `src/scorer/judge.ts` - LLM-as-judge scoring (SkillJudge)
- `src/session/session-logger.ts` - Event capture and session logging
- `src/report/report.ts` - Markdown + JSON report generation
- `src/report/github-summary.ts` - Condensed GitHub Actions summary
- `src/index.ts` - Public API exports
- `action/action.yml` + `action/index.ts` - GitHub Action entry point

## Commands

```bash
npm run build      # Compile TypeScript to dist/
npm run dev        # Run CLI in dev mode (tsx)
npm run typecheck  # Type check without emitting
npm run start      # Run compiled CLI
```

## Architecture

```
YAML tasks → Config → Runner (Claude SDK | Vercel AI | OpenAI Agents | Copilot SDK) → Scorer (deterministic + LLM judge) → Report
```

## Runners

Four runners selected via `--runner` flag:
- `claude-sdk` (default) — uses Claude Agent SDK, model aliases like `sonnet`, `haiku`
- `vercel-ai` — uses Vercel AI SDK, model format `"provider:model"` (e.g., `anthropic:claude-sonnet-4-6`, `google:gemini-2.5-pro`, `openai:gpt-5.2`, `openrouter:deepseek/deepseek-v3.2`)
- `openai-agents` — uses OpenAI Agents SDK, plain model names (e.g., `gpt-5.2`)
- `copilot-sdk` — uses GitHub Copilot SDK, model names like `gpt-5`, `claude-sonnet-4-6`

## Scoring

Two methods, run independently or together:
- **Deterministic** (free): skill activation, marker strings, tool call checks
- **LLM Judge** (~$0.001/task): discovery (0/1), adherence (1-5), output quality (1-5)
- **Weighted Score** (0-1): `w_d * discovery + w_a * ((adherence-1)/4) + w_o * ((output-1)/4)`
- **Blind A/B Comparison** (`--blind-compare`, requires `--compare`): anonymized judge evaluation to detect scoring bias

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

Peer dependencies (install as needed for non-Claude runners):
- `ai`, `zod`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@openrouter/ai-sdk-provider` - Vercel AI SDK
- `@openai/agents`, `openai` - OpenAI Agents SDK
- `@github/copilot-sdk` - GitHub Copilot SDK

## Environment

Requires API key for selected runner in environment or `.env` file:
- Claude SDK / Vercel AI (anthropic:): `ANTHROPIC_API_KEY`
- Vercel AI (openai:) / OpenAI Agents: `OPENAI_API_KEY`
- Vercel AI (google:): `GOOGLE_GENERATIVE_AI_API_KEY`
- Vercel AI (openrouter:): `OPENROUTER_API_KEY`
- Copilot SDK (GitHub auth): `COPILOT_GITHUB_TOKEN` (must have Copilot permissions)
- Copilot SDK (BYOK): Auto-detects `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` when no Copilot token

For Bedrock: set `CLAUDE_CODE_USE_BEDROCK=1` + AWS env vars.

## Config Precedence

YAML defaults → `eval.config.yaml` → env vars (`EVAL_*`) → CLI flags
