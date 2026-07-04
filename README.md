# skilljack-evals

Evaluation CLI for [Agent Skills](https://agentskills.io/home): SkillsBench-style task packages run through real agent harnesses (Claude Agent SDK, Claude Code, Codex, and more), scored by deterministic verifiers, with paired no-skill baselines that measure what your skill actually adds.

It serves two workflows with one architecture:

- **Authoring loop (TDD for skills)** — write a task first, watch it fail, then iterate on your `SKILL.md` until the eval passes. Fast, cheap (lite checks are free, caching skips unchanged runs), with opt-in LLM-judge diagnostics that explain *why* a trial failed but never gate the result.
- **CI benchmark gating** — run the same task packages in GitHub Actions with resolution-rate and skill-lift thresholds, k trials per condition, and a machine-readable `summary.json` for regression comparison across skill versions.

## What are Agent Skills?

Agent Skills are a lightweight, open format for extending AI agent capabilities: a folder with a `SKILL.md` (frontmatter + instructions) that agents discover and load on demand. Learn more at [agentskills.io](https://agentskills.io/home).

## Requirements

- Node.js >= 20
- `ANTHROPIC_API_KEY` (for the default `claude-sdk` runner and the optional judge), or an installed + authenticated agent CLI for the CLI runners (see [Runners](#runners))

## Quickstart

```bash
npm install && npm run build

# 1. Scaffold a task package
skilljack-evals create-task my-first-task

# 2. Edit evals/my-first-task/task.md (prompt + checks), add your skill under
#    evals/my-first-task/environment/skills/<name>/SKILL.md

# 3. Validate (schema + oracle gate)
skilljack-evals validate evals/my-first-task

# 4. Run it (with-skill + no-skill baseline, 3 trials each by default)
skilljack-evals run evals/my-first-task

# Try the committed example
skilljack-evals run evals/example-greeting --runs 1
```

## Task packages

A task is a directory containing a `task.md` (YAML frontmatter + markdown prompt body). `run <path>` accepts a single task dir or a suite dir of task dirs (suite-level `skills/` is shared by tasks without their own).

```
evals/<task-id>/
  task.md                    # frontmatter + prompt (the prompt never names the skill)
  environment/
    skills/<name>/           # skills under test (falls back to suite-level skills/)
    workspace/               # optional seed files copied into each trial workspace
    Dockerfile               # optional; used by --sandbox docker verifier runs
  verifier/verify.mjs        # optional script verifier (.mjs|.js|.py|.sh|.ps1)
  oracle/solve.mjs           # optional reference solution (validate's oracle gate)
```

`task.md` frontmatter reference:

```yaml
---
id: my-task                   # optional, must match the directory name
difficulty: medium            # easy|medium|hard
category: document-processing
tags: [pdf]
expected_skill: pdf-tools     # defaults to the single skill under environment/skills/
expect_skill_invocation: true # false = anti-trigger (false-positive) task
timeout_ms: 300000            # agent timeout
verifier: { timeout_ms: 60000, command: node verify.mjs }  # command optional (extension dispatch)
checks:                       # lite deterministic checks (free, no verifier script needed)
  contains: ["expected text"]
  not_contains: [ERROR]
  regex: ["\\d{4}-\\d{2}-\\d{2}"]
  marker: SUCCESS_MARKER      # case-insensitive substring
  tool_calls: [Write]         # tools that must have been called
  no_tool_calls: [Bash]
  files_exist: [out/report.pdf]   # relative to the trial workspace
  javascript: "output.length > 10" # sandboxed expression over `output`
assertions:                   # graded by the LLM judge with evidence (--judge only)
  - "Chart has labeled axes"
---
Prompt body goes here. Use realistic context; never name the skill directly.
```

A task must define at least one of `checks:`, a `verifier/` script, or `assertions:` (or be an anti-trigger task). `validate` warns when a task's only signal is skill invocation itself — the no-skill baseline would trivially pass and Skill Lift would be meaningless.

**Workspaces.** Every trial runs in a throwaway workspace (`<output>/workspaces/<taskId>/run-<n>/`) seeded from `environment/workspace/`, with skills mounted at the runner's discovery path. Retention: `--keep-workspaces all|failures|none` (default `failures`).

**Verifier contract.** Verifiers run with cwd = trial workspace and env vars `SKILLJACK_OUTPUT_FILE` (agent's final output), `SKILLJACK_TRAJECTORY_FILE` (tool calls JSON), `SKILLJACK_TASK_DIR`, and `SKILLJACK_REWARD_FILE`. Reward = float 0..1 written to the reward file, else exit code (0 → 1). Host dispatch by extension: `.mjs`/`.js` → node, `.py` → py/python, `.sh` → bash (actionable error pointing at `--sandbox docker` when bash is missing), `.ps1` → powershell.

**Oracle gate.** `validate` runs `oracle/solve.*` in a fresh workspace and requires the verifier to then yield reward 1.0 — proof the task is solvable and the verifier isn't broken. Skip with `--no-oracle`.

## Runners

| Runner | Status | Invocation | Skills mount | Install |
|---|---|---|---|---|
| `claude-sdk` (default) | stable | Claude Agent SDK in-process | `.claude/skills` | `ANTHROPIC_API_KEY` |
| `claude-code` | stable | `claude -p --output-format stream-json --setting-sources project` | `.claude/skills` | `npm i -g @anthropic-ai/claude-code` |
| `codex` | stable (e2e-verified) | `codex exec --json --skip-git-repo-check --ignore-user-config --ephemeral` | `.agents/skills` | `npm i -g @openai/codex` + `codex login` |
| `gemini` | **experimental** | `gemini -p --output-format stream-json --approval-mode yolo` | `.gemini/skills` | `npm i -g @google/gemini-cli` |
| `opencode` | **experimental** | `opencode run --format json --auto` | `.opencode/skills` | `npm i -g opencode-ai` |

Notes:

- CLI runners spawn the real agent CLI per trial with cwd = the trial workspace; timeouts kill the entire process tree. Each runner preflights with a version check and fails with an install hint when the CLI is missing.
- `--model` semantics differ per runner: `claude-sdk`/`claude-code` take Claude aliases (`sonnet`, `haiku`, `opus`); `codex`/`gemini`/`opencode` only forward `--model` when you set one explicitly (otherwise each CLI uses its own default — Claude aliases are never forwarded to non-Claude CLIs). OpenCode expects `provider/model` form.
- Skill invocation detection: Claude runners see the native `Skill` tool; `codex` detects shell reads of `SKILL.md` (its native discovery mechanism, verified in captured transcripts); `gemini`/`opencode` look for their native `activate_skill`/`skill` tools plus SKILL.md reads as fallback.
- Isolation: `claude-code` passes `--setting-sources project` and `codex` passes `--ignore-user-config --ephemeral` so your global config doesn't leak into trials (auth still works). The experimental runners have **no verified isolation story yet** — global gemini/opencode config and skills may leak into trials; see the JSDoc in `src/runner/gemini-runner.ts` / `opencode-runner.ts`.
- `gemini` and `opencode` were built from official docs but have not been verified against a live CLI — they warn on first use, and captured transcripts are wanted (see `src/__tests__/fixtures/transcripts/README.md`).

## Scoring and metrics

The deterministic reward is authoritative. Per trial: reward = 1 when all lite `checks:` pass AND the verifier (when present) yields reward >= 1; agent error or timeout = 0. The judge never changes a reward.

- **Resolution Rate** — mean per-task trial pass rate (with a 95% binomial CI)
- **Pass@k** — share of tasks with at least one passing trial (`-k, --trials <n>`, default 3)
- **Skill Lift** — with-skill resolution minus baseline resolution, per task and macro-averaged. The paired baseline (same prompts, no skills mounted, nudge off) runs by default whenever tasks have skills; disable with `--no-baseline`, or swap in another skill version with `--compare-skill <dir>`
- **Skill Invocation Rate** — share of with-skill trials that loaded the expected skill (anti-trigger tasks excluded; the metric is decoupled from reward except for `expect_skill_invocation: false` tasks, where invoking is a failure)

Thresholds gate CI: `--threshold-resolution <0-1>` (default 0.8) on the with-skill resolution rate, and optionally `--threshold-lift <delta>` on macro lift.

## Judge diagnostics (authoring loop)

`--judge` adds LLM-as-judge diagnostics (~$0.001/task with the default `haiku` judge): adherence and output-quality ratings, `assertions:` grading with concrete evidence, and failure-category attribution (`discovery_failure`, `false_positive`, `instruction_ambiguity`, `missing_guidance`, `agent_error`). Diagnostics render in their own report section and **never affect pass/fail**.

- `--generate-feedback <file>` emits a feedback template after a run; fill it in and pass `--feedback <file>` on the next run to enrich judge prompts with your human review (requires `--judge`).
- `--compare-skill <dir> --judge --blind-compare` runs a blind A/B comparison of two skill *versions* — outputs are anonymized before judging to detect scoring bias.

## Skill nudge

`--nudge off|name|description|full` (default `off`) appends an escalating hint about available skills to with-skill prompts — useful for separating "can't discover the skill" from "can't follow it". The baseline condition always gets the bare prompt, and the nudge text is part of the cache key.

## Caching and concurrency

Results are cached content-addressed by `{task, prompt(+nudge), model, runner, skills hash, environment hash, timeout, trial index}` — editing a skill automatically invalidates its entries, so the TDD loop only pays for what changed. Tasks with a verifier, workspace seed files, or `files_exist` checks bypass the cache (their outcome depends on filesystem state). `--skip-cache` ignores reads, `--bust-cache` disables caching entirely, `skilljack-evals cache clear` wipes it. `--concurrency N` bounds tasks in flight (default 1, 0 = unlimited).

## Sandbox (`--sandbox docker`)

`--sandbox docker` containerizes the **verifier, not the agent**: the agent CLI runs on the host against the trial workspace, then the verifier runs in a container with the workspace bind-mounted at `/workspace`, the task dir at `/task` (and `/verifier`), and a logs dir at `/logs`. `.sh` verifiers always dispatch to bash inside the container — the Windows escape hatch for imported SkillsBench tasks — and if the verifier writes `/logs/verifier/reward.txt` (the SkillsBench convention) that wins as the reward source. A task `environment/Dockerfile` is built once per content hash; otherwise `node:20-slim` is used. Running the *agent* in containers (network policy, resource limits, hundreds of concurrent trials) is deliberately out of scope — that's BenchFlow's job (see [interop](#skillsbenchbenchflow-interop)).

## GitHub Action

```yaml
- uses: olaservo/skilljack-evals@v2
  with:
    tasks: evals/my-skill
    runner: claude-sdk          # claude-code/codex/gemini/opencode need the CLI installed+authed on the runner
    model: sonnet
    runs: 3                     # trials per task per condition
    baseline: true              # paired no-skill condition (skill lift)
    threshold-resolution: '0.8'
    # threshold-lift: '0.1'     # optionally gate macro lift
    # judge: true               # diagnostics only, never gates
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Outputs: `passed`, `resolution-rate`, `pass-at-k`, `skill-lift`, `invocation-rate`, `report-path`, `json-path`, `summary-json-path`, `has-regressions`, and the blind-comparison counters. The gate reads `summary.json`, so `compare-results` can diff against a previous run's summary artifact.

## Configuration

Precedence: built-in defaults → `eval.config.yaml` → `EVAL_*` env vars → CLI flags.

```yaml
# eval.config.yaml
runner:
  type: claude-sdk            # claude-sdk|claude-code|codex|gemini|opencode
  timeout_ms: 300000
  concurrency: 1
models:
  agent: sonnet
  judge: haiku
nudge: off                    # off|name|description|full
sandbox: host                 # host|docker (verifier containerization)
thresholds:
  resolution_rate: 0.8
  # min_lift: 0.1
judge:
  enabled: false
cache: { enabled: true, dir: ./results/.cache, ttl_hours: 168 }
output: { dir: ./results }
ci: { exit_on_failure: true, github_summary: false, html_report: true }
```

Env vars mirror these: `EVAL_RUNNER_TYPE`, `EVAL_AGENT_MODEL`, `EVAL_JUDGE_MODEL`, `EVAL_TASK_TIMEOUT_MS`, `EVAL_RUNNER_CONCURRENCY`, `EVAL_NUDGE`, `EVAL_SANDBOX`, `EVAL_RESOLUTION_THRESHOLD`, `EVAL_LIFT_THRESHOLD`, `EVAL_JUDGE`, `EVAL_OUTPUT_DIR`, `EVAL_CACHE_*`.

## Programmatic API

```ts
import { runEvaluation } from '@skilljack/evals';

const summary = await runEvaluation({ tasksPath: 'evals/my-skill', numRuns: 1, skillsDir: 'candidates/v7/skills' });
// summary: RunSummary — { run, metrics: { resolutionRate, ci, passAtK, skillLift?, skillInvocationRate?, ... },
//   thresholds, tasks: [{ id, withSkill, baseline?, lift?, failures: [{ failedChecks, verifierStderr?, ... }] }] }
```

`runEvaluation(opts): Promise<RunSummary>` is the stable contract for external optimizers (GEPA-style loops): the skill directory is the candidate (`skillsDir` injection), the reward is the score, and per-trial `failures` carry the actionable side information a reflection model needs. The same object is written to `<output>/summary.json` on every CLI run and consumed by `--compare-results` and the Action gate.

## SkillsBench/BenchFlow interop

[SkillsBench](https://github.com/benchflow-ai/skillsbench) is the reference benchmark for Agent Skills; [BenchFlow](https://github.com/benchflow-ai/benchflow) (Apache-2.0, `uv tool install benchflow`) runs its task packages in fully containerized sweeps. The division of labor: **skilljack-evals owns the inner loop** (host-run TDD on any OS including Windows, lite checks, judge diagnostics, CI gating, optimizer-ready API); **BenchFlow owns the outer loop** (big Docker-isolated benchmark runs, agent-in-container, multi-service environments). Two commands bridge them:

- `skilljack-evals import <dir> [--out evals/]` — convert a SkillsBench-native task package into ours: metadata/timeouts mapped, skills kept, non-skill environment files become workspace seeds, verifier/oracle copied as-is. Unknown frontmatter is preserved under `x_skillsbench:` (tolerant — never a hard failure), and `.sh`-verifier tasks are tagged `requires_docker: true` (run them with `--sandbox docker`).
- `skilljack-evals export <taskDir> [--out <dir>]` — emit a BenchFlow-native package: their `schema_version: '1.3'` frontmatter shape, prompt verbatim, skills under `environment/skills/`, a `verifier/test.sh` wrapper that runs your `verify.*` and writes `/logs/verifier/reward.txt`, an `oracle/solve.sh` wrapper, and an `environment/Dockerfile` stub when you have none. Lite-checks-only tasks get a generated `checks.mjs` verifier (output-text and `files_exist` checks; host-only concepts like `tool_calls`/`javascript` are warned as dropped). Your native fields round-trip through an `x_skilljack:` block, so `export` → `import` is lossless.

## CLI reference

```
run <path>            Full pipeline: workspaces → agent trials → verifier → score → report
score <results.json>  Re-score saved results (--judge adds diagnostics after the fact)
report -r <json>      Regenerate md/json/html reports
validate <path>       Schema checks + oracle gate (--no-oracle for schema only)
create-task <id>      Scaffold a task package
import <dir>          SkillsBench package → our format
export <taskDir>      Our format → BenchFlow-native package
cache clear           Wipe the response cache
```

## Migrating from v1 (YAML suites)

v1 multi-task YAML files (`tasks.yaml`) and the four non-Claude SDK runners (vercel-ai, openai-agents, copilot-sdk, google-adk) were removed in v2. Each v1 task becomes a task-package directory: the `prompt` moves into the `task.md` body, `expect_*` fields map onto `checks:` (`expect_contains` → `contains`, `expect_marker` → `marker`, `expect_file_exists` → `files_exist`, ...), `golden_checklist` → `assertions:`, and `fixture:` setup/teardown scripts are replaced by `environment/workspace/` seed files plus per-trial throwaway workspaces. The judge's weighted score no longer gates anything — deterministic reward and the resolution/lift thresholds do.

## License

MIT
