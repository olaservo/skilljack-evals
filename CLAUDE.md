# CLAUDE.md

CLI for evaluating [Agent Skills](https://agentskills.io/home) - a format for extending AI agent capabilities. Runs standalone or as a GitHub Action.

## Key Files

- `src/cli.ts` - CLI entry point (run, score, report, validate, create-eval, parse)
- `src/types.ts` - TypeScript interfaces
- `src/config.ts` - Centralized config (file + env + CLI precedence)
- `src/parser.ts` - YAML parsing, validation, template generation
- `src/pipeline.ts` - Full pipeline orchestrator (run → score → report)
- `src/runner/runner.ts` - Agent SDK runner (SkillEvalRunner)
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
YAML tasks → Config → Runner (Agent SDK) → Scorer (deterministic + LLM judge) → Report
```

## Scoring

Two methods, run independently or together:
- **Deterministic** (free): skill activation, marker strings, tool call checks
- **LLM Judge** (~$0.001/task): discovery (0/1), adherence (1-5), output quality (1-5)
- **Weighted Score** (0-1): `w_d * discovery + w_a * ((adherence-1)/4) + w_o * ((output-1)/4)`

## Failure Categories

- `discovery_failure` - Agent didn't load skill
- `false_positive` - Agent loaded a skill it shouldn't have
- `instruction_ambiguity` - Agent misinterpreted instructions
- `missing_guidance` - Skill didn't cover needed case
- `agent_error` - Agent made mistake despite guidance

## Dependencies

- `@anthropic-ai/claude-agent-sdk` - Agent runner + LLM judge
- `commander` - CLI framework
- `js-yaml` - Parse evaluation YAML files
- `dotenv` - Environment configuration
- `@actions/core` (dev) - GitHub Action support

## Environment

Requires `ANTHROPIC_API_KEY` in environment or `.env` file. For Bedrock: set `CLAUDE_CODE_USE_BEDROCK=1` + AWS env vars.

## Config Precedence

YAML defaults → `eval.config.yaml` → env vars (`EVAL_*`) → CLI flags
