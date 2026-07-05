/**
 * Pipeline-level tests for --compare-skill (skill-version comparison):
 * - the baseline arm scores activation against the MOUNTED compare skill's
 *   resolved name, so a differently-named version dir does not fail with
 *   'Wrong skill activated' (Fix: fabricated lift);
 * - the baseline arm receives the SAME nudge level as the with-skill arm,
 *   built from the compare dir's skills (nudge symmetry);
 * - anti-trigger tasks keep expectedSkillLoad 'none';
 * - an ambiguous multi-skill compare dir errors clearly.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { EvalTask, TaskResult } from '../types.js';

const GREETING_SKILL_MD = `---
name: greeting
description: Use when the user greets you or asks for a welcome.
---

# Greeting Skill

Say GREETING_SUCCESS.
`;

const GREETING_V2_SKILL_MD = `---
name: greeting-v2
description: Use when the user greets you (version 2 wording).
---

# Greeting Skill v2

Say GREETING_SUCCESS with flair.
`;

const seenPrompts: string[] = [];

vi.mock('../runner/runner-factory.js', () => ({
  createRunner: vi.fn(async () => ({
    providerName: 'fake-runner',
    skillsMountPath: path.join('.claude', 'skills'),
    runTask: vi.fn(),
    runTaskWithTimeout: async (task: EvalTask): Promise<TaskResult> => {
      seenPrompts.push(task.prompt);
      // Simulate a real agent: when the prompt is a greeting, invoke whatever
      // skill is actually mounted in the trial workspace (by directory name).
      let skillLoads: string[] = [];
      if (task.workspaceDir && task.prompt.includes('Greet')) {
        try {
          const entries = await fs.readdir(
            path.join(task.workspaceDir, '.claude', 'skills'),
            { withFileTypes: true },
          );
          skillLoads = entries.filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 1);
        } catch {
          skillLoads = [];
        }
      }
      return {
        taskId: task.id,
        prompt: task.prompt,
        output: 'Hello! GREETING_SUCCESS',
        durationMs: 5,
        numTurns: 1,
        costUsd: 0,
        skillLoads,
        toolCalls: [],
        isError: false,
        errorMessage: '',
      };
    },
  })),
}));

describe('pipeline --compare-skill baseline', () => {
  let suiteDir: string;
  let compareDir: string;
  let outDir: string;

  beforeAll(async () => {
    suiteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-suite-'));
    outDir = path.join(suiteDir, 'out');
    await fs.mkdir(outDir, { recursive: true });

    // With-skill arm: suite-level skills/greeting/
    await fs.mkdir(path.join(suiteDir, 'skills', 'greeting'), { recursive: true });
    await fs.writeFile(path.join(suiteDir, 'skills', 'greeting', 'SKILL.md'), GREETING_SKILL_MD, 'utf-8');

    // Trigger task expecting the greeting skill.
    await fs.mkdir(path.join(suiteDir, 't-001'), { recursive: true });
    await fs.writeFile(
      path.join(suiteDir, 't-001', 'task.md'),
      '---\nexpected_skill: greeting\nchecks:\n  contains: [GREETING_SUCCESS]\n---\n\nGreet me please.\n',
      'utf-8',
    );

    // Anti-trigger task: must keep expectedSkillLoad 'none' in the baseline arm.
    await fs.mkdir(path.join(suiteDir, 't-anti'), { recursive: true });
    await fs.writeFile(
      path.join(suiteDir, 't-anti', 'task.md'),
      '---\nexpect_skill_invocation: false\n---\n\nWhat is 2+2?\n',
      'utf-8',
    );

    // Compare arm: a DIFFERENTLY-NAMED root-layout version dir.
    const compareParent = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-skill-'));
    compareDir = path.join(compareParent, 'greeting-v2');
    await fs.mkdir(compareDir, { recursive: true });
    await fs.writeFile(path.join(compareDir, 'SKILL.md'), GREETING_V2_SKILL_MD, 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(suiteDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.dirname(compareDir), { recursive: true, force: true }).catch(() => {});
  });

  it('accepts the mounted compare skill name in the baseline arm and nudges both arms', async () => {
    const { runPipeline } = await import('../pipeline.js');
    seenPrompts.length = 0;

    const result = await runPipeline({
      tasksPath: suiteDir,
      compareSkillPath: compareDir,
      numRuns: 1,
      bustCache: true,
      keepWorkspaces: 'none',
      nudge: 'name',
      configOverrides: { outputDir: outDir, htmlReport: false },
    });

    // Baseline arm must NOT fail with 'Wrong skill activated': the mounted
    // compare skill's resolved name (greeting-v2) is the expected activation.
    const trigger = result.runSummary.tasks.find((t) => t.id === 't-001')!;
    expect(trigger.baseline).toBeDefined();
    const baselineFailures = trigger.failures.filter((f) => f.condition === 'baseline');
    expect(baselineFailures).toEqual([]);
    expect(trigger.baseline!.resolutionRate).toBe(1);
    expect(trigger.withSkill.resolutionRate).toBe(1);
    // Sane lift for equally-capable versions: ~0.
    expect(trigger.lift).toBe(0);

    // Anti-trigger task keeps 'none' and passes in both arms.
    const anti = result.runSummary.tasks.find((t) => t.id === 't-anti')!;
    expect(anti.expectedSkill).toBe('none');
    expect(anti.failures).toEqual([]);

    // Nudge symmetry: the with-skill arm advertises the suite skill, the
    // compare baseline advertises the COMPARE dir's skill — same level.
    const withPrompt = seenPrompts.find((p) => p.includes('Available skills: greeting') && !p.includes('greeting-v2'));
    const basePrompt = seenPrompts.find((p) => p.includes('Available skills: greeting-v2'));
    expect(withPrompt).toBeDefined();
    expect(basePrompt).toBeDefined();
    expect(withPrompt).toContain('Greet me please.');
    expect(basePrompt).toContain('Greet me please.');
  }, 30000);

  it('errors clearly when the compare dir has multiple skills and none matches', async () => {
    const { runPipeline } = await import('../pipeline.js');
    const multiParent = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-multi-'));
    try {
      for (const name of ['alpha', 'beta']) {
        await fs.mkdir(path.join(multiParent, name), { recursive: true });
        await fs.writeFile(
          path.join(multiParent, name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
          'utf-8',
        );
      }

      await expect(runPipeline({
        tasksPath: path.join(suiteDir, 't-001'),
        compareSkillPath: multiParent,
        numRuns: 1,
        bustCache: true,
        keepWorkspaces: 'none',
        configOverrides: { outputDir: outDir, htmlReport: false },
      })).rejects.toThrow(/multiple skills \(alpha, beta\)/);
    } finally {
      await fs.rm(multiParent, { recursive: true, force: true }).catch(() => {});
    }
  }, 30000);

  it('errors clearly when the compare dir contains no skills', async () => {
    const { runPipeline } = await import('../pipeline.js');
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-empty-'));
    try {
      await expect(runPipeline({
        tasksPath: path.join(suiteDir, 't-001'),
        compareSkillPath: emptyDir,
        numRuns: 1,
        bustCache: true,
        keepWorkspaces: 'none',
        configOverrides: { outputDir: outDir, htmlReport: false },
      })).rejects.toThrow(/contains no skills/);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30000);
});
