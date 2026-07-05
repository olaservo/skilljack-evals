/**
 * Centralized configuration for the skill evaluation framework.
 *
 * Configuration is loaded with the following precedence (lowest to highest):
 * 1. Built-in defaults
 * 2. Config file (eval.config.yaml or custom path)
 * 3. Environment variables (EVAL_* prefix)
 * 4. Programmatic overrides (CLI flags or API)
 *
 * Supports both Anthropic API and Bedrock via Agent SDK env vars:
 * - Anthropic: Set ANTHROPIC_API_KEY
 * - Bedrock: Set CLAUDE_CODE_USE_BEDROCK=1, AWS_REGION, AWS_PROFILE
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_RUNNER_CONCURRENCY } from './utils/concurrency.js';
import { NUDGE_LEVELS } from './run/nudge.js';
import type { NudgeLevel } from './run/nudge.js';

export type RunnerType = 'claude-sdk' | 'claude-code' | 'codex' | 'gemini' | 'opencode';

export const VALID_RUNNER_TYPES: RunnerType[] = ['claude-sdk', 'claude-code', 'codex', 'gemini', 'opencode'];

/** Verifier/oracle sandbox: run on the host (default) or inside Docker. */
export type SandboxMode = 'host' | 'docker';

export const SANDBOX_MODES: SandboxMode[] = ['host', 'docker'];

export interface EvalConfig {
  // Runner
  runnerType: RunnerType;

  // Models
  defaultAgentModel: string;
  defaultJudgeModel: string;

  // LLM judge diagnostics (opt-in; never affects pass/fail)
  judgeEnabled: boolean;

  // Scoring weights
  defaultWeights: {
    discovery: number;
    adherence: number;
    output: number;
  };

  // Output limits
  judgeOutputTruncation: number;
  reportOutputTruncation: number;

  // Timeouts
  taskTimeoutMs: number;

  // Concurrency
  concurrency: number;

  // Skill nudge appended to with-skill prompts (baseline always gets 'off')
  nudge: NudgeLevel;

  // Verifier/oracle sandbox mode (host default; docker containerizes verifiers)
  sandbox: SandboxMode;

  // CI/CD behavior
  exitOnFailure: boolean;
  outputDir: string;
  githubSummary: boolean;
  htmlReport: boolean;

  // Pass/fail thresholds
  resolutionThreshold: number; // 0-1 min with-skill resolution rate, default 0.8
  liftThreshold?: number; // min macro skill lift; unset = not gated

  // Security
  allowedWriteDirs: string[];

