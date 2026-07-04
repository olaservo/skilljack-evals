/**
 * Report generation for skill evaluation results.
 *
 * Generates markdown and JSON reports from combined evaluation scores.
 * Headline metrics are reward-authoritative: resolution rate (with CI),
 * pass@k, skill lift, and skill invocation rate. Judge output renders in a
 * clearly-labeled Diagnostics section only when the judge ran.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { formatDelta, formatCategory, formatTokens, pct } from '../utils/format.js';
import { binomialCI, passAtK, resolutionRate } from '../score/metrics.js';
import type {
  SkillEvaluation,
  TaskResult,
  CombinedScore,
  ComparisonResult,
  EvaluationReport,
  EvaluationSummary,
  FailureBreakdown,
  FailureCategory,
  ReportMetadata,
  HumanFeedback,
  ComparisonData,
  BlindComparisonData,
} from '../types.js';
import { loadConfigSync, type EvalConfig } from '../config.js';
import { isFlaky } from '../scorer/aggregator.js';
import { formatComparisonMarkdown } from './comparison.js';

export interface ReportOptions {
  evaluation: SkillEvaluation;
  results: TaskResult[];
  scores: CombinedScore[];
  outputPath?: string;
  metadata?: ReportMetadata;
  numRuns?: number;
  runDetails?: Array<{ result: TaskResult; score: CombinedScore }>[];
  humanFeedback?: HumanFeedback;
  comparison?: ComparisonData;
  blindComparison?: BlindComparisonData;
  crossIterationComparison?: ComparisonResult;
  /** Pre-loaded config with overrides applied. Falls back to loadConfigSync() if omitted. */
  config?: EvalConfig;
}

/** Per-task trial pass flags: aggregated trials when present, else the single trial. */
export function trialFlags(score: CombinedScore): boolean[] {
  return score.trials?.passed ?? [score.passed];
}

/** Format a resolution CI as "low–high %" for display. */
function formatCI(summary: EvaluationSummary): string {
  const { low, high } = summary.resolutionCI;
  return `${(low * 100).toFixed(0)}–${(high * 100).toFixed(0)}%`;
}

function passedRatio(score: CombinedScore): string {
  const flags = trialFlags(score);
  return `${flags.filter(Boolean).length}/${flags.length}`;
}

/**
 * Generate a markdown report from evaluation results.
 */
