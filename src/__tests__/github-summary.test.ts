import { describe, it, expect } from 'vitest';
import { generateGitHubSummary } from '../report/github-summary.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { EvalConfig } from '../config.js';
import type { JudgeScore } from '../types.js';
import { makeReport } from './fixtures/test-helpers.js';

function makeJudge(overrides: Partial<JudgeScore> = {}): JudgeScore {
  return {
    taskId: 'task-1',
    discovery: 1,
    adherence: 5,
    outputQuality: 5,
    failureCategory: 'none',
    reasoning: 'Good',
    checklistResults: [],
    ...overrides,
  };
}

describe('generateGitHubSummary', () => {
  it('escapes markdown special characters in assertion evidence (judge diagnostics)', () => {
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
            judge: makeJudge(),
            passed: true,
            reward: 1,
            discovery: 1,
            adherence: 5,
            outputQuality: 5,
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
    // Rendered under a diagnostics header
    expect(summary).toContain('### Diagnostics (LLM judge)');
  });

  it('omits the diagnostics section when the judge did not run', () => {
    const report = makeReport();
    const summary = generateGitHubSummary(report);
    expect(summary).not.toContain('Diagnostics');
    expect(summary).not.toContain('Adherence');
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

  it('lists failed tasks with reasoning', () => {
    const report = makeReport();
    const summary = generateGitHubSummary(report);

    // task-2 in the fixture failed
    expect(summary).toContain('### Failures (1)');
    expect(summary).toContain('| task-2 |');
  });

  it('uses custom resolution threshold from config', () => {
    const customConfig: EvalConfig = { ...DEFAULT_CONFIG, resolutionThreshold: 0.4 };
    const report = makeReport({ passed: true });

    const summary = generateGitHubSummary(report, customConfig);

    // Resolution rate 50% >= 40% threshold → PASS
    expect(summary).toMatch(/Resolution Rate.*40%.*PASS/);
  });

  it('fails the resolution row when below threshold', () => {
    const customConfig: EvalConfig = { ...DEFAULT_CONFIG, resolutionThreshold: 0.9 };
    const report = makeReport({ passed: false });

    const summary = generateGitHubSummary(report, customConfig);

    expect(summary).toMatch(/Resolution Rate.*90%.*FAIL/);
  });

  it('shows skill lift row with threshold gating when a comparison ran', () => {
    const customConfig: EvalConfig = { ...DEFAULT_CONFIG, liftThreshold: 0.1 };
    const base = makeReport();
    const report = makeReport({
      comparison: {
        summary: {
          withSkill: base.summary,
          withoutSkill: { ...base.summary, resolutionRate: 0.25, passAtK: 0.25 },
          delta: {
            resolutionRateDelta: 0.25,
            passAtKDelta: 0.25,
            totalDurationDeltaMs: 0,
            totalCostDeltaUsd: 0,
          },
          baselineLabel: 'No Skill',
        },
        tasks: [],
      },
    });

    const summary = generateGitHubSummary(report, customConfig);

    expect(summary).toMatch(/Skill Lift \| \+25% \| \+10% \| PASS/);
    expect(summary).toContain('### Skill Impact (vs No Skill)');
  });

  it('renders invocation rate row when available', () => {
    const report = makeReport();
    report.summary.invocationRate = 0.75;
    const summary = generateGitHubSummary(report);
    expect(summary).toMatch(/Invocation Rate \| 75%/);
  });

  it('renders pass@k row with the trial count', () => {
    const report = makeReport();
    report.summary.numRuns = 3;
    const summary = generateGitHubSummary(report);
    expect(summary).toMatch(/Pass@3 \| 50%/);
  });

  it('renders Tokens row with thousand-separated value when summary reports totalTokens', () => {
    const report = makeReport();
    report.summary.totalTokens = 123456;
    const summary = generateGitHubSummary(report);
    expect(summary).toMatch(/\| Tokens \| 123,456 \|/);
  });

  it('renders Tokens row as n/a when summary omits totalTokens', () => {
    const report = makeReport();
    const summary = generateGitHubSummary(report);
    expect(summary).toMatch(/\| Tokens \| n\/a \|/);
  });

  it('passes at exact threshold boundary (>=)', () => {
    const customConfig: EvalConfig = { ...DEFAULT_CONFIG, resolutionThreshold: 0.5 };
    const report = makeReport({ passed: true });

    const summary = generateGitHubSummary(report, customConfig);

    // Exactly at threshold should be PASS
    expect(summary).not.toMatch(/Resolution Rate.*FAIL/);
  });

  it('shows per-task passed ratios in the collapsible table', () => {
    const report = makeReport();
    const summary = generateGitHubSummary(report);
    expect(summary).toContain('| task-1 | 1/1 | 1.00 | 100% | PASS |');
    expect(summary).toContain('| task-2 | 0/1 | 0.00 | 100% | FAIL |');
  });
});
