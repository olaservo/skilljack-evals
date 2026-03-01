# skilljack-evals

CLI for evaluating AI agent skills across multiple agent frameworks. Tests how well agents discover, load, and execute [Agent Skills](https://agentskills.io/home) — measuring discoverability, instruction adherence, and output quality.

Supports the Claude Agent SDK, Vercel AI SDK, and OpenAI Agents SDK. Runs standalone or as a GitHub Action.

## What are Agent Skills?

Agent Skills are a lightweight, open-source format for extending AI agent capabilities. Each skill is a folder containing a `SKILL.md` file with metadata and instructions that agents can discover and use. Learn more at [agentskills.io](https://agentskills.io/home).

## Requirements

- Node.js >= 20.0.0
- API key for your chosen runner (see [API Keys](#api-keys) below)

## Installation

```bash
npm install
npm run build
```

## Quick Start

```bash
# Run the example greeting evaluation
skilljack-evals run evals/example-greeting/tasks.yaml --verbose

# Deterministic scoring only (no LLM judge, free)
skilljack-evals run evals/example-greeting/tasks.yaml --no-judge

# Validate a task file without running
skilljack-evals validate evals/example-greeting/tasks.yaml
```

## Building Skills with Evals

Start by writing eval tasks that describe the outcomes you want, then build your skill to pass them. This eval-first approach works like TDD for agent skills:

1. **Decide if a skill is the right tool** — Skills are for capabilities that should only activate on demand. For instructions that always apply, use `CLAUDE.md` or `AGENTS.md`. For validation and formatting, consider static analysis, pre-commit hooks, or agent hooks instead.

2. **Define desired outcomes** — Write eval tasks with the prompts users will say, the markers your skill should output, and a checklist of what "good" looks like.

3. **Add false-positive tests** — Include prompts that are similar but should *not* trigger the skill. These catch over-eager activation and are just as important as positive tests.

4. **Create a minimal SKILL.md** — Start with basic instructions and metadata.

5. **Run evals and iterate** — Use `skilljack-evals run` to see where the skill falls short. Deterministic checks (`--no-judge`) are free and fast for rapid iteration. Add the LLM judge when you're ready to evaluate output quality.

6. **Keep the eval suite** — As you update the skill, run evals as a regression check. Add them to CI with the GitHub Action to catch regressions automatically.

```bash
# Scaffold eval tasks for a new skill
skilljack-evals create-eval my-skill -o evals/my-skill/tasks.yaml

# Fast iteration loop (deterministic only, no API cost for judging)
skilljack-evals run evals/my-skill/tasks.yaml --no-judge --verbose

# Full evaluation with LLM judge
skilljack-evals run evals/my-skill/tasks.yaml --verbose
```

This workflow ensures your skill is discoverable from the right prompts, doesn't activate when it shouldn't, and produces the output quality you expect.

## Multi-Runner Support

Three runners are available, selected via the `--runner` CLI flag:

| Runner | Flag | Model Format | Example |
|--------|------|-------------|---------|
| Claude Agent SDK (default) | `--runner claude-sdk` | Model aliases | `sonnet`, `haiku` |
| Vercel AI SDK | `--runner vercel-ai` | `provider:model` | `anthropic:claude-sonnet-4-6`, `google:gemini-2.5-pro`, `openai:gpt-5.2`, `openrouter:deepseek/deepseek-v3.2` |
| OpenAI Agents SDK | `--runner openai-agents` | Plain model name | `gpt-5.2` |

```bash
# Claude SDK (default)
skilljack-evals run evals/example-greeting/tasks.yaml --model sonnet

# Vercel AI SDK with different providers
skilljack-evals run evals/example-greeting/tasks.yaml --runner vercel-ai --model "anthropic:claude-sonnet-4-6"
skilljack-evals run evals/example-greeting/tasks.yaml --runner vercel-ai --model "google:gemini-2.5-pro"
skilljack-evals run evals/example-greeting/tasks.yaml --runner vercel-ai --model "openai:gpt-5.2"
skilljack-evals run evals/example-greeting/tasks.yaml --runner vercel-ai --model "openrouter:deepseek/deepseek-v3.2"

# OpenAI Agents SDK
skilljack-evals run evals/example-greeting/tasks.yaml --runner openai-agents --model "gpt-5.2"
```

The Vercel AI SDK and OpenAI Agents SDK runners require their respective peer dependencies:

```bash
# Vercel AI SDK
npm install ai zod @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @openrouter/ai-sdk-provider

# OpenAI Agents SDK
npm install @openai/agents openai
```

### Skill Support by SDK

Each runner uses the SDK's native mechanism for skill discovery and loading:

- **Claude Agent SDK** — Skills via `.claude/skills/` and the `Skill` tool. See [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills) and [Agent Skills format](https://agentskills.io/home).
- **Vercel AI SDK** — Skills via a `loadSkill` tool defined in the runner, following the [Agent Skills cookbook guide](https://ai-sdk.dev/cookbook/guides/agent-skills).
- **OpenAI Agents SDK** — Skills via `shellTool()` with local skill bundles. See [Skills in OpenAI API](https://developers.openai.com/api/docs/guides/tools-skills/) and the [Skills cookbook](https://developers.openai.com/cookbook/examples/skills_in_api/).

## Configuration

### API Keys

Set the appropriate API key in your environment or a `.env` file (see `.env.example`):

| Runner | Required Key |
|--------|-------------|
| Claude SDK | `ANTHROPIC_API_KEY` |
| Vercel AI (`anthropic:`) | `ANTHROPIC_API_KEY` |
| Vercel AI (`openai:`) | `OPENAI_API_KEY` |
| Vercel AI (`google:`) | `GOOGLE_GENERATIVE_AI_API_KEY` |
| Vercel AI (`openrouter:`) | `OPENROUTER_API_KEY` |
| OpenAI Agents | `OPENAI_API_KEY` |

### Bedrock

Set these environment variables — the Agent SDK handles the rest:

```bash
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-west-2
AWS_PROFILE=your-profile
```

### Config File

Create an `eval.config.yaml` in your project root (all fields optional):

```yaml
models:
  agent: sonnet        # EVAL_AGENT_MODEL
  judge: haiku         # EVAL_JUDGE_MODEL

scoring:
  weights:
    discovery: 0.3
    adherence: 0.4
    output: 0.3

thresholds:
  discovery_rate: 0.8  # EVAL_DISCOVERY_THRESHOLD
  avg_score: 4.0       # EVAL_SCORE_THRESHOLD

runner:
  timeout_ms: 300000   # EVAL_TASK_TIMEOUT_MS
  allowed_write_dirs:
    - ./results/
    - ./fixtures/

output:
  dir: ./results       # EVAL_OUTPUT_DIR
  judge_truncation: 5000
  report_truncation: 2000

ci:
  exit_on_failure: true
  github_summary: false
```

**Precedence** (lowest to highest): YAML defaults → `eval.config.yaml` → environment variables (`EVAL_*`) → CLI flags.

## CLI Commands

### `run` — Full evaluation pipeline

Runs the agent against tasks, scores results, and generates reports.

```bash
skilljack-evals run evals/greeting/tasks.yaml \
  --runner vercel-ai --model "google:gemini-2.5-pro" \
  --judge-model haiku \
  --timeout 300000 \
  --tasks gr-001,gr-002 \
  --threshold-discovery 0.8 --threshold-score 4.0 \
  --output-dir ./results \
  --github-summary --verbose
```

### `score` — Score existing results

```bash
skilljack-evals score results.json --judge-model haiku
```

### `report` — Generate reports from scored results

```bash
skilljack-evals report -r results.json -o report.md --json report.json
```

### `validate` — Check YAML syntax

```bash
skilljack-evals validate evals/greeting/tasks.yaml
```

### `create-eval` — Generate task template

```bash
skilljack-evals create-eval greeting -o evals/greeting/tasks.yaml -n 10
```

### `parse` — Parse YAML to JSON

```bash
skilljack-evals parse evals/greeting/tasks.yaml
```

## Architecture

```
YAML tasks → Config → Runner (Claude SDK / Vercel AI / OpenAI Agents) → Scorer (deterministic + LLM judge) → Report
```

### Pipeline

1. **Parse** — Load and validate task definitions from YAML
2. **Setup** — Copy skills to `.claude/skills/` in the working directory
3. **Run** — Execute agent against each task via the selected runner
4. **Score** — Deterministic checks (free, fast) then optional LLM judge
5. **Report** — Generate markdown + JSON reports, check pass/fail thresholds
6. **Cleanup** — Remove copied skills

### Scoring

Two scoring methods that can run independently or together:

**Deterministic** (free, fast):
- Checks tool calls for skill activation
- Searches output for expected marker strings
- Validates expected/forbidden tool usage
- Binary pass/fail

**LLM Judge** (richer, ~$0.20/run with default settings):
- Discovery (0 or 1) — Did the agent load the expected skill?
- Adherence (1-5) — How well did the agent follow skill instructions?
- Output Quality (1-5) — Does the output meet task requirements?
- Failure categorization

**Combined score**: `w_d * discovery + w_a * ((adherence-1)/4) + w_o * ((outputQuality-1)/4)`

### Failure Categories

| Category | Meaning |
|----------|---------|
| `discovery_failure` | Agent didn't load the skill |
| `false_positive` | Agent loaded a skill it shouldn't have |
| `instruction_ambiguity` | Agent misinterpreted instructions |
| `missing_guidance` | Skill didn't cover the needed case |
| `agent_error` | Agent made a mistake despite guidance |
| `none` | No failure |

## Task File Format

```yaml
skill: greeting
version: "1.0"

defaults:
  expected_skill_load: greeting
  criteria:
    discovery: { weight: 0.3 }
    adherence: { weight: 0.4 }
    output: { weight: 0.3 }

tasks:
  - id: gr-001
    prompt: "Hello! Please greet me using the greeting skill."

    # Deterministic checks (optional, free)
    deterministic:
      expect_skill_activation: true
      expect_marker: "GREETING_SUCCESS"
      expect_tool_calls: []
      expect_no_tool_calls: []

    # LLM judge criteria (optional, costs API calls)
    criteria:
      discovery: { weight: 0.3, description: "Should load greeting skill" }
      adherence: { weight: 0.4, description: "Should follow skill format" }
      output: { weight: 0.3, description: "Greeting is friendly" }
    golden_checklist:
      - "Loaded the greeting skill"
      - "Friendly tone"

  # False positive test — skill should NOT activate
  - id: gr-fp-001
    prompt: "What are best practices for email greetings?"
    expected_skill_load: none
    deterministic:
      expect_skill_activation: false
```

Both `deterministic` and `criteria` blocks are optional. If both are present, the scorer runs both and merges results.

## GitHub Action

```yaml
- uses: olaservo/skilljack-evals@v1
  with:
    tasks: evals/commit/tasks.yaml
    threshold-discovery: '0.8'
    threshold-score: '4.0'
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `tasks` | Yes | — | Path to tasks YAML file |
| `runner` | No | `claude-sdk` | Runner type: `claude-sdk`, `vercel-ai`, `openai-agents` |
| `model` | No | `sonnet` | Agent model |
| `judge-model` | No | `haiku` | LLM judge model |
| `config` | No | — | Path to eval.config.yaml |
| `threshold-discovery` | No | `0.8` | Minimum discovery rate (0-1) |
| `threshold-score` | No | `4.0` | Minimum average score (1-5) |
| `timeout` | No | `300000` | Per-task timeout (ms) |
| `tasks-filter` | No | — | Comma-separated task IDs |
| `skills-dir` | No | — | Path to skills directory |
| `no-judge` | No | `false` | Skip LLM judge |
| `no-deterministic` | No | `false` | Skip deterministic scoring |

### Outputs

| Output | Description |
|--------|-------------|
| `passed` | Whether all thresholds were met |
| `discovery-rate` | Discovery rate achieved (0-1) |
| `avg-score` | Average weighted score |
| `report-path` | Path to markdown report |
| `json-path` | Path to JSON report |

The action writes a condensed summary to `$GITHUB_STEP_SUMMARY` and exits with code 1 if thresholds are not met.

## Library Usage

```typescript
import {
  parseEvalFile,
  SkillJudge,
  generateReport,
  runPipeline,
  scoreDeterministic,
  loadConfig,
} from '@skilljack/evals';

// Full pipeline
const result = await runPipeline({
  tasksFile: 'evals/greeting/tasks.yaml',
  configOverrides: { defaultAgentModel: 'sonnet' },
  verbose: true,
});

// Or individual steps
const evaluation = await parseEvalFile('path/to/tasks.yaml');
const judge = new SkillJudge({ model: 'haiku' });
const score = await judge.judgeResult(task, result);
const detScore = scoreDeterministic(task, result);
const report = generateReport(evaluation, results, scores);
```

## Development

```bash
npm run dev        # Run CLI in dev mode (tsx)
npm run build      # Compile TypeScript
npm run typecheck  # Type check without emitting
npm run start      # Run compiled CLI
```