export async function generateReport(options: ReportOptions): Promise<string> {
  const { evaluation, results, scores, outputPath, metadata, runDetails, humanFeedback, comparison, blindComparison, crossIterationComparison } = options;
  const numRuns = options.numRuns ?? 1;
  const config = options.config ?? loadConfigSync();
  const totalTasks = evaluation.tasks.length;
  const summary = computeSummary(results, scores, numRuns);
  const failureBreakdown = computeFailureBreakdown(scores);
  const skillLift = comparison?.summary.delta.resolutionRateDelta;
  const { resolutionPassed, liftPassed, passed } = evaluatePassFail(summary, config, skillLift);
  const judgeRan = scores.some((s) => s.judge);

  // Build metadata section
  let metaSection = '';
  if (metadata) {
    const metaLines = [`**Skill Path:** \`${metadata.skillPath}\``];
    if (metadata.gitCommit) {
      metaLines.push(`**Git:** ${metadata.gitBranch}@${metadata.gitCommit}`);
    }
    if (metadata.version) metaLines.push(`**Version:** ${metadata.version}`);
    metaLines.push(`**Agent Model:** ${metadata.agentModel}`);
    if (judgeRan) metaLines.push(`**Judge Model:** ${metadata.judgeModel}`);
    metaSection = metaLines.join('\n') + '\n';
  }

  // Build report
  const runsLine = numRuns > 1 ? `**Trials per Task:** ${numRuns}\n` : '';
  const compareLine = comparison
    ? `**Mode:** Paired baseline (vs ${comparison.summary.baselineLabel})\n`
    : '';

  const liftRow = skillLift !== undefined
    ? `| **Skill Lift** | ${formatDelta(skillLift * 100, 1)}% | ${config.liftThreshold !== undefined ? formatDelta(config.liftThreshold * 100, 1) + '%' : ''} | ${liftPassed === undefined ? '' : liftPassed ? 'PASS' : 'FAIL'} |\n`
    : '';
  const invocationRow = summary.invocationRate !== undefined
    ? `| **Skill Invocation Rate** | ${(summary.invocationRate * 100).toFixed(1)}% | | |\n`
    : '';

  let report = `# Skill Evaluation Report: ${evaluation.skillName}

**Generated:** ${new Date().toISOString()}
**Total Tasks:** ${totalTasks}
${runsLine}${compareLine}**Result:** ${passed ? 'PASS' : 'FAIL'}
${metaSection}
---

## Summary

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| **Resolution Rate** | ${(summary.resolutionRate * 100).toFixed(1)}% (CI ${formatCI(summary)}) | ${(config.resolutionThreshold * 100).toFixed(0)}% | ${resolutionPassed ? 'PASS' : 'FAIL'} |
| **Pass@${numRuns}** | ${(summary.passAtK * 100).toFixed(1)}% | | |
${liftRow}${invocationRow}| **Total Duration** | ${(summary.totalDurationMs / 1000).toFixed(1)}s | | |
| **Total Cost** | $${summary.totalCostUsd.toFixed(4)} | | |
| **Total Tokens** | ${formatTokens(summary.totalTokens)} | | |

## Failure Analysis

| Category | Count | Percentage |
|----------|-------|------------|
`;

  for (const fb of failureBreakdown) {
    const displayCat = fb.category === 'none' ? 'No Failure' : formatCategory(fb.category);
    report += `| ${displayCat} | ${fb.count} | ${fb.percentage.toFixed(1)}% |\n`;
  }

  // Human Review section (only when feedback provided)
  if (humanFeedback && Object.keys(humanFeedback).length > 0) {
    report += `\n## Human Review\n\n`;
    report += `| Task | Feedback | Addressed? |\n`;
    report += `|------|----------|------------|\n`;

    for (const [taskId, feedbackText] of Object.entries(humanFeedback)) {
      const score = scores.find(s => s.taskId === taskId);
      const addressed = score?.judge?.feedbackAddressed === true ? 'Yes'
        : score?.judge?.feedbackAddressed === false ? 'No'
        : 'N/A';
      const sanitized = feedbackText.replace(/\n/g, ' ').replace(/\|/g, '\\|');
      const truncated = sanitized.length > 80
        ? sanitized.slice(0, 77) + '...'
        : sanitized;
      const sanitizedId = taskId.replace(/\|/g, '\\|');
      report += `| ${sanitizedId} | ${truncated} | ${addressed} |\n`;
    }
  }

  if (comparison) {
    report += generateComparisonSection(comparison);
  }

  if (blindComparison) {
    report += generateBlindComparisonSection(blindComparison);
  }

  if (crossIterationComparison) {
    report += '\n---\n\n';
    report += formatComparisonMarkdown(crossIterationComparison);
  }

  report += `\n---\n\n## Task Details\n\n`;

  for (let i = 0; i < evaluation.tasks.length; i++) {
    const task = evaluation.tasks[i];
    const result = results[i];
    const score = scores[i];

    const loadedSkills = result.skillLoads.length > 0
      ? result.skillLoads.map((s) => `\`${s}\``).join(', ')
      : 'None';

    report += `### Task ${i + 1}: ${task.id}

**Prompt:** ${task.prompt}

**Expected Skill:** \`${task.expectedSkillLoad}\`
**Loaded Skills:** ${loadedSkills}

**Passed:** ${passedRatio(score)} trial(s)${score.stddev && isFlaky(score.stddev) ? ' — **potentially flaky** (trials disagree)' : ''}
**Reward:** ${score.reward.toFixed(2)}
${score.invocation !== undefined ? `**Skill Invoked:** ${(score.invocation * 100).toFixed(0)}% of trials\n` : ''}**Failure Category:** ${formatCategory(score.failureCategory)}
`;

    // Show deterministic results if available
    if (score.deterministic) {
      report += `\n**Deterministic Check:** ${score.deterministic.passed ? 'PASS' : 'FAIL'}\n`;
      for (const detail of score.deterministic.details) {
        report += `- ${detail}\n`;
      }
    }

    // Judge diagnostics — clearly labeled, only when the judge ran.
    if (score.judge) {
      report += `\n#### Diagnostics (LLM judge — does not affect pass/fail)\n\n`;
      if (score.adherence !== undefined && score.outputQuality !== undefined) {
        report += `| Dimension | Rating |\n|-----------|--------|\n`;
        report += `| Adherence | ${score.adherence.toFixed(1)}/5${score.stddev?.adherence !== undefined ? ` ± ${score.stddev.adherence.toFixed(1)}` : ''} |\n`;
        report += `| Output Quality | ${score.outputQuality.toFixed(1)}/5${score.stddev?.outputQuality !== undefined ? ` ± ${score.stddev.outputQuality.toFixed(1)}` : ''} |\n`;
      }

      // Show assertion grading if available
      if ((score.checklistResults ?? []).length > 0) {
        const checklistPassed = (score.checklistResults ?? []).filter((cr) => cr.passed).length;
        report += `\n**Assertions:** ${checklistPassed}/${(score.checklistResults ?? []).length} passed\n\n`;
        for (const cr of score.checklistResults ?? []) {
          const safeItem = cr.item.replace(/[|_*`]/g, '\\$&');
          report += `- ${cr.passed ? 'PASS' : 'FAIL'}: **${safeItem}**\n`;
          if (cr.evidence?.trim()) {
            const safeEvidence = cr.evidence.trim().replace(/[|_*`]/g, '\\$&');
            report += `  - _${safeEvidence}_\n`;
          }
        }
      }
    }

    // Show human feedback if present for this task
    if (humanFeedback && humanFeedback[task.id]) {
      report += `\n**Human Feedback:**\n> ${humanFeedback[task.id].replace(/\n/g, '\n> ')}\n`;
      if (score.judge?.feedbackAddressed !== undefined) {
        report += `**Feedback Addressed:** ${score.judge.feedbackAddressed ? 'Yes' : 'No'}\n`;
      }
    }

    report += `\n**Reasoning:** ${score.reasoning || 'No reasoning provided'}

<details>
<summary>Agent Output (click to expand)</summary>

\`\`\`
${result.output.slice(0, config.reportOutputTruncation) || '(no output)'}
\`\`\`

</details>

**Metrics:** Duration: ${(result.durationMs / 1000).toFixed(1)}s | Turns: ${result.numTurns} | Cost: $${result.costUsd.toFixed(4)} | Tokens: ${formatTokens(result.tokens?.total)}
`;

    // Per-run breakdown
    if (runDetails && runDetails[i] && runDetails[i].length > 1) {
      report += `
<details>
<summary>Per-trial breakdown (${runDetails[i].length} trials)</summary>

| Trial | Passed | Reward | Tokens | Skills Loaded |
|-------|--------|--------|--------|---------------|
`;
      for (let r = 0; r < runDetails[i].length; r++) {
        const rd = runDetails[i][r];
        const skills = rd.result.skillLoads.length > 0 ? rd.result.skillLoads.join(', ') : 'none';
        report += `| ${r + 1} | ${rd.score.passed ? 'PASS' : 'FAIL'} | ${rd.score.reward.toFixed(2)} | ${formatTokens(rd.result.tokens?.total)} | ${skills} |\n`;
      }
      report += `\n</details>\n`;
    }

    report += `\n---\n\n`;
  }

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, report);
    console.log(`Report saved to: ${outputPath}`);
  }

  return report;
}

