import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { generateHtmlReport } from '../report/html-report.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { ReportOptions } from '../report/report.js';
import type { SkillEvaluation, ComparisonData, BlindComparisonData, ComparisonResult, JudgeScore } from '../types.js';
import { makeScore, makeResult } from './fixtures/test-helpers.js';

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, mkdir: (...args: unknown[]) => mockMkdir(...args), writeFile: (...args: unknown[]) => mockWriteFile(...args) };
});

function makeJudge(overrides: Partial<JudgeScore> = {}): JudgeScore {
  return {
    taskId: 'task-1',
    discovery: 1,
    adherence: 5,
    outputQuality: 4,
    failureCategory: 'none',
    reasoning: 'Good',
    checklistResults: [],
    ...overrides,
  };
}

function makeReportOptions(overrides: Partial<ReportOptions> = {}): ReportOptions {
  const evaluation: SkillEvaluation = {
    skillName: 'test-skill',
    tasks: [
      { id: 'task-1', prompt: 'Do task one', expectedSkillLoad: 'my-skill', criteria: [], goldenChecklist: ['Check A'] },
      { id: 'task-2', prompt: 'Do task two', expectedSkillLoad: 'my-skill', criteria: [], goldenChecklist: [] },
    ],
  };
  return {
    evaluation,
    results: [
      makeResult({ taskId: 'task-1', skillLoads: ['my-skill'], output: 'Output for task 1' }),
      makeResult({ taskId: 'task-2', skillLoads: [], output: 'Output for task 2', durationMs: 2000, costUsd: 0.02 }),
    ],
    scores: [
      makeScore({
        taskId: 'task-1',
        passed: true,
        reward: 1,
        discovery: 1,
        invocation: 1,
        adherence: 5,
        outputQuality: 4,
        judge: makeJudge(),
        checklistResults: [{ item: 'Check A', passed: true, evidence: 'Found it' }],
      }),
      makeScore({ taskId: 'task-2', passed: false, reward: 0, discovery: 0, invocation: 0, failureCategory: 'discovery_failure' }),
    ],
    config: DEFAULT_CONFIG,
    ...overrides,
  };
}

