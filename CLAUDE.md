# CLAUDE.md

CLI for evaluating [Agent Skills](https://agentskills.io/home) - a format for extending AI agent capabilities.

## Key Files

- `src/cli.ts` - Main CLI entry point with commands (create-eval, parse, judge, report)
- `src/parser.ts` - YAML parsing and template generation for evaluation tasks
- `src/judge.ts` - LLM-as-judge scoring using Claude Haiku
- `src/report.ts` - Markdown and JSON report generation
- `src/types.ts` - TypeScript interfaces for the evaluation framework
- `src/index.ts` - Public API exports for library usage

## Commands

```bash
npm run build      # Compile TypeScript to dist/
npm run dev        # Run CLI in dev mode (tsx)
npm run typecheck  # Type check without emitting
npm run start      # Run compiled CLI
```

## Architecture

```
Parser (YAML tasks) → Judge (LLM scoring) → Report (markdown/JSON)
```

## Scoring

- **Discovery** (0/1): Did agent load the expected skill?
- **Adherence** (1-5): How well did agent follow skill instructions?
- **Output Quality** (1-5): Does output meet task requirements?
- **Weighted Score** (0-1): Normalized composite score

## Failure Categories

- `discovery_failure` - Agent didn't load skill
- `instruction_ambiguity` - Agent misinterpreted instructions
- `missing_guidance` - Skill didn't cover needed case
- `agent_error` - Agent made mistake despite guidance

## Dependencies

- `@anthropic-ai/claude-agent-sdk` - Claude API for judging
- `commander` - CLI framework
- `js-yaml` - Parse evaluation YAML files
- `dotenv` - Environment configuration

## Environment

Requires `.env` with `ANTHROPIC_API_KEY`.

## Security

This project has locked-down Claude Code permissions (`.claude/settings.json`):
- **Write access**: Only `./results/` directory
- **Read access**: `./evals/`, `./src/`, `./results/`
- **Network**: Only `api.anthropic.com` (for judging)
- **Blocked**: curl, wget, .env files, source code edits
