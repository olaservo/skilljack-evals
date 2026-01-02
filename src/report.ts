/**
 * Report generation for skill evaluation results.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  SkillEvaluation,
  TaskResult,
  JudgeScore,
  EvaluationReport,
  EvaluationSummary,
  FailureBreakdown,
  FailureCategory,
} from './types.js';

export interface SkillMetadata {
  skillName: string;
  skillPath: string;
  gitCommit?: string;
  gitBranch?: string;
  version?: string;
  agentModel: string;
  judgeModel: string;
}

/**
 * Generate a markdown report from evaluation results.
 */
export async function generateReport(
  evaluation: SkillEvaluation,
  results: TaskResult[],
  scores: JudgeScore[],
  outputPath?: string,
  metadata?: SkillMetadata
): Promise<string> {
  const totalTasks = evaluation.tasks.length;

  // Calculate summary metrics
  const discoveryCorrect = scores.filter((s) => s.discovery >= 1).length;
  const discoveryAccuracy = totalTasks > 0 ? (discoveryCorrect / totalTasks) * 100 : 0;

  const avgAdherence = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.adherence, 0) / totalTasks
    : 0;
  const avgOutput = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.outputQuality, 0) / totalTasks
    : 0;
  const avgWeighted = totalTasks > 0
    ? scores.reduce((sum, s) => sum + s.weightedScore, 0) / totalTasks
    : 0;

  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0) / 1000;
  const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0);

  // Failure category breakdown
  const failureCounts = new Map<string, number>();
  for (const s of scores) {
    const cat = s.failureCategory || 'none';
    failureCounts.set(cat, (failureCounts.get(cat) || 0) + 1);
  }

  const failureRows = Array.from(failureCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => {
      const pct = totalTasks > 0 ? (count / totalTasks) * 100 : 0;
      const displayCat = cat === 'none' ? 'No Failure' : formatCategory(cat);
      return `| ${displayCat} | ${count} | ${pct.toFixed(1)}% |`;
    });

  // Build metadata section
  let metaSection = '';
  if (metadata) {
    const metaLines = [
      `**Skill Path:** \`${metadata.skillPath}\``,
    ];
    if (metadata.gitCommit) {
      metaLines.push(`**Git:** ${metadata.gitBranch}@${metadata.gitCommit}`);
    }
    if (metadata.version) {
      metaLines.push(`**Version:** ${metadata.version}`);
    }
    metaLines.push(`**Agent Model:** ${metadata.agentModel}`);
    metaLines.push(`**Judge Model:** ${metadata.judgeModel}`);
    metaSection = metaLines.join('\n') + '\n';
  }

  // Build report
  let report = `# Skill Evaluation Report: ${evaluation.skillName}

**Generated:** ${new Date().toISOString()}
**Total Tasks:** ${totalTasks}
${metaSection}
---

## Summary

| Metric | Value |
|--------|-------|
| **Discovery Accuracy** | ${discoveryAccuracy.toFixed(1)}% (${discoveryCorrect}/${totalTasks}) |
| **Avg Adherence Score** | ${avgAdherence.toFixed(2)}/5.0 |
| **Avg Output Quality** | ${avgOutput.toFixed(2)}/5.0 |
| **Avg Weighted Score** | ${avgWeighted.toFixed(2)} |
| **Total Duration** | ${totalDuration.toFixed(1)}s |
| **Total Cost** | $${totalCost.toFixed(4)} |

## Failure Analysis

| Category | Count | Percentage |
|----------|-------|------------|
${failureRows.join('\n')}

---

## Task Details

`;

  // Add task details
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
| Discovery | ${Math.round(score.discovery)} | ${statusIndicator(score.discovery, 1)} |
| Adherence | ${score.adherence}/5 | ${statusIndicator(score.adherence, 4)} |
| Output Quality | ${score.outputQuality}/5 | ${statusIndicator(score.outputQuality, 4)} |
| **Weighted** | **${score.weightedScore.toFixed(2)}** | |

**Failure Category:** ${formatCategory(score.failureCategory)}

**Judge Reasoning:** ${score.reasoning || 'No reasoning provided'}

<details>
<summary>Agent Output (click to expand)</summary>

\`\`\`
${result.output.slice(0, 2000) || '(no output)'}
\`\`\`

</details>

**Metrics:** Duration: ${(result.durationMs / 1000).toFixed(1)}s | Turns: ${result.numTurns} | Cost: $${result.costUsd.toFixed(4)}

---

`;
  }

  // Write to file if path provided
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, report);
    console.log(`Report saved to: ${outputPath}`);
  }

  return report;
}

/**
 * Generate JSON results for programmatic analysis.
 */
export async function generateJsonResults(
  evaluation: SkillEvaluation,
  results: TaskResult[],
  scores: JudgeScore[],
  outputPath?: string,
  metadata?: SkillMetadata
): Promise<EvaluationReport> {
  const summary = computeSummary(results, scores);
  const failureBreakdown = computeFailureBreakdown(scores);

  const report: EvaluationReport = {
    skillName: evaluation.skillName,
    timestamp: new Date().toISOString(),
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
 * Compute summary statistics.
 */
function computeSummary(results: TaskResult[], scores: JudgeScore[]): EvaluationSummary {
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
function computeFailureBreakdown(scores: JudgeScore[]): FailureBreakdown[] {
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
 * Return status indicator based on score vs threshold.
 */
function statusIndicator(score: number, threshold: number): string {
  return score >= threshold ? 'PASS' : 'FAIL';
}

/**
 * Format a failure category for display.
 */
function formatCategory(cat: string): string {
  if (cat === 'none') return 'No Failure';
  return cat
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
