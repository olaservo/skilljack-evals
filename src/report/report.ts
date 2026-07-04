/**
 * Report generation for skill evaluation results.
 *
 * Generates markdown and JSON reports from combined evaluation scores.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { formatDelta, formatCategory, formatTokens, pct } from '../utils/format.js';
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
  const { discoveryPassed, adherencePassed, outputQualityPassed, passed } = evaluatePassFail(summary, config);

  // Build metadata section
  let metaSection = '';
  if (metadata) {
    const metaLines = [`**Skill Path:** \`${metadata.skillPath}\``];
    if (metadata.gitCommit) {
      metaLines.push(`**Git:** ${metadata.gitBranch}@${metadata.gitCommit}`);
    }
    if (metadata.version) metaLines.push(`**Version:** ${metadata.version}`);
    metaLines.push(`**Agent Model:** ${metadata.agentModel}`);
    metaLines.push(`**Judge Model:** ${metadata.judgeModel}`);
    metaSection = metaLines.join('\n') + '\n';
  }

  // Build report
  const runsLine = numRuns > 1 ? `**Runs per Task:** ${numRuns}\n` : '';
  const compareLine = comparison
    ? `**Mode:** Comparison (vs ${comparison.summary.baselineLabel})\n`
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
| **Discovery Accuracy** | ${(summary.discoveryAccuracy * 100).toFixed(1)}%${summary.stddev ? ` \u00B1 ${(summary.stddev.discovery * 100).toFixed(1)}%` : ''} | ${(config.discoveryThreshold * 100).toFixed(0)}% | ${discoveryPassed ? 'PASS' : 'FAIL'} |
| **Avg Adherence Score** | ${summary.avgAdherence.toFixed(2)}/5.0${summary.stddev ? ` \u00B1 ${summary.stddev.adherence.toFixed(2)}` : ''} | ${config.scoreThreshold.toFixed(1)} | ${adherencePassed ? 'PASS' : 'FAIL'} |
| **Avg Output Quality** | ${summary.avgOutputQuality.toFixed(2)}/5.0${summary.stddev ? ` \u00B1 ${summary.stddev.outputQuality.toFixed(2)}` : ''} | ${config.scoreThreshold.toFixed(1)} | ${outputQualityPassed ? 'PASS' : 'FAIL'} |
| **Avg Weighted Score** | ${summary.avgWeightedScore.toFixed(2)}${summary.stddev ? ` \u00B1 ${summary.stddev.weightedScore.toFixed(2)}` : ''} | | |
| **Total Duration** | ${(summary.totalDurationMs / 1000).toFixed(1)}s | | |
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

#### Scores

| Dimension | Score | Status |
|-----------|-------|--------|
| Discovery | ${score.stddev ? `${(score.discovery * 100).toFixed(0)}% \u00B1 ${(score.stddev.discovery * 100).toFixed(0)}%` : `${Math.round(score.discovery)}`} | ${score.discovery >= 1 ? 'PASS' : 'FAIL'} |
| Adherence | ${score.adherence.toFixed(1)}/5${score.stddev ? ` \u00B1 ${score.stddev.adherence.toFixed(1)}` : ''} | ${score.adherence >= 4 ? 'PASS' : 'FAIL'} |
| Output Quality | ${score.outputQuality.toFixed(1)}/5${score.stddev ? ` \u00B1 ${score.stddev.outputQuality.toFixed(1)}` : ''} | ${score.outputQuality >= 4 ? 'PASS' : 'FAIL'} |
| **Weighted** | **${score.weightedScore.toFixed(2)}${score.stddev ? ` \u00B1 ${score.stddev.weightedScore.toFixed(2)}` : ''}** | |
${isFlaky(score.stddev) ? `\n> **Warning: Potentially Flaky** \u2014 High variance across runs (adherence \u03C3=${score.stddev!.adherence.toFixed(2)}, output \u03C3=${score.stddev!.outputQuality.toFixed(2)})
> _Only adherence and output quality are checked: discovery (0/1) and weighted score (0-1) cannot exceed the threshold._\n` : ''}
**Failure Category:** ${formatCategory(score.failureCategory)}
`;

    // Show deterministic results if available
    if (score.deterministic) {
      report += `\n**Deterministic Check:** ${score.deterministic.passed ? 'PASS' : 'FAIL'}\n`;
      for (const detail of score.deterministic.details) {
        report += `- ${detail}\n`;
      }
    }

    // Show checklist results if available
    if ((score.checklistResults ?? []).length > 0) {
      const checklistPassed = (score.checklistResults ?? []).filter((cr) => cr.passed).length;
      report += `\n**Checklist:** ${checklistPassed}/${(score.checklistResults ?? []).length} passed\n\n`;
      for (const cr of score.checklistResults ?? []) {
        const safeItem = cr.item.replace(/[|_*`]/g, '\\$&');
        report += `- ${cr.passed ? 'PASS' : 'FAIL'}: **${safeItem}**\n`;
        if (cr.evidence?.trim()) {
          const safeEvidence = cr.evidence.trim().replace(/[|_*`]/g, '\\$&');
          report += `  - _${safeEvidence}_\n`;
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
<summary>Per-run breakdown (${runDetails[i].length} runs)</summary>

| Run | Discovery | Adherence | Output | Weighted | Tokens | Skills Loaded |
|-----|-----------|-----------|--------|----------|--------|---------------|
`;
      for (let r = 0; r < runDetails[i].length; r++) {
        const rd = runDetails[i][r];
        const skills = rd.result.skillLoads.length > 0 ? rd.result.skillLoads.join(', ') : 'none';
        report += `| ${r + 1} | ${rd.score.discovery} | ${rd.score.adherence}/5 | ${rd.score.outputQuality}/5 | ${rd.score.weightedScore.toFixed(2)} | ${formatTokens(rd.result.tokens?.total)} | ${skills} |\n`;
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
  const { passed } = evaluatePassFail(summary, config);
  const failureReasons = computeFailureReasons(summary, config);

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
  discoveryPassed: boolean;
  adherencePassed: boolean;
  outputQualityPassed: boolean;
  passed: boolean;
}

/**
 * Evaluate whether a summary passes the configured thresholds.
 */
