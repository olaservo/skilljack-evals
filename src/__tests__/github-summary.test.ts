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
