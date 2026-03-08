import { describe, it, expect } from 'vitest';
import { generateGitHubSummary } from '../report/github-summary.js';
import type { EvaluationReport } from '../types.js';

function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    skillName: 'test-skill',
    timestamp: '2026-01-01T00:00:00Z',
    passed: true,
    failureReasons: [],
    summary: {
      totalTasks: 1,
      numRuns: 1,
      discoveryAccuracy: 1,
      avgAdherence: 5,
      avgOutputQuality: 5,
      avgWeightedScore: 1,
      totalDurationMs: 1000,
      totalCostUsd: 0.01,
    },
    failureBreakdown: [],
    tasks: [],
    ...overrides,
  };
}

describe('generateGitHubSummary', () => {
  it('escapes markdown special characters in checklist evidence', () => {
    const report = makeReport({
      tasks: [
        {
          task: {
            id: 'task-1',
            prompt: 'Do something',
            expectedSkillLoad: 'test-skill',
            criteria: [],
            goldenChecklist: ['Check pipes | and _underscores_'],
          },
          result: {
            taskId: 'task-1',
            prompt: 'Do something',
            output: 'done',
            durationMs: 500,
            numTurns: 1,
            costUsd: 0.001,
            skillLoads: ['test-skill'],
            toolCalls: [],
            isError: false,
            errorMessage: '',
          },
          score: {
            taskId: 'task-1',
            deterministic: null,
            judge: null,
            discovery: 1,
            adherence: 5,
            outputQuality: 5,
            weightedScore: 1,
            failureCategory: 'none',
            reasoning: 'Good',
            checklistResults: [
              { item: 'Has pipes', passed: false, evidence: 'Missing | character in _output_' },
              { item: 'Has backticks', passed: false, evidence: 'No `code` found' },
              { item: 'Passing item', passed: true, evidence: 'Looks good' },
            ],
          },
        },
      ],
    });

    const summary = generateGitHubSummary(report);

    // Failed items should have escaped evidence
    expect(summary).toContain('Missing \\| character in \\_output\\_');
    expect(summary).toContain('No \\`code\\` found');
    // Passing items should not show evidence
    expect(summary).not.toContain('Looks good');
  });

  it('includes blind comparison section when present', () => {
    const report = makeReport({
      blindComparison: {
        tasks: [
          {
            taskId: 'task-1',
            withSkillLabel: 'A',
            outputA: { adherence: 5, outputQuality: 5 },
            outputB: { adherence: 3, outputQuality: 3 },
            preferred: 'A',
            reasoning: 'A is better',
            preferredCondition: 'with-skill',
            biasSignal: false,
          },
          {
            taskId: 'task-2',
            withSkillLabel: 'B',
            outputA: { adherence: 4, outputQuality: 4 },
            outputB: { adherence: 4, outputQuality: 4 },
            preferred: 'tie',
            reasoning: 'Equal',
            preferredCondition: 'tie',
            biasSignal: false,
          },
        ],
        aggregate: {
          withSkillPreferred: 1,
          withoutSkillPreferred: 0,
          ties: 1,
          biasSignalCount: 0,
          failedCount: 0,
        },
      },
    });

    const summary = generateGitHubSummary(report);

    expect(summary).toContain('### Blind A/B Comparison');
    expect(summary).toContain('| With-skill | 1 | 50% |');
    expect(summary).toContain('| Without-skill | 0 | 0% |');
    expect(summary).toContain('| Tie | 1 | 50% |');
    // No bias signals, so no warning
    expect(summary).not.toContain('bias signal');
  });

  it('shows bias warning in blind comparison when bias signals exist', () => {
    const report = makeReport({
      blindComparison: {
        tasks: [],
        aggregate: {
          withSkillPreferred: 0,
          withoutSkillPreferred: 1,
          ties: 0,
          biasSignalCount: 1,
          failedCount: 0,
        },
      },
    });

    const summary = generateGitHubSummary(report);

    expect(summary).toContain(':warning: **1 bias signal(s):**');
  });

  it('handles checklist items with no evidence', () => {
    const report = makeReport({
      tasks: [
        {
          task: {
            id: 'task-1',
            prompt: 'Do something',
            expectedSkillLoad: 'test-skill',
            criteria: [],
            goldenChecklist: ['Check something'],
          },
          result: {
            taskId: 'task-1',
            prompt: 'Do something',
            output: 'done',
            durationMs: 500,
            numTurns: 1,
            costUsd: 0.001,
            skillLoads: ['test-skill'],
            toolCalls: [],
            isError: false,
            errorMessage: '',
          },
          score: {
            taskId: 'task-1',
            deterministic: null,
            judge: null,
            discovery: 1,
            adherence: 5,
            outputQuality: 5,
            weightedScore: 1,
            failureCategory: 'none',
            reasoning: 'Good',
            checklistResults: [
              { item: 'No evidence item', passed: false },
            ],
          },
        },
      ],
    });

    const summary = generateGitHubSummary(report);
    expect(summary).toContain('- FAIL: No evidence item');
    // Should not have a trailing dash for missing evidence
    expect(summary).not.toContain('— ');
  });
});
