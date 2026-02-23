# skilljack-evals

CLI for evaluating AI agent skills using the Claude Agent SDK. Tests how well agents discover, load, and execute [Agent Skills](https://agentskills.io/home) — measuring discoverability, instruction adherence, and output quality.

Runs standalone or as a GitHub Action.

## What are Agent Skills?

Agent Skills are a lightweight, open-source format for extending AI agent capabilities. Each skill is a folder containing a `SKILL.md` file with metadata and instructions that agents can discover and use. Learn more at [agentskills.io](https://agentskills.io/home).

## Requirements

- Node.js >= 20.0.0
- Anthropic API key (or AWS credentials for Bedrock)

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

## Configuration

### API Key

Set `ANTHROPIC_API_KEY` in your environment or a `.env` file (see `.env.example`).

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
  --model sonnet --judge-model haiku \
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
skilljack-evals report results.json -o report.md --json report.json
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
YAML tasks → Config → Runner (Agent SDK) → Scorer (deterministic + LLM judge) → Report
```

### Pipeline

1. **Parse** — Load and validate task definitions from YAML
2. **Setup** — Copy skills to `.claude/skills/` in the working directory
3. **Run** — Execute agent against each task via the Claude Agent SDK
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

**LLM Judge** (richer, ~$0.001/task):
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
  parseSkillEvaluation,
  SkillJudge,
  generateReport,
  runPipeline,
  scoreDeterministic,
  loadConfig,
} from '@skilljack/evals';

// Full pipeline
const result = await runPipeline('evals/greeting/tasks.yaml', {
  model: 'sonnet',
  verbose: true,
});

// Or individual steps
const evaluation = await parseSkillEvaluation('path/to/tasks.yaml');
const judge = new SkillJudge({ model: 'haiku' });
const score = await judge.judgeResult(task, result);
const detScore = scoreDeterministic(task, result);
const report = generateReport(evaluation, results, scores);
```

## Roadmap

The runner currently uses the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) to execute tasks. Support for other models and agent clients is planned for future releases.

## Development

```bash
npm run dev        # Run CLI in dev mode (tsx)
npm run build      # Compile TypeScript
npm run typecheck  # Type check without emitting
npm run start      # Run compiled CLI
```