export function evaluatePassFail(
  summary: EvaluationSummary,
  config: EvalConfig,
): PassFailResult {
  const discoveryPassed = summary.discoveryAccuracy >= config.discoveryThreshold;
  const adherencePassed = summary.avgAdherence >= config.scoreThreshold;
  const outputQualityPassed = summary.avgOutputQuality >= config.scoreThreshold;
  return {
    discoveryPassed,
    adherencePassed,
    outputQualityPassed,
    passed: discoveryPassed && adherencePassed && outputQualityPassed,
  };
}

/**
 * Build human-readable failure reasons for a summary that did not pass.
 */
export function computeFailureReasons(
  summary: EvaluationSummary,
  config: EvalConfig,
): string[] {
  const reasons: string[] = [];
  if (summary.discoveryAccuracy < config.discoveryThreshold) {
    reasons.push(
      `Discovery rate ${(summary.discoveryAccuracy * 100).toFixed(1)}% below threshold ${(config.discoveryThreshold * 100).toFixed(0)}%`,
    );
  }
  if (summary.avgAdherence < config.scoreThreshold) {
    reasons.push(
      `Avg adherence ${summary.avgAdherence.toFixed(2)} below threshold ${config.scoreThreshold}`,
    );
  }
  if (summary.avgOutputQuality < config.scoreThreshold) {
    reasons.push(
      `Avg output quality ${summary.avgOutputQuality.toFixed(2)} below threshold ${config.scoreThreshold}`,
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

  // With multi-run, discovery is a float (0-1) per task representing the rate.
  // Average across tasks to get overall discovery accuracy.
  const avgDiscovery = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.discovery, 0) / totalTasks
    : 0;

  const avgAdherence = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.adherence, 0) / totalTasks
    : 0;
  const avgOutputQuality = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.outputQuality, 0) / totalTasks
    : 0;
  const avgWeightedScore = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.weightedScore, 0) / totalTasks
    : 0;

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
    discoveryAccuracy: avgDiscovery,
    avgAdherence,
    avgOutputQuality,
    avgWeightedScore,
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
      summary.stddev = {
        discovery: tasksWithStddev.reduce((sum, s) => sum + s.stddev!.discovery, 0) / tasksWithStddev.length,
        adherence: tasksWithStddev.reduce((sum, s) => sum + s.stddev!.adherence, 0) / tasksWithStddev.length,
        outputQuality: tasksWithStddev.reduce((sum, s) => sum + s.stddev!.outputQuality, 0) / tasksWithStddev.length,
        weightedScore: tasksWithStddev.reduce((sum, s) => sum + s.stddev!.weightedScore, 0) / tasksWithStddev.length,
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
| Discovery | ${(ws.discoveryAccuracy * 100).toFixed(0)}% | ${(bs.discoveryAccuracy * 100).toFixed(0)}% | ${formatDelta(d.discoveryAccuracyDelta * 100, 0)}% | ${qualityImpact(d.discoveryAccuracyDelta, DISCOVERY_IMPACT_THRESHOLD)} |
| Avg Adherence | ${ws.avgAdherence.toFixed(2)}/5 | ${bs.avgAdherence.toFixed(2)}/5 | ${formatDelta(d.avgAdherenceDelta)} | ${qualityImpact(d.avgAdherenceDelta, ADHERENCE_IMPACT_THRESHOLD)} |
| Avg Output Quality | ${ws.avgOutputQuality.toFixed(2)}/5 | ${bs.avgOutputQuality.toFixed(2)}/5 | ${formatDelta(d.avgOutputQualityDelta)} | ${qualityImpact(d.avgOutputQualityDelta, OUTPUT_QUALITY_IMPACT_THRESHOLD)} |
| Weighted Score | ${ws.avgWeightedScore.toFixed(2)} | ${bs.avgWeightedScore.toFixed(2)} | ${formatDelta(d.avgWeightedScoreDelta)} | ${qualityImpact(d.avgWeightedScoreDelta, WEIGHTED_SCORE_IMPACT_THRESHOLD)} |
| Duration | ${(ws.totalDurationMs / 1000).toFixed(1)}s | ${(bs.totalDurationMs / 1000).toFixed(1)}s | ${formatDelta(d.totalDurationDeltaMs / 1000, 1)}s | ${durationImpact(d.totalDurationDeltaMs)} |
| Cost | $${ws.totalCostUsd.toFixed(4)} | $${bs.totalCostUsd.toFixed(4)} | $${formatDelta(d.totalCostDeltaUsd, 4)} | ${costImpact(d.totalCostDeltaUsd)} |
| Tokens | ${formatTokens(ws.totalTokens)} | ${formatTokens(bs.totalTokens)} | ${d.totalTokensDelta !== undefined ? formatDelta(d.totalTokensDelta, 0) : 'n/a'} | ${d.totalTokensDelta !== undefined ? tokenImpact(d.totalTokensDelta) : ''} |

### Per-Task Comparison

| Task | Adherence (W / B / Delta) | Output (W / B / Delta) | Weighted (W / B / Delta) |
|------|--------------------------|----------------------|------------------------|
`;

  for (const t of tasks) {
    const w = t.withSkill.score;
    const b = t.withoutSkill.score;
    section += `| ${t.taskId} | ${w.adherence.toFixed(1)} / ${b.adherence.toFixed(1)} / ${formatDelta(t.delta.adherenceDelta, 1)} | ${w.outputQuality.toFixed(1)} / ${b.outputQuality.toFixed(1)} / ${formatDelta(t.delta.outputQualityDelta, 1)} | ${w.weightedScore.toFixed(2)} / ${b.weightedScore.toFixed(2)} / ${formatDelta(t.delta.weightedScoreDelta)} |\n`;
  }

  return section;
}

/** Minimum delta to classify as positive/negative impact, calibrated to ~5% of each metric's range. */
export const DISCOVERY_IMPACT_THRESHOLD = 0.05;       // 5% of 0-1 range
export const ADHERENCE_IMPACT_THRESHOLD = 0.20;       // 5% of 1-5 range (range = 4)
export const OUTPUT_QUALITY_IMPACT_THRESHOLD = 0.20;  // 5% of 1-5 range (range = 4)
export const WEIGHTED_SCORE_IMPACT_THRESHOLD = 0.05;  // 5% of 0-1 range
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