  // Response cache
  cache: {
    enabled: boolean;
    dir: string;
    ttlHours: number;
  };
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: EvalConfig = {
  runnerType: 'claude-sdk',
  defaultAgentModel: 'sonnet',
  defaultJudgeModel: 'haiku',
  judgeEnabled: false,
  defaultWeights: {
    discovery: 0.3,
    adherence: 0.4,
    output: 0.3,
  },
  judgeOutputTruncation: 5000,
  reportOutputTruncation: 2000,
  taskTimeoutMs: 300000, // 5 minutes
  concurrency: DEFAULT_RUNNER_CONCURRENCY, // sequential by default
  nudge: 'off',
  sandbox: 'host',
  exitOnFailure: true,
  outputDir: './results',
  githubSummary: false,
  htmlReport: true,
  resolutionThreshold: 0.8,
  liftThreshold: undefined,
  allowedWriteDirs: ['./results/', './fixtures/'],
  cache: {
    enabled: true,
    dir: './results/.cache',
    ttlHours: 168,
  },
};

/**
 * Raw config file structure (eval.config.yaml).
 */
interface RawConfigFile {
  models?: {
    agent?: string;
    judge?: string;
  };
  scoring?: {
    weights?: {
      discovery?: number;
      adherence?: number;
      output?: number;
    };
  };
  thresholds?: {
    resolution_rate?: number;
    min_lift?: number;
    /** Removed in v2 — detected only to warn (was: min discovery rate). */
    discovery_rate?: number;
    /** Removed in v2 — detected only to warn (was: min avg weighted score). */
    avg_score?: number;
  };
  judge?: {
    enabled?: boolean;
    model?: string;
  };
  runner?: {
    type?: string;
    timeout_ms?: number;
    concurrency?: number;
    allowed_write_dirs?: string[];
  };
  nudge?: string;
  sandbox?: string;
  output?: {
    dir?: string;
    judge_truncation?: number;
    report_truncation?: number;
  };
  ci?: {
    exit_on_failure?: boolean;
    github_summary?: boolean;
    html_report?: boolean;
  };
  cache?: {
    enabled?: boolean;
    dir?: string;
    ttl_hours?: number;
  };
}

/**
 * Load a YAML config file if it exists.
 */
async function loadConfigFile(configPath?: string): Promise<Partial<EvalConfig>> {
  const filePath = configPath || path.join(process.cwd(), 'eval.config.yaml');

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const raw = yaml.load(content) as RawConfigFile;
    if (!raw) return {};

    const config: Partial<EvalConfig> = {};

    if (raw.runner?.type) {
      if (!VALID_RUNNER_TYPES.includes(raw.runner.type as RunnerType)) {
        throw new Error(`Invalid runner type "${raw.runner.type}" in config file. Valid: ${VALID_RUNNER_TYPES.join(', ')}`);
      }
      config.runnerType = raw.runner.type as RunnerType;
    }
    if (raw.models?.agent) config.defaultAgentModel = raw.models.agent;
    if (raw.models?.judge) config.defaultJudgeModel = raw.models.judge;

    if (raw.scoring?.weights) {
      config.defaultWeights = {
        discovery: raw.scoring.weights.discovery ?? DEFAULT_CONFIG.defaultWeights.discovery,
        adherence: raw.scoring.weights.adherence ?? DEFAULT_CONFIG.defaultWeights.adherence,
        output: raw.scoring.weights.output ?? DEFAULT_CONFIG.defaultWeights.output,
      };
    }

    if (raw.thresholds?.resolution_rate !== undefined) config.resolutionThreshold = raw.thresholds.resolution_rate;
    if (raw.thresholds?.min_lift !== undefined) config.liftThreshold = raw.thresholds.min_lift;
    if (raw.thresholds?.discovery_rate !== undefined || raw.thresholds?.avg_score !== undefined) {
      console.warn('Warning: eval.config.yaml thresholds.discovery_rate/avg_score were removed in v2 and are IGNORED — use thresholds.resolution_rate / thresholds.min_lift');
    }

    if (raw.judge?.enabled !== undefined) config.judgeEnabled = raw.judge.enabled === true;
    if (raw.judge?.model) config.defaultJudgeModel = raw.judge.model;

    if (raw.runner?.timeout_ms !== undefined) config.taskTimeoutMs = raw.runner.timeout_ms;
    if (raw.runner?.concurrency !== undefined) {
      if (!Number.isInteger(raw.runner.concurrency) || raw.runner.concurrency < 0) {
        throw new Error(`Invalid runner.concurrency "${raw.runner.concurrency}" in config file. Must be a non-negative integer.`);
      }
      config.concurrency = raw.runner.concurrency;
    }
    if (raw.runner?.allowed_write_dirs) config.allowedWriteDirs = raw.runner.allowed_write_dirs;

    if (raw.nudge !== undefined) {
      if (!NUDGE_LEVELS.includes(raw.nudge as NudgeLevel)) {
        throw new Error(`Invalid nudge "${raw.nudge}" in config file. Valid: ${NUDGE_LEVELS.join(', ')}`);
      }
      config.nudge = raw.nudge as NudgeLevel;
    }

    if (raw.sandbox !== undefined) {
      if (!SANDBOX_MODES.includes(raw.sandbox as SandboxMode)) {
        throw new Error(`Invalid sandbox "${raw.sandbox}" in config file. Valid: ${SANDBOX_MODES.join(', ')}`);
      }
      config.sandbox = raw.sandbox as SandboxMode;
    }

    if (raw.output?.dir) config.outputDir = raw.output.dir;
    if (raw.output?.judge_truncation !== undefined) config.judgeOutputTruncation = raw.output.judge_truncation;
    if (raw.output?.report_truncation !== undefined) config.reportOutputTruncation = raw.output.report_truncation;

    if (raw.ci?.exit_on_failure !== undefined) config.exitOnFailure = raw.ci.exit_on_failure;
    if (raw.ci?.github_summary !== undefined) config.githubSummary = raw.ci.github_summary;
    if (raw.ci?.html_report !== undefined) config.htmlReport = raw.ci.html_report;

    if (raw.cache) {
      config.cache = {
        enabled: raw.cache.enabled ?? DEFAULT_CONFIG.cache.enabled,
        dir: raw.cache.dir ?? DEFAULT_CONFIG.cache.dir,
        ttlHours: raw.cache.ttl_hours ?? DEFAULT_CONFIG.cache.ttlHours,
      };
    }

    return config;
  } catch (err: unknown) {
    // File not found is fine — use defaults
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return {};
    }
    // Re-throw parse/validation errors
    throw err;
  }
}

