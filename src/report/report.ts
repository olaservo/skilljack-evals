/**
 * Report generation for skill evaluation results.
 *
 * Generates markdown and JSON reports from combined evaluation scores.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  SkillEvaluation,
  TaskResult,
  CombinedScore,
  EvaluationReport,
  EvaluationSummary,
  FailureBreakdown,
  FailureCategory,
  ReportMetadata,
} from '../types.js';
import { loadConfigSync } from '../config.js';

/**
 * Generate a markdown report from evaluation results.
 */
export async function generateReport(
  evaluation: SkillEvaluation,
  results: TaskResult[],
  scores: CombinedScore[],
  outputPath?: string,
  metadata?: ReportMetadata
): Promise<string> {
  const config = loadConfigSync();
  const totalTasks = evaluation.tasks.length;
  const summary = computeSummary(results, scores);
  const failureBreakdown = computeFailureBreakdown(scores);

  // Determine pass/fail
  const discoveryPassed = summary.discoveryAccuracy >= config.discoveryThreshold;
  const scorePassed = summary.avgAdherence >= config.scoreThreshold && summary.avgOutputQuality >= config.scoreThreshold;
  const passed = discoveryPassed && scorePassed;

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
  let report = `# Skill Evaluation Report: ${evaluation.skillName}

**Generated:** ${new Date().toISOString()}
**Total Tasks:** ${totalTasks}
**Result:** ${passed ? 'PASS' : 'FAIL'}
${metaSection}
---

## Summary

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| **Discovery Accuracy** | ${(summary.discoveryAccuracy * 100).toFixed(1)}% | ${(config.discoveryThreshold * 100).toFixed(0)}% | ${discoveryPassed ? 'PASS' : 'FAIL'} |
| **Avg Adherence Score** | ${summary.avgAdherence.toFixed(2)}/5.0 | ${config.scoreThreshold.toFixed(1)} | ${summary.avgAdherence >= config.scoreThreshold ? 'PASS' : 'FAIL'} |
| **Avg Output Quality** | ${summary.avgOutputQuality.toFixed(2)}/5.0 | ${config.scoreThreshold.toFixed(1)} | ${summary.avgOutputQuality >= config.scoreThreshold ? 'PASS' : 'FAIL'} |
| **Avg Weighted Score** | ${summary.avgWeightedScore.toFixed(2)} | | |
| **Total Duration** | ${(summary.totalDurationMs / 1000).toFixed(1)}s | | |
| **Total Cost** | $${summary.totalCostUsd.toFixed(4)} | | |

## Failure Analysis

| Category | Count | Percentage |
|----------|-------|------------|
`;

  for (const fb of failureBreakdown) {
    const displayCat = fb.category === 'none' ? 'No Failure' : formatCategory(fb.category);
    report += `| ${displayCat} | ${fb.count} | ${fb.percentage.toFixed(1)}% |\n`;
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
| Discovery | ${Math.round(score.discovery)} | ${score.discovery >= 1 ? 'PASS' : 'FAIL'} |
| Adherence | ${score.adherence}/5 | ${score.adherence >= 4 ? 'PASS' : 'FAIL'} |
| Output Quality | ${score.outputQuality}/5 | ${score.outputQuality >= 4 ? 'PASS' : 'FAIL'} |
| **Weighted** | **${score.weightedScore.toFixed(2)}** | |

**Failure Category:** ${formatCategory(score.failureCategory)}
`;

    // Show deterministic results if available
    if (score.deterministic) {
      report += `\n**Deterministic Check:** ${score.deterministic.passed ? 'PASS' : 'FAIL'}\n`;
      for (const detail of score.deterministic.details) {
        report += `- ${detail}\n`;
      }
    }

    report += `\n**Reasoning:** ${score.reasoning || 'No reasoning provided'}

<details>
<summary>Agent Output (click to expand)</summary>

\`\`\`
${result.output.slice(0, config.reportOutputTruncation) || '(no output)'}
\`\`\`

</details>

**Metrics:** Duration: ${(result.durationMs / 1000).toFixed(1)}s | Turns: ${result.numTurns} | Cost: $${result.costUsd.toFixed(4)}

---

`;
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
export async function generateJsonResults(
  evaluation: SkillEvaluation,
  results: TaskResult[],
  scores: CombinedScore[],
  outputPath?: string,
  metadata?: ReportMetadata
): Promise<EvaluationReport> {
  const config = loadConfigSync();
  const summary = computeSummary(results, scores);
  const failureBreakdown = computeFailureBreakdown(scores);

  const discoveryPassed = summary.discoveryAccuracy >= config.discoveryThreshold;
  const scorePassed = summary.avgAdherence >= config.scoreThreshold && summary.avgOutputQuality >= config.scoreThreshold;
  const passed = discoveryPassed && scorePassed;

  const failureReasons: string[] = [];
  if (!discoveryPassed) {
    failureReasons.push(
      `Discovery rate ${(summary.discoveryAccuracy * 100).toFixed(1)}% below threshold ${(config.discoveryThreshold * 100).toFixed(0)}%`
    );
  }
  if (summary.avgAdherence < config.scoreThreshold) {
    failureReasons.push(
      `Avg adherence ${summary.avgAdherence.toFixed(2)} below threshold ${config.scoreThreshold}`
    );
  }
  if (summary.avgOutputQuality < config.scoreThreshold) {
    failureReasons.push(
      `Avg output quality ${summary.avgOutputQuality.toFixed(2)} below threshold ${config.scoreThreshold}`
    );
  }

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
      agentModel: metadata.agentModel,
      judgeModel: metadata.judgeModel,
    } : undefined,
    summary,
    failureBreakdown,
    tasks: evaluation.tasks.map((task, i) => ({
      task,
      result: results[i],
      score: scores[i],
    })),
  };

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`JSON results saved to: ${outputPath}`);
  }

  return report;
}

/**
 * Compute summary statistics from combined scores.
 */
export function computeSummary(
  results: TaskResult[],
  scores: CombinedScore[]
): EvaluationSummary {
  const totalTasks = scores.length;
  const discoveryCorrect = scores.filter((s) => s.discovery >= 1).length;

  return {
    totalTasks,
    discoveryAccuracy: totalTasks > 0 ? discoveryCorrect / totalTasks : 0,
    avgAdherence: totalTasks > 0
      ? scores.reduce((sum, s) => sum + s.adherence, 0) / totalTasks
      : 0,
    avgOutputQuality: totalTasks > 0
      ? scores.reduce((sum, s) => sum + s.outputQuality, 0) / totalTasks
      : 0,
    avgWeightedScore: totalTasks > 0
      ? scores.reduce((sum, s) => sum + s.weightedScore, 0) / totalTasks
      : 0,
    totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
  };
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

function formatCategory(cat: string): string {
  if (cat === 'none') return 'No Failure';
  return cat
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
