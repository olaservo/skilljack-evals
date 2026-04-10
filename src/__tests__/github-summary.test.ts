import { describe, it, expect } from 'vitest';
import { generateGitHubSummary } from '../report/github-summary.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { EvalConfig } from '../config.js';
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
            outputA: { instructionFollowing: 5, outputQuality: 5 },
            outputB: { instructionFollowing: 3, outputQuality: 3 },
            preferred: 'A',
            reasoning: 'A is better',
            preferredCondition: 'with-skill',
            biasSignal: false,
            failed: false,
          },
          {
            taskId: 'task-2',
            withSkillLabel: 'B',
            outputA: { instructionFollowing: 4, outputQuality: 4 },
            outputB: { instructionFollowing: 4, outputQuality: 4 },
            preferred: 'tie',
            reasoning: 'Equal',
            preferredCondition: 'tie',
            biasSignal: false,
            failed: false,
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

  it('uses custom thresholds from config', () => {
    const customConfig: EvalConfig = { ...DEFAULT_CONFIG, discoveryThreshold: 0.5, scoreThreshold: 3.0 };
    const report = makeReport({
      passed: true,
      summary: {
        totalTasks: 2,
        numRuns: 1,
        discoveryAccuracy: 0.6,
        avgAdherence: 3.5,
        avgOutputQuality: 3.5,
        avgWeightedScore: 0.6,
        totalDurationMs: 2000,
        totalCostUsd: 0.02,
      },
    });

    const summary = generateGitHubSummary(report, customConfig);

    // These would be FAIL with default thresholds (0.8 / 4.0) but PASS with custom (0.5 / 3.0)
    expect(summary).toContain('| Discovery Rate | 60%');
    expect(summary).toContain('PASS');
    expect(summary).not.toMatch(/Discovery Rate.*FAIL/);
    expect(summary).not.toMatch(/Avg Adherence.*FAIL/);
    expect(summary).not.toMatch(/Avg Output Quality.*FAIL/);
  });

  it('displays threshold column with configured values', () => {
    const customConfig: EvalConfig = { ...DEFAULT_CONFIG, discoveryThreshold: 0.7, scoreThreshold: 3.5 };
    const report = makeReport();

    const summary = generateGitHubSummary(report, customConfig);

    expect(summary).toContain('| Metric | Value | Threshold | Status |');
    expect(summary).toMatch(/Discovery Rate.*70%/);
    expect(summary).toMatch(/Avg Adherence.*3\.5/);
    expect(summary).toMatch(/Avg Output Quality.*3\.5/);
  });

  it('passes at exact threshold boundary (>=)', () => {
    const customConfig: EvalConfig = { ...DEFAULT_CONFIG, discoveryThreshold: 0.6, scoreThreshold: 3.0 };
    const report = makeReport({
      passed: true,
      summary: {
        totalTasks: 5,
        numRuns: 1,
        discoveryAccuracy: 0.6,
        avgAdherence: 3.0,
        avgOutputQuality: 3.0,
        avgWeightedScore: 0.5,
        totalDurationMs: 1000,
        totalCostUsd: 0.01,
      },
    });

    const summary = generateGitHubSummary(report, customConfig);

    // Exactly at threshold should be PASS
    expect(summary).not.toMatch(/Discovery Rate.*FAIL/);
    expect(summary).not.toMatch(/Avg Adherence.*FAIL/);
    expect(summary).not.toMatch(/Avg Output Quality.*FAIL/);
  });
});
