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

import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface EvalConfig {
  // Models
  defaultAgentModel: string;
  defaultJudgeModel: string;

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

  // CI/CD behavior
  exitOnFailure: boolean;
  outputDir: string;
  githubSummary: boolean;

  // Pass/fail thresholds
  discoveryThreshold: number; // 0-1, default 0.8 (80%)
  scoreThreshold: number; // 1-5, default 4.0

  // Runner
  allowedWriteDirs: string[];
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: EvalConfig = {
  defaultAgentModel: 'sonnet',
  defaultJudgeModel: 'haiku',
  defaultWeights: {
    discovery: 0.3,
    adherence: 0.4,
    output: 0.3,
  },
  judgeOutputTruncation: 5000,
  reportOutputTruncation: 2000,
  taskTimeoutMs: 300000, // 5 minutes
  exitOnFailure: true,
  outputDir: './results',
  githubSummary: false,
  discoveryThreshold: 0.8,
  scoreThreshold: 4.0,
  allowedWriteDirs: ['./results/', './fixtures/'],
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
    discovery_rate?: number;
    avg_score?: number;
  };
  runner?: {
    timeout_ms?: number;
    allowed_write_dirs?: string[];
  };
  output?: {
    dir?: string;
    judge_truncation?: number;
    report_truncation?: number;
  };
  ci?: {
    exit_on_failure?: boolean;
    github_summary?: boolean;
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

    if (raw.models?.agent) config.defaultAgentModel = raw.models.agent;
    if (raw.models?.judge) config.defaultJudgeModel = raw.models.judge;

    if (raw.scoring?.weights) {
      config.defaultWeights = {
        discovery: raw.scoring.weights.discovery ?? DEFAULT_CONFIG.defaultWeights.discovery,
        adherence: raw.scoring.weights.adherence ?? DEFAULT_CONFIG.defaultWeights.adherence,
        output: raw.scoring.weights.output ?? DEFAULT_CONFIG.defaultWeights.output,
      };
    }

    if (raw.thresholds?.discovery_rate !== undefined) config.discoveryThreshold = raw.thresholds.discovery_rate;
    if (raw.thresholds?.avg_score !== undefined) config.scoreThreshold = raw.thresholds.avg_score;

    if (raw.runner?.timeout_ms !== undefined) config.taskTimeoutMs = raw.runner.timeout_ms;
    if (raw.runner?.allowed_write_dirs) config.allowedWriteDirs = raw.runner.allowed_write_dirs;

    if (raw.output?.dir) config.outputDir = raw.output.dir;
    if (raw.output?.judge_truncation !== undefined) config.judgeOutputTruncation = raw.output.judge_truncation;
    if (raw.output?.report_truncation !== undefined) config.reportOutputTruncation = raw.output.report_truncation;

    if (raw.ci?.exit_on_failure !== undefined) config.exitOnFailure = raw.ci.exit_on_failure;
    if (raw.ci?.github_summary !== undefined) config.githubSummary = raw.ci.github_summary;

    return config;
  } catch {
    // Config file not found or invalid — that's fine
    return {};
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
 * - EVAL_EXIT_ON_FAILURE: Exit with code 1 on failures (default: true)
 * - EVAL_OUTPUT_DIR: Directory for results (default: './results')
 * - EVAL_DISCOVERY_THRESHOLD: Min discovery rate 0-1 (default: 0.8)
 * - EVAL_SCORE_THRESHOLD: Min avg score 1-5 (default: 4.0)
 * - EVAL_GITHUB_SUMMARY: Write GitHub Actions summary (default: false)
 */
function loadEnvConfig(): Partial<EvalConfig> {
  const config: Partial<EvalConfig> = {};

  if (process.env.EVAL_AGENT_MODEL) config.defaultAgentModel = process.env.EVAL_AGENT_MODEL;
  if (process.env.EVAL_JUDGE_MODEL) config.defaultJudgeModel = process.env.EVAL_JUDGE_MODEL;

  const truncation = parseInt(process.env.EVAL_OUTPUT_TRUNCATION || '', 10);
  if (!isNaN(truncation)) config.judgeOutputTruncation = truncation;

  const reportTruncation = parseInt(process.env.EVAL_REPORT_TRUNCATION || '', 10);
  if (!isNaN(reportTruncation)) config.reportOutputTruncation = reportTruncation;

  const timeout = parseInt(process.env.EVAL_TASK_TIMEOUT_MS || '', 10);
  if (!isNaN(timeout)) config.taskTimeoutMs = timeout;

  if (process.env.EVAL_EXIT_ON_FAILURE !== undefined) {
    config.exitOnFailure = process.env.EVAL_EXIT_ON_FAILURE !== 'false';
  }

  if (process.env.EVAL_OUTPUT_DIR) config.outputDir = process.env.EVAL_OUTPUT_DIR;

  const discoveryThreshold = parseFloat(process.env.EVAL_DISCOVERY_THRESHOLD || '');
  if (!isNaN(discoveryThreshold)) config.discoveryThreshold = discoveryThreshold;

  const scoreThreshold = parseFloat(process.env.EVAL_SCORE_THRESHOLD || '');
  if (!isNaN(scoreThreshold)) config.scoreThreshold = scoreThreshold;

  if (process.env.EVAL_GITHUB_SUMMARY !== undefined) {
    config.githubSummary = process.env.EVAL_GITHUB_SUMMARY === 'true';
  }

  return config;
}

/**
 * Deep merge multiple partial configs into a full config.
 */
function mergeConfigs(...configs: Partial<EvalConfig>[]): EvalConfig {
  const result = { ...DEFAULT_CONFIG };

  for (const config of configs) {
    if (config.defaultAgentModel !== undefined) result.defaultAgentModel = config.defaultAgentModel;
    if (config.defaultJudgeModel !== undefined) result.defaultJudgeModel = config.defaultJudgeModel;
    if (config.defaultWeights !== undefined) result.defaultWeights = { ...result.defaultWeights, ...config.defaultWeights };
    if (config.judgeOutputTruncation !== undefined) result.judgeOutputTruncation = config.judgeOutputTruncation;
    if (config.reportOutputTruncation !== undefined) result.reportOutputTruncation = config.reportOutputTruncation;
    if (config.taskTimeoutMs !== undefined) result.taskTimeoutMs = config.taskTimeoutMs;
    if (config.exitOnFailure !== undefined) result.exitOnFailure = config.exitOnFailure;
    if (config.outputDir !== undefined) result.outputDir = config.outputDir;
    if (config.githubSummary !== undefined) result.githubSummary = config.githubSummary;
    if (config.discoveryThreshold !== undefined) result.discoveryThreshold = config.discoveryThreshold;
    if (config.scoreThreshold !== undefined) result.scoreThreshold = config.scoreThreshold;
    if (config.allowedWriteDirs !== undefined) result.allowedWriteDirs = config.allowedWriteDirs;
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

/**
 * Get default weights for scoring dimensions.
 */
export function getDefaultWeights(config?: EvalConfig): Map<string, number> {
  const c = config ?? DEFAULT_CONFIG;
  return new Map([
    ['discovery', c.defaultWeights.discovery],
    ['adherence', c.defaultWeights.adherence],
    ['output', c.defaultWeights.output],
  ]);
}