/**
 * Load configuration from environment variables.
 *
 * Supported variables:
 * - EVAL_AGENT_MODEL: Model for task execution (default: 'sonnet')
 * - EVAL_JUDGE_MODEL: Model for scoring (default: 'haiku')
 * - EVAL_OUTPUT_TRUNCATION: Max chars to show judge (default: 5000)
 * - EVAL_REPORT_TRUNCATION: Max chars in reports (default: 2000)
 * - EVAL_TASK_TIMEOUT_MS: Per-task timeout in ms (default: 300000)
 * - EVAL_RUNNER_CONCURRENCY: Max concurrent tasks (default: 1, 0=unlimited)
 * - EVAL_NUDGE: Skill nudge level off|name|description|full (default: 'off')
 * - EVAL_SANDBOX: Verifier/oracle sandbox host|docker (default: 'host')
 * - EVAL_EXIT_ON_FAILURE: Exit with code 1 on failures (default: true)
 * - EVAL_OUTPUT_DIR: Directory for results (default: './results')
 * - EVAL_JUDGE: Enable LLM judge diagnostics (default: false)
 * - EVAL_RESOLUTION_THRESHOLD: Min with-skill resolution rate 0-1 (default: 0.8)
 * - EVAL_LIFT_THRESHOLD: Min macro skill lift (default: unset = not gated)
 * - EVAL_GITHUB_SUMMARY: Write GitHub Actions summary (default: false)
 * - EVAL_HTML_REPORT: Generate HTML report (default: true)
 * - EVAL_CACHE_ENABLED: Enable/disable response cache (default: true)
 * - EVAL_CACHE_DIR: Directory for cached responses (default: './results/.cache')
 * - EVAL_CACHE_TTL_HOURS: Cache entry TTL in hours (default: 168)
 */