/**
 * Generate JSON report for programmatic analysis.
 */
export async function generateJsonResults(options: ReportOptions): Promise<EvaluationReport> {
  const { evaluation, results, scores, outputPath, metadata, runDetails, humanFeedback, comparison, blindComparison, crossIterationComparison } = options;
  const numRuns = options.numRuns ?? 1;
  const config = options.config ?? loadConfigSync();
  const summary = computeSummary(results, scores, numRuns);
  const failureBreakdown = computeFailureBreakdown(scores);
  const skillLift = comparison?.summary.delta.resolutionRateDelta;
  const { passed } = evaluatePassFail(summary, config, skillLift);
  const failureReasons = computeFailureReasons(summary, config, skillLift);

  const report: EvaluationReport = {
    skillName: evaluation.skillName,
    timestamp: new Date().toISOString(),
    passed,
    failureReasons,
    metadata: metadata ? {
      skillPath: metadata.skillPath,
      gitCommit: metadata.gitCommit,
      gitBranch: metadata.gitBranch,
      version: metadata.version,
      runnerType: metadata.runnerType,
      agentModel: metadata.agentModel,
      judgeModel: metadata.judgeModel,
    } : undefined,
    summary,
    failureBreakdown,
    tasks: evaluation.tasks.map((task, i) => ({
      task,
      result: results[i],
      score: scores[i],
      runDetails: runDetails?.[i],
    })),
    humanFeedback: humanFeedback && Object.keys(humanFeedback).length > 0
      ? humanFeedback
      : undefined,
    comparison,
    blindComparison,
    crossIterationComparison,
  };

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`JSON results saved to: ${outputPath}`);
  }

  return report;
}

