# skill-eval-cli

CLI utility for evaluating AI agent skills. Tests how well agents discover, load, and execute [Agent Skills](https://agentskills.io/home).

## What are Agent Skills?

Agent Skills are a lightweight, open-source format for extending AI agent capabilities. Each skill is a folder containing a `SKILL.md` file with metadata and instructions that agents can discover and use. Learn more at [agentskills.io](https://agentskills.io/home).

## Requirements

- Node.js >= 20.0.0
- Anthropic API key

## Installation

```bash
npm install
npm run build
```

## Configuration

Create a `.env` file (see `.env.example`):

```
ANTHROPIC_API_KEY=your-api-key-here
```

## CLI Commands

```bash
# Generate an evaluation template YAML for a skill
skill-evals create-eval <skill-name>

# Parse tasks.yaml to JSON
skill-evals parse <skill-name>

# Score a single task result
skill-evals judge --task-id <id> --prompt "..." --output "..."

# Generate reports from evaluation results
skill-evals report -r results.json -o report.md
```

## Evaluation Workflow

1. **Create** - Generate evaluation template YAML with `create-eval`
2. **Parse** - Convert tasks.yaml to JSON with `parse`
3. **Run** - Execute agent against tasks (external step)
4. **Judge** - Score results with `judge`
5. **Report** - Generate markdown/JSON reports with `report`

## Task File Format

Evaluation tasks are defined in YAML:

```yaml
skill: commit
tasks:
  - id: cm-001
    prompt: "Make a commit for these changes"
    expected_skill_load: commit
    criteria:
      discovery: { weight: 0.3, description: "Should load commit skill" }
      adherence: { weight: 0.4, description: "Should follow commit conventions" }
      output: { weight: 0.3, description: "Should produce valid commit" }
    golden_checklist:
      - "Stages appropriate files"
      - "Uses conventional commit format"
```

## Scoring Dimensions

- **Discovery** (0 or 1) - Did the agent load the expected skill?
- **Adherence** (1-5) - How well did the agent follow skill instructions?
- **Output Quality** (1-5) - Does the output meet task requirements?

## Library Usage

```typescript
import { parseSkillEvaluation, SkillJudge, generateReport } from '@skill-evals/cli';

// Parse evaluation tasks
const evaluation = await parseSkillEvaluation('path/to/tasks.xml');

// Judge results
const judge = new SkillJudge();
const score = await judge.scoreResult(task, result);

// Generate report
const report = generateReport(evaluation, results, scores);
```

## Development

```bash
npm run dev      # Run CLI in development mode
npm run build    # Compile TypeScript
npm run typecheck # Type check without emitting
```