function loadEnvConfig(): Partial<EvalConfig> {
  const config: Partial<EvalConfig> = {};

  if (process.env.EVAL_RUNNER_TYPE) {
    if (!VALID_RUNNER_TYPES.includes(process.env.EVAL_RUNNER_TYPE as RunnerType)) {
      throw new Error(`Invalid EVAL_RUNNER_TYPE "${process.env.EVAL_RUNNER_TYPE}". Valid: ${VALID_RUNNER_TYPES.join(', ')}`);
    }
    config.runnerType = process.env.EVAL_RUNNER_TYPE as RunnerType;
  }
  if (process.env.EVAL_AGENT_MODEL) config.defaultAgentModel = process.env.EVAL_AGENT_MODEL;
  if (process.env.EVAL_JUDGE_MODEL) config.defaultJudgeModel = process.env.EVAL_JUDGE_MODEL;

  const truncation = parseInt(process.env.EVAL_OUTPUT_TRUNCATION || '', 10);
  if (!isNaN(truncation)) config.judgeOutputTruncation = truncation;

  const reportTruncation = parseInt(process.env.EVAL_REPORT_TRUNCATION || '', 10);
  if (!isNaN(reportTruncation)) config.reportOutputTruncation = reportTruncation;

  const timeout = parseInt(process.env.EVAL_TASK_TIMEOUT_MS || '', 10);
  if (!isNaN(timeout)) config.taskTimeoutMs = timeout;

  const concurrencyRaw = process.env.EVAL_RUNNER_CONCURRENCY;
  if (concurrencyRaw !== undefined && concurrencyRaw !== '') {
    const concurrency = Number(concurrencyRaw);
    if (!Number.isInteger(concurrency) || concurrency < 0) {
      throw new Error(`Invalid EVAL_RUNNER_CONCURRENCY "${concurrencyRaw}". Must be a non-negative integer.`);
    }
    config.concurrency = concurrency;
  }

  if (process.env.EVAL_NUDGE) {
    if (!NUDGE_LEVELS.includes(process.env.EVAL_NUDGE as NudgeLevel)) {
      throw new Error(`Invalid EVAL_NUDGE "${process.env.EVAL_NUDGE}". Valid: ${NUDGE_LEVELS.join(', ')}`);
    }
    config.nudge = process.env.EVAL_NUDGE as NudgeLevel;
  }

  if (process.env.EVAL_SANDBOX) {
    if (!SANDBOX_MODES.includes(process.env.EVAL_SANDBOX as SandboxMode)) {
      throw new Error(`Invalid EVAL_SANDBOX "${process.env.EVAL_SANDBOX}". Valid: ${SANDBOX_MODES.join(', ')}`);
    }
    config.sandbox = process.env.EVAL_SANDBOX as SandboxMode;
  }

  if (process.env.EVAL_EXIT_ON_FAILURE !== undefined) {
    config.exitOnFailure = process.env.EVAL_EXIT_ON_FAILURE !== 'false';
  }

  if (process.env.EVAL_OUTPUT_DIR) config.outputDir = process.env.EVAL_OUTPUT_DIR;

  if (process.env.EVAL_JUDGE !== undefined) {
    config.judgeEnabled = ['true', '1'].includes(process.env.EVAL_JUDGE.toLowerCase());
  }

  const resolutionThreshold = parseFloat(process.env.EVAL_RESOLUTION_THRESHOLD || '');
  if (!isNaN(resolutionThreshold)) config.resolutionThreshold = resolutionThreshold;

  const liftThreshold = parseFloat(process.env.EVAL_LIFT_THRESHOLD || '');
  if (!isNaN(liftThreshold)) config.liftThreshold = liftThreshold;

  if (process.env.EVAL_DISCOVERY_THRESHOLD !== undefined || process.env.EVAL_SCORE_THRESHOLD !== undefined) {
    console.warn('Warning: EVAL_DISCOVERY_THRESHOLD/EVAL_SCORE_THRESHOLD were removed in v2 and are IGNORED — use EVAL_RESOLUTION_THRESHOLD / EVAL_LIFT_THRESHOLD');
  }

  if (process.env.EVAL_GITHUB_SUMMARY !== undefined) {
    config.githubSummary = process.env.EVAL_GITHUB_SUMMARY === 'true';
  }

  if (process.env.EVAL_HTML_REPORT !== undefined) {
    config.htmlReport = process.env.EVAL_HTML_REPORT.toLowerCase() !== 'false';
  }

  const cacheTtl = parseInt(process.env.EVAL_CACHE_TTL_HOURS || '', 10);
  const hasAnyCacheEnv = process.env.EVAL_CACHE_ENABLED !== undefined || process.env.EVAL_CACHE_DIR || !isNaN(cacheTtl);
  if (hasAnyCacheEnv) {
    // Only include fields explicitly set via env vars to avoid overriding YAML config
    const cacheOverrides: Partial<EvalConfig['cache']> = {};
    if (process.env.EVAL_CACHE_ENABLED !== undefined) {
      cacheOverrides.enabled = process.env.EVAL_CACHE_ENABLED !== 'false';
    }
    if (process.env.EVAL_CACHE_DIR) {
      cacheOverrides.dir = process.env.EVAL_CACHE_DIR;
    }
    if (!isNaN(cacheTtl)) {
      cacheOverrides.ttlHours = cacheTtl;
    }
    config.cache = Object.fromEntries(
      Object.entries(cacheOverrides).filter(([, v]) => v !== undefined)
    ) as EvalConfig['cache'];
  }

  return config;
}

/** Keys whose sub-fields should be merged, not replaced wholesale. */
const NESTED_CONFIG_KEYS = new Set<keyof EvalConfig>(['defaultWeights', 'cache']);

/**
 * Deep merge multiple partial configs into a full config. Nested objects
 * listed in NESTED_CONFIG_KEYS are shallow-merged so a partial override
 * doesn't clobber sibling fields.
 */
function mergeConfigs(...configs: Partial<EvalConfig>[]): EvalConfig {
  const result = { ...DEFAULT_CONFIG };

  for (const config of configs) {
    for (const [key, value] of Object.entries(config) as [keyof EvalConfig, unknown][]) {
      if (value === undefined) continue;
      if (NESTED_CONFIG_KEYS.has(key)) {
        (result as Record<string, unknown>)[key] = {
          ...(result[key] as object),
          ...(value as object),
        };
      } else {
        (result as Record<string, unknown>)[key] = value;
      }
    }
  }

  return result;
}

/**
 * Load full configuration with all sources merged.
 *
 * @param configPath - Optional path to eval.config.yaml
 * @param overrides - Optional programmatic overrides (CLI flags)
 */
export async function loadConfig(
  configPath?: string,
  overrides?: Partial<EvalConfig>
): Promise<EvalConfig> {
  const fileConfig = await loadConfigFile(configPath);
  const envConfig = loadEnvConfig();

  return mergeConfigs(fileConfig, envConfig, overrides ?? {});
}

/**
 * Load configuration synchronously (env vars + defaults only, no file).
 * Useful when you can't await — e.g., in constructors.
 */
export function loadConfigSync(overrides?: Partial<EvalConfig>): EvalConfig {
  const envConfig = loadEnvConfig();
  return mergeConfigs(envConfig, overrides ?? {});
}