/**
 * Pass/fail evaluation against configured thresholds.
 */
export interface PassFailResult {
  resolutionPassed: boolean;
  /** Undefined when lift is not gated (no threshold configured or no baseline ran). */
  liftPassed?: boolean;
  passed: boolean;
}

/**
 * Evaluate whether a summary passes the configured thresholds.
 *
 * @param skillLift - Macro skill lift from a paired baseline run; lift gating
 *                    only applies when both a threshold and a lift are present.
 */
export function evaluatePassFail(
  summary: EvaluationSummary,
  config: EvalConfig,
  skillLift?: number,
): PassFailResult {
  const resolutionPassed = summary.resolutionRate >= config.resolutionThreshold;
  const liftPassed = config.liftThreshold !== undefined && skillLift !== undefined
    ? skillLift >= config.liftThreshold
    : undefined;
  return {
    resolutionPassed,
    liftPassed,
    passed: resolutionPassed && liftPassed !== false,
  };
}

/**
 * Build human-readable failure reasons for a summary that did not pass.
 */
export function computeFailureReasons(
  summary: EvaluationSummary,
  config: EvalConfig,
  skillLift?: number,
): string[] {
  const reasons: string[] = [];
  if (summary.resolutionRate < config.resolutionThreshold) {
    reasons.push(
      `Resolution rate ${(summary.resolutionRate * 100).toFixed(1)}% below threshold ${(config.resolutionThreshold * 100).toFixed(0)}%`,
    );
  }
  if (config.liftThreshold !== undefined && skillLift !== undefined && skillLift < config.liftThreshold) {
    reasons.push(
      `Skill lift ${formatDelta(skillLift * 100, 1)}% below threshold ${formatDelta(config.liftThreshold * 100, 1)}%`,
    );
  }
  return reasons;
}

/**
 * Compute summary statistics from combined scores.
 */
export function computeSummary(
  results: TaskResult[],
  scores: CombinedScore[],
  numRuns = 1
): EvaluationSummary {
  const totalTasks = scores.length;

  // Per-task trial flags (aggregated scores carry per-trial arrays).
  const perTaskFlags = scores.map(trialFlags);
  const perTaskRates = perTaskFlags.map(resolutionRate);
  const avgResolution = totalTasks > 0
    ? perTaskRates.reduce((sum, v) => sum + v, 0) / totalTasks
    : 0;
  const totalTrials = perTaskFlags.reduce((sum, flags) => sum + flags.length, 0);
  const passAtKRate = totalTasks > 0
    ? perTaskFlags.filter(passAtK).length / totalTasks
    : 0;

  const invocations = scores
    .map((s) => s.invocation)
    .filter((v): v is number => v !== undefined);
  const invocationRate = invocations.length > 0
    ? invocations.reduce((sum, v) => sum + v, 0) / invocations.length
    : undefined;

  const adherences = scores.map((s) => s.adherence).filter((v): v is number => v !== undefined);
  const outputs = scores.map((s) => s.outputQuality).filter((v): v is number => v !== undefined);

  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let tokenSum = 0;
  let hasAllTokens = results.length > 0;
  for (const r of results) {
    totalDurationMs += r.durationMs;
    totalCostUsd += r.costUsd;
    if (r.tokens) tokenSum += r.tokens.total;
    else hasAllTokens = false;
  }

  const summary: EvaluationSummary = {
    totalTasks,
    numRuns,
    resolutionRate: avgResolution,
    resolutionCI: binomialCI(avgResolution, totalTrials),
    passAtK: passAtKRate,
    invocationRate,
    avgAdherence: adherences.length > 0
      ? adherences.reduce((sum, v) => sum + v, 0) / adherences.length
      : undefined,
    avgOutputQuality: outputs.length > 0
      ? outputs.reduce((sum, v) => sum + v, 0) / outputs.length
      : undefined,
    totalDurationMs,
    totalCostUsd,
    totalTokens: hasAllTokens ? tokenSum : undefined,
  };

  // Compute summary-level stddev as the mean of per-task stddevs (cross-run variability).
  // Note: this is an average of stddevs, not a true pooled stddev. It answers
  // "on average, how much do individual task scores vary across runs."
  if (numRuns >= 2) {
    const tasksWithStddev = scores.filter(s => s.stddev);
    if (tasksWithStddev.length > 0) {
      const meanOf = (values: Array<number | undefined>): number | undefined => {
        const defined = values.filter((v): v is number => v !== undefined);
        return defined.length > 0 ? defined.reduce((sum, v) => sum + v, 0) / defined.length : undefined;
      };
      summary.stddev = {
        reward: tasksWithStddev.reduce((sum, s) => sum + s.stddev!.reward, 0) / tasksWithStddev.length,
        discovery: tasksWithStddev.reduce((sum, s) => sum + s.stddev!.discovery, 0) / tasksWithStddev.length,
        adherence: meanOf(tasksWithStddev.map((s) => s.stddev!.adherence)),
        outputQuality: meanOf(tasksWithStddev.map((s) => s.stddev!.outputQuality)),
      };
    }
  }

  return summary;
}