describe('generateHtmlReport', () => {
  afterEach(() => {
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
    vi.restoreAllMocks();
  });

  it('returns a valid HTML document with required structural elements', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    expect(html).toContain('</html>');
  });

  it('renders skill name in title and header', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('<title>Skill Evaluation: test-skill</title>');
    expect(html).toContain('Skill Evaluation: test-skill');
  });

  it('renders PASS badge when evaluation passes', async () => {
    const opts = makeReportOptions({
      scores: [
        makeScore({ taskId: 'task-1', passed: true, reward: 1 }),
        makeScore({ taskId: 'task-2', passed: true, reward: 1 }),
      ],
    });
    const html = await generateHtmlReport(opts);

    expect(html).toContain('badge-pass');
    expect(html).toContain('>PASS<');
  });

  it('renders FAIL badge when evaluation fails', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('badge-fail');
    expect(html).toContain('>FAIL<');
  });

  it('renders dashboard with resolution rate and pass@k gauges', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    // Resolution rate: (1+0)/2 = 50%
    expect(html).toContain('50.0%');
    expect(html).toContain('Resolution Rate');
    expect(html).toContain('Pass@1');
    expect(html).toContain('Invocation Rate');
    // Tasks count
    expect(html).toContain('>2<');
  });

  it('renders a Skill Lift stat when a comparison ran', async () => {
    const comparison: ComparisonData = {
      summary: {
        withSkill: { totalTasks: 2, numRuns: 1, resolutionRate: 0.5, resolutionCI: { low: 0, high: 1 }, passAtK: 0.5, totalDurationMs: 5000, totalCostUsd: 0.01 },
        withoutSkill: { totalTasks: 2, numRuns: 1, resolutionRate: 0.25, resolutionCI: { low: 0, high: 1 }, passAtK: 0.25, totalDurationMs: 4000, totalCostUsd: 0.008 },
        delta: { resolutionRateDelta: 0.25, passAtKDelta: 0.25, totalDurationDeltaMs: 1000, totalCostDeltaUsd: 0.002 },
        baselineLabel: 'No Skill',
      },
      tasks: [],
    };
    const html = await generateHtmlReport(makeReportOptions({ comparison }));

    expect(html).toContain('Skill Lift');
    expect(html).toContain('+25.0%');
  });

  it('renders Tokens stat card with summed value when results report tokens', async () => {
    const html = await generateHtmlReport(makeReportOptions({
      results: [
        makeResult({ taskId: 'task-1', skillLoads: ['my-skill'], tokens: { input: 1000, output: 500, cacheRead: 100, cacheCreation: 0, total: 1600 } }),
        makeResult({ taskId: 'task-2', skillLoads: [], tokens: { input: 2000, output: 800, cacheRead: 0, cacheCreation: 100, total: 2900 } }),
      ],
    }));

    expect(html).toMatch(/<div class="stat-value">4,500<\/div>\s*<div class="stat-label">Tokens<\/div>/);
  });

  it('renders Tokens stat card as em-dash when any result lacks tokens', async () => {
    const html = await generateHtmlReport(makeReportOptions());
    expect(html).toMatch(/<div class="stat-value">&mdash;<\/div>\s*<div class="stat-label">Tokens<\/div>/);
  });

  it('renders the correct number of task rows', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    // Two task rows
    const taskRowMatches = html.match(/class="task-row"/g);
    expect(taskRowMatches).toHaveLength(2);

    // Two detail rows
    const detailRowMatches = html.match(/class="detail-row"/g);
    expect(detailRowMatches).toHaveLength(2);
  });

  it('renders task IDs and failure categories', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('task-1');
    expect(html).toContain('task-2');
    expect(html).toContain('Discovery Failure');
  });

  it('renders judge assertions under a diagnostics section when the judge ran', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('Diagnostics (LLM judge');
    expect(html).toContain('Check A');
    expect(html).toContain('Found it');
    expect(html).toContain('Assertions (1/1)');
  });

  it('omits the diagnostics section when the judge did not run', async () => {
    const opts = makeReportOptions({
      scores: [
        makeScore({ taskId: 'task-1' }),
        makeScore({ taskId: 'task-2', passed: false, reward: 0 }),
      ],
    });
    const html = await generateHtmlReport(opts);

    expect(html).not.toContain('Diagnostics (LLM judge');
  });

  it('renders agent output in detail panels', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('Output for task 1');
    expect(html).toContain('Output for task 2');
  });

  it('renders metadata when provided', async () => {
    const html = await generateHtmlReport(makeReportOptions({
      metadata: {
        skillPath: '/path/to/skill',
        gitCommit: 'abc1234567890',
        gitBranch: 'main',
        runnerType: 'claude-sdk',
        agentModel: 'sonnet',
        judgeModel: 'haiku',
      },
    }));

    expect(html).toContain('main@abc1234');
    expect(html).toContain('claude-sdk');
    expect(html).toContain('sonnet');
    expect(html).toContain('haiku');
  });

  it('renders failure analysis bar chart', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('Failure Analysis');
    expect(html).toContain('bar-chart');
  });

  it('renders search and filter controls', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('id="search"');
    expect(html).toContain('data-filter="all"');
    expect(html).toContain('data-filter="failed"');
    expect(html).toContain('data-filter="flaky"');
  });

  it('renders sortable column headers', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('data-col="taskId"');
    expect(html).toContain('data-col="reward"');
    expect(html).toContain('data-col="tokens"');
  });

  // --- XSS escaping ---

  it('escapes HTML in task IDs', async () => {
    const opts = makeReportOptions();
    opts.evaluation.tasks[0].id = '<script>alert("xss")</script>';
    opts.scores[0] = makeScore({ taskId: '<script>alert("xss")</script>' });
    opts.results[0] = makeResult({ taskId: '<script>alert("xss")</script>' });

    const html = await generateHtmlReport(opts);

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;alert');
  });

  it('escapes HTML in prompt text', async () => {
    const opts = makeReportOptions();
    opts.evaluation.tasks[0].prompt = 'Test <b>bold</b> & "quotes"';

    const html = await generateHtmlReport(opts);

    expect(html).toContain('Test &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;');
  });

  it('escapes HTML in agent output', async () => {
    const opts = makeReportOptions();
    opts.results[0] = makeResult({ taskId: 'task-1', output: '<img src=x onerror=alert(1)>' });

    const html = await generateHtmlReport(opts);

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  // --- Embedded data ---

  it('embeds valid JSON report data for client-side interactivity', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    const match = html.match(/window\.__REPORT_DATA__\s*=\s*(\[[\s\S]*?\]);/);
    expect(match).not.toBeNull();

    const data = JSON.parse(match![1]);
    expect(data).toHaveLength(2);
    expect(data[0].taskId).toBe('task-1');
    expect(data[1].taskId).toBe('task-2');
    expect(data[0].passed).toBe(true);
    expect(data[0].reward).toBe(1);
    expect(data[1].passed).toBe(false);
    expect(data[1].failureCategory).toBe('discovery_failure');
  });

  it('escapes </script> in embedded JSON', async () => {
    const opts = makeReportOptions();
    opts.results[0] = makeResult({ taskId: 'task-1', output: '</script><script>alert(1)</script>' });

    const html = await generateHtmlReport(opts);

    // Should not contain raw </script> inside the script block (except the closing one)
    const scriptContent = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptContent).not.toBeNull();
    expect(scriptContent![1]).not.toContain('</script>');
  });

  // --- Conditional sections ---

  it('omits comparison section when no comparison data', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).not.toContain('id="comparison"');
  });

  it('renders comparison section when comparison data is present', async () => {
    const comparison: ComparisonData = {
      summary: {
        withSkill: { totalTasks: 2, numRuns: 1, resolutionRate: 0.8, resolutionCI: { low: 0.4, high: 1 }, passAtK: 0.8, totalDurationMs: 5000, totalCostUsd: 0.01 },
        withoutSkill: { totalTasks: 2, numRuns: 1, resolutionRate: 0.5, resolutionCI: { low: 0.1, high: 0.9 }, passAtK: 0.5, totalDurationMs: 4000, totalCostUsd: 0.008 },
        delta: { resolutionRateDelta: 0.3, passAtKDelta: 0.3, totalDurationDeltaMs: 1000, totalCostDeltaUsd: 0.002 },
        baselineLabel: 'No Skill',
      },
      tasks: [],
    };
    const html = await generateHtmlReport(makeReportOptions({ comparison }));

    expect(html).toContain('id="comparison"');
    expect(html).toContain('Skill Impact Analysis');
    expect(html).toContain('No Skill');
  });

  it('omits blind comparison section when no data', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).not.toContain('id="blind-comparison"');
  });

  it('renders blind comparison section when data is present', async () => {
    const blindComparison: BlindComparisonData = {
      tasks: [],
      aggregate: { withSkillPreferred: 3, withoutSkillPreferred: 1, ties: 0, biasSignalCount: 0, failedCount: 0 },
    };
    const html = await generateHtmlReport(makeReportOptions({ blindComparison }));

    expect(html).toContain('id="blind-comparison"');
    expect(html).toContain('Blind A/B Comparison');
  });

  it('omits cross-iteration section when no data', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).not.toContain('id="cross-iteration"');
  });

  it('renders cross-iteration section and regressed filter when data is present', async () => {
    const crossIterationComparison: ComparisonResult = {
      previousTimestamp: '2026-01-01T00:00:00Z',
      previousSkillName: 'test-skill',
      summaryDelta: {
        previous: { resolutionRate: 0.9, passAtK: 1 },
        current: { resolutionRate: 0.5, passAtK: 0.5 },
        delta: { resolutionRate: -0.4, passAtK: -0.5 },
      },
      taskDeltas: [
        {
          taskId: 'task-1',
          previous: { resolutionRate: 1 },
          current: { resolutionRate: 0 },
          delta: -1,
          significantChange: 'regressed',
        },
      ],
      tasksOnlyInCurrent: [],
      tasksOnlyInPrevious: [],
    };
    const html = await generateHtmlReport(makeReportOptions({ crossIterationComparison }));

    expect(html).toContain('id="cross-iteration"');
    expect(html).toContain('Cross-Iteration Comparison');
    expect(html).toContain('data-filter="regressed"');
  });

  it('omits human feedback section when no feedback', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).not.toContain('id="human-feedback"');
  });

  it('renders human feedback section when present', async () => {
    const html = await generateHtmlReport(makeReportOptions({
      humanFeedback: { 'task-1': 'Good job on this one' },
    }));

    expect(html).toContain('id="human-feedback"');
    expect(html).toContain('Human Review');
    expect(html).toContain('Good job on this one');
  });

  // --- Multi-run ---

  it('renders per-run breakdown when multiple runs exist', async () => {
    const opts = makeReportOptions({
      numRuns: 3,
      runDetails: [
        [
          { result: makeResult({ taskId: 'task-1' }), score: makeScore({ taskId: 'task-1', passed: true, reward: 1 }) },
          { result: makeResult({ taskId: 'task-1' }), score: makeScore({ taskId: 'task-1', passed: true, reward: 1 }) },
          { result: makeResult({ taskId: 'task-1' }), score: makeScore({ taskId: 'task-1', passed: false, reward: 0 }) },
        ],
        [
          { result: makeResult({ taskId: 'task-2' }), score: makeScore({ taskId: 'task-2', passed: false, reward: 0 }) },
          { result: makeResult({ taskId: 'task-2' }), score: makeScore({ taskId: 'task-2', passed: true, reward: 1 }) },
        ],
      ],
    });
    const html = await generateHtmlReport(opts);

    expect(html).toContain('Per-Run Breakdown');
    expect(html).toContain('3 runs');
    expect(html).toContain('2 runs');
  });

  // --- File writing ---

  it('writes HTML file when outputPath is provided', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = '/tmp/test-report.html';
    const html = await generateHtmlReport(makeReportOptions({ outputPath }));

    expect(mockMkdir).toHaveBeenCalledWith(path.dirname(outputPath), { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(outputPath, html);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('HTML report saved to'));
  });

  it('returns HTML string without writing when no outputPath', async () => {
    const html = await generateHtmlReport(makeReportOptions());

    expect(html).toContain('<!DOCTYPE html>');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // --- Edge cases ---

  it('throws when result/score arrays do not match task count', async () => {
    const opts = makeReportOptions();
    opts.results = [opts.results[0]]; // 1 result for 2 tasks
    await expect(generateHtmlReport(opts)).rejects.toThrow('Mismatched array lengths');
  });

  it('handles zero tasks gracefully', async () => {
    const opts = makeReportOptions({
      evaluation: { skillName: 'empty-skill', tasks: [] },
      results: [],
      scores: [],
    });
    const html = await generateHtmlReport(opts);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('empty-skill');
    expect(html).toContain('>0<'); // 0 tasks in stats
    expect(html).not.toContain('NaN');
  });

  // --- Gauge edge cases ---

  it('does not produce NaN when all trials fail', async () => {
    const opts = makeReportOptions({
      results: [
        makeResult({ taskId: 'task-1', output: 'out' }),
        makeResult({ taskId: 'task-2', output: 'out' }),
      ],
      scores: [
        makeScore({ taskId: 'task-1', passed: false, reward: 0, discovery: 0 }),
        makeScore({ taskId: 'task-2', passed: false, reward: 0, discovery: 0 }),
      ],
    });
    const html = await generateHtmlReport(opts);

    expect(html).not.toContain('NaN');
    expect(html).toContain('0.0%'); // resolution gauge
  });

  // --- Metadata edge cases ---

  it('omits Agent and Judge metadata items when fields are empty', async () => {
    const html = await generateHtmlReport(makeReportOptions({
      metadata: {
        skillPath: '/path/to/skill',
        runnerType: 'claude-sdk',
        agentModel: '',
        judgeModel: '',
      },
    }));

    expect(html).toContain('claude-sdk');
    expect(html).not.toContain('Agent:');
    expect(html).not.toContain('Judge:');
  });

  it('renders Agent and Judge metadata when fields are present', async () => {
    const html = await generateHtmlReport(makeReportOptions({
      metadata: {
        skillPath: '/path/to/skill',
        runnerType: 'claude-sdk',
        agentModel: 'sonnet',
        judgeModel: 'haiku',
      },
    }));

    expect(html).toContain('Agent: sonnet');
    expect(html).toContain('Judge: haiku');
  });

  // --- Flaky indicator ---

  it('marks flaky tasks in embedded data (trials disagree)', async () => {
    const opts = makeReportOptions({
      scores: [
        makeScore({ taskId: 'task-1', stddev: { reward: 0.5, discovery: 0 } }),
        makeScore({ taskId: 'task-2' }),
      ],
    });
    const html = await generateHtmlReport(opts);

    const match = html.match(/window\.__REPORT_DATA__\s*=\s*(\[[\s\S]*?\]);/);
    const data = JSON.parse(match![1]);
    expect(data[0].isFlaky).toBe(true);
    expect(data[1].isFlaky).toBe(false);
  });
});