/**
 * Compute failure category breakdown.
 */
export function computeFailureBreakdown(scores: CombinedScore[]): FailureBreakdown[] {
  const counts = new Map<string, number>();
  for (const score of scores) {
    const cat = score.failureCategory || 'none';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }

  const total = scores.length;
  return Array.from(counts.entries())
    .map(([category, count]) => ({
      category: category as FailureCategory,
      count,
      percentage: total > 0 ? (count / total) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}



/**
 * Generate the comparison section for the markdown report.
 */
function generateComparisonSection(comparison: ComparisonData): string {
  const { summary, tasks } = comparison;
  const ws = summary.withSkill;
  const bs = summary.withoutSkill;
  const d = summary.delta;

  let section = `
---

## Skill Impact Analysis

**Baseline:** ${summary.baselineLabel}

| Metric | With Skill | Baseline | Delta | Impact |
|--------|-----------|----------|-------|--------|
| Resolution Rate | ${(ws.resolutionRate * 100).toFixed(0)}% | ${(bs.resolutionRate * 100).toFixed(0)}% | ${formatDelta(d.resolutionRateDelta * 100, 0)}% | ${qualityImpact(d.resolutionRateDelta, RESOLUTION_IMPACT_THRESHOLD)} |
| Pass@k | ${(ws.passAtK * 100).toFixed(0)}% | ${(bs.passAtK * 100).toFixed(0)}% | ${formatDelta(d.passAtKDelta * 100, 0)}% | ${qualityImpact(d.passAtKDelta, RESOLUTION_IMPACT_THRESHOLD)} |
| Duration | ${(ws.totalDurationMs / 1000).toFixed(1)}s | ${(bs.totalDurationMs / 1000).toFixed(1)}s | ${formatDelta(d.totalDurationDeltaMs / 1000, 1)}s | ${durationImpact(d.totalDurationDeltaMs)} |
| Cost | $${ws.totalCostUsd.toFixed(4)} | $${bs.totalCostUsd.toFixed(4)} | $${formatDelta(d.totalCostDeltaUsd, 4)} | ${costImpact(d.totalCostDeltaUsd)} |
| Tokens | ${formatTokens(ws.totalTokens)} | ${formatTokens(bs.totalTokens)} | ${d.totalTokensDelta !== undefined ? formatDelta(d.totalTokensDelta, 0) : 'n/a'} | ${d.totalTokensDelta !== undefined ? tokenImpact(d.totalTokensDelta) : ''} |

### Per-Task Comparison

| Task | With Skill Passed | Baseline Passed | Lift |
|------|-------------------|-----------------|------|
`;

  for (const t of tasks) {
    const w = t.withSkill.score;
    const b = t.withoutSkill.score;
    section += `| ${t.taskId} | ${passedRatio(w)} | ${passedRatio(b)} | ${formatDelta(t.delta.lift * 100, 0)}% |\n`;
  }

  return section;
}

/** Minimum resolution-rate/lift delta to classify as positive/negative impact. */
export const RESOLUTION_IMPACT_THRESHOLD = 0.05; // 5% of 0-1 range
/** Minimum duration delta (ms) to classify as slower/faster. */
const DURATION_IMPACT_THRESHOLD_MS = 1000;
/** Minimum cost delta (USD) to classify as higher/lower. */
const COST_IMPACT_THRESHOLD_USD = 0.0001;

export function qualityImpact(delta: number, threshold: number): 'Positive' | 'Negative' | 'Neutral' {
  if (delta > threshold) return 'Positive';
  if (delta < -threshold) return 'Negative';
  return 'Neutral';
}

function durationImpact(deltaMs: number): string {
  if (deltaMs > DURATION_IMPACT_THRESHOLD_MS) return 'Slower';
  if (deltaMs < -DURATION_IMPACT_THRESHOLD_MS) return 'Faster';
  return 'Similar';
}

function costImpact(delta: number): string {
  if (delta > COST_IMPACT_THRESHOLD_USD) return 'Higher';
  if (delta < -COST_IMPACT_THRESHOLD_USD) return 'Lower';
  return 'Similar';
}

// 1000 tokens ≈ $0.003 at Sonnet input rates — coarse enough to ignore whitespace-level deltas.
const TOKEN_IMPACT_THRESHOLD = 1000;

function tokenImpact(delta: number): string {
  if (delta > TOKEN_IMPACT_THRESHOLD) return 'Higher';
  if (delta < -TOKEN_IMPACT_THRESHOLD) return 'Lower';
  return 'Similar';
}

/**
 * Generate the blind comparison section for the markdown report.
 */
function generateBlindComparisonSection(blind: BlindComparisonData): string {
  const a = blind.aggregate;
  const evaluated = blind.tasks.length - a.failedCount;

  let section = `
---

## Blind A/B Comparison

The judge evaluated both outputs without knowing which used the skill.
Assignment shows the label order: with-skill / without-skill (e.g. A/B means A = with-skill, B = without-skill).

| Preference | Count | Percentage |
|------------|-------|------------|
| With-skill preferred | ${a.withSkillPreferred} | ${pct(a.withSkillPreferred, evaluated)}% |
| Without-skill preferred | ${a.withoutSkillPreferred} | ${pct(a.withoutSkillPreferred, evaluated)}% |
| Tie | ${a.ties} | ${pct(a.ties, evaluated)}% |

### Per-Task Blind Results

| Task | Assignment | A Instr. Following | A Output | B Instr. Following | B Output | Preferred | Condition | Bias? |
|------|------------|---------------------|----------|---------------------|----------|-----------|-----------|-------|
`;

  for (const t of blind.tasks) {
    const labels = t.withSkillLabel === 'A' ? 'A/B' : 'B/A';
    const aInstr = t.failed || !t.outputA ? 'N/A' : `${t.outputA.instructionFollowing}/5`;
    const aOut = t.failed || !t.outputA ? 'N/A' : `${t.outputA.outputQuality}/5`;
    const bInstr = t.failed || !t.outputB ? 'N/A' : `${t.outputB.instructionFollowing}/5`;
    const bOut = t.failed || !t.outputB ? 'N/A' : `${t.outputB.outputQuality}/5`;
    section += `| ${t.taskId} | ${labels} | ${aInstr} | ${aOut} | ${bInstr} | ${bOut} | ${t.preferred} | ${t.preferredCondition} | ${t.biasSignal ? 'Yes' : 'No'} |\n`;
  }

  if (a.biasSignalCount > 0) {
    section += `\n> **Bias Alert:** ${a.biasSignalCount} task(s) show bias signals where the blind comparison disagrees with standard scoring. This may indicate the standard judge is biased by knowing which output used the skill.\n`;
  }

  if (a.failedCount > 0) {
    section += `\n> **Warning:** ${a.failedCount} blind judge call(s) failed and were excluded from preference counts.\n`;
  }

  return section;
}
