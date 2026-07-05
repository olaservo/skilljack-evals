import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildNudge, buildNudgeForSkillsDir } from '../run/nudge.js';
import { ResponseCache } from '../cache/response-cache.js';
import type { EvalTask, TaskResult } from '../types.js';

const GREETING_SKILL_MD = `---
name: greeting
description: Use when the user greets you or asks for a welcome.
---

# Greeting Skill

Say GREETING_SUCCESS.
`;

const FAREWELL_SKILL_MD = `---
name: farewell
description: Use when the user says goodbye.
---

# Farewell Skill

Say FAREWELL_SUCCESS.
`;

describe('buildNudge levels', () => {
  let skillsDir: string;

  beforeAll(async () => {
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-skills-'));
    await fs.mkdir(path.join(skillsDir, 'greeting'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'greeting', 'SKILL.md'), GREETING_SKILL_MD, 'utf-8');
    await fs.mkdir(path.join(skillsDir, 'farewell'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'farewell', 'SKILL.md'), FAREWELL_SKILL_MD, 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(skillsDir, { recursive: true, force: true });
  });

  it("returns '' for level off", async () => {
    expect(await buildNudgeForSkillsDir('off', skillsDir)).toBe('');
  });

  it("returns '' when the skills dir is undefined or empty", async () => {
    expect(await buildNudgeForSkillsDir('name', undefined)).toBe('');
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-empty-'));
    try {
      expect(await buildNudgeForSkillsDir('name', emptyDir)).toBe('');
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('level name lists comma-separated skill names', async () => {
    const nudge = await buildNudgeForSkillsDir('name', skillsDir);
    expect(nudge.startsWith('\n\nAvailable skills: ')).toBe(true);
    const names = nudge.replace('\n\nAvailable skills: ', '').split(', ').sort();
    expect(names).toEqual(['farewell', 'greeting']);
  });

  it('level description lists one name: description line per skill', async () => {
    const nudge = await buildNudgeForSkillsDir('description', skillsDir);
    expect(nudge).toContain('\n\nAvailable skills:\n');
    expect(nudge).toContain('- greeting: Use when the user greets you or asks for a welcome.');
    expect(nudge).toContain('- farewell: Use when the user says goodbye.');
  });

  it('level full inlines each SKILL.md body under a name heading', async () => {
    const nudge = await buildNudgeForSkillsDir('full', skillsDir);
    expect(nudge).toContain('## greeting');
    expect(nudge).toContain('# Greeting Skill');
    expect(nudge).toContain('Say GREETING_SUCCESS.');
    expect(nudge).toContain('## farewell');
    expect(nudge).toContain('Say FAREWELL_SUCCESS.');
    // Frontmatter is stripped from the inlined body.
    expect(nudge).not.toContain('name: greeting');
  });

  it('buildNudge returns "" when no skills are given', async () => {
    expect(await buildNudge('full', [])).toBe('');
  });
});

describe('buildNudgeForSkillsDir root layout (single skill, SKILL.md at dir root)', () => {
  let rootDir: string;

  beforeAll(async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-root-'));
    rootDir = path.join(parent, 'greeting-v1');
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'SKILL.md'), GREETING_SKILL_MD, 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(path.dirname(rootDir), { recursive: true, force: true });
  });

  it('level name uses the frontmatter name', async () => {
    expect(await buildNudgeForSkillsDir('name', rootDir)).toBe('\n\nAvailable skills: greeting');
  });

  it('level description renders the frontmatter description', async () => {
    const nudge = await buildNudgeForSkillsDir('description', rootDir);
    expect(nudge).toContain('- greeting: Use when the user greets you or asks for a welcome.');
  });

  it('level full inlines the root SKILL.md body', async () => {
    const nudge = await buildNudgeForSkillsDir('full', rootDir);
    expect(nudge).toContain('## greeting');
    expect(nudge).toContain('Say GREETING_SUCCESS.');
    expect(nudge).not.toContain('name: greeting');
  });

  it('falls back to the dir basename when frontmatter has no name', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-root-noname-'));
    const dir = path.join(parent, 'unnamed-skill');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\ndescription: Does things.\n---\n\n# Body\n', 'utf-8');
    try {
      expect(await buildNudgeForSkillsDir('name', dir)).toBe('\n\nAvailable skills: unnamed-skill');
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

describe('buildNudgeForSkillsDir with missing descriptions', () => {
  let skillsDir: string;

  beforeAll(async () => {
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-nodesc-'));
    await fs.mkdir(path.join(skillsDir, 'terse'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'terse', 'SKILL.md'),
      '---\nname: terse\n---\n\n# Terse Skill\n\nSay TERSE_SUCCESS.\n',
      'utf-8',
    );
  });

  afterAll(async () => {
    await fs.rm(skillsDir, { recursive: true, force: true });
  });

  it("still appears at level 'name'", async () => {
    expect(await buildNudgeForSkillsDir('name', skillsDir)).toBe('\n\nAvailable skills: terse');
  });

  it("renders '(no description)' at level 'description' instead of dropping the skill", async () => {
    const nudge = await buildNudgeForSkillsDir('description', skillsDir);
    expect(nudge).toContain('- terse: (no description)');
  });

  it("still appears with the full body at level 'full'", async () => {
    const nudge = await buildNudgeForSkillsDir('full', skillsDir);
    expect(nudge).toContain('## terse');
    expect(nudge).toContain('Say TERSE_SUCCESS.');
  });
});

describe('nudge and the response-cache key', () => {
  it('a nudged prompt produces a different cache key than the bare prompt', () => {
    const base = {
      taskId: 't-001',
      prompt: 'Greet me please.',
      model: 'haiku',
      runnerType: 'claude-code',
      skillsHash: 'abc',
      environmentHash: 'no-environment',
      taskTimeoutMs: 300000,
      allowedWriteDirs: [],
    };

    const bareKey = ResponseCache.computeCacheKey(base);
    const nudgedKey = ResponseCache.computeCacheKey({
      ...base,
      prompt: base.prompt + '\n\nAvailable skills: greeting',
    });

    expect(nudgedKey).not.toBe(bareKey);
  });
});

// ---------------------------------------------------------------------------
// Pipeline-level: the nudge is appended for the with-skill phase only; the
// baseline phase always receives the bare prompt.
// ---------------------------------------------------------------------------

const seenPrompts: string[] = [];

vi.mock('../runner/runner-factory.js', () => ({
  createRunner: vi.fn(async () => ({
    providerName: 'fake-runner',
    runTask: vi.fn(),
    runTaskWithTimeout: async (task: EvalTask): Promise<TaskResult> => {
      seenPrompts.push(task.prompt);
      return {
        taskId: task.id,
        prompt: task.prompt,
        output: 'Hello! GREETING_SUCCESS',
        durationMs: 5,
        numTurns: 1,
        costUsd: 0,
        skillLoads: ['greeting'],
        toolCalls: [],
        isError: false,
        errorMessage: '',
      };
    },
  })),
}));

describe('pipeline nudge wiring', () => {
  let suiteDir: string;
  let outDir: string;

  beforeAll(async () => {
    suiteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-suite-'));
    outDir = path.join(suiteDir, 'out');
    await fs.mkdir(outDir, { recursive: true });

    await fs.mkdir(path.join(suiteDir, 'skills', 'greeting'), { recursive: true });
    await fs.writeFile(path.join(suiteDir, 'skills', 'greeting', 'SKILL.md'), GREETING_SKILL_MD, 'utf-8');

    await fs.mkdir(path.join(suiteDir, 't-001'), { recursive: true });
    await fs.writeFile(
      path.join(suiteDir, 't-001', 'task.md'),
      '---\nexpected_skill: greeting\nchecks:\n  contains: [GREETING_SUCCESS]\n---\n\nGreet me please.\n',
      'utf-8',
    );
  });

  afterAll(async () => {
    await fs.rm(suiteDir, { recursive: true, force: true });
  });

  it('appends the nudge to the with-skill phase only; baseline gets the bare prompt', async () => {
    const { runPipeline } = await import('../pipeline.js');
    seenPrompts.length = 0;

    await runPipeline({
      tasksPath: path.join(suiteDir, 't-001'),
      compare: true,
      numRuns: 1,
      noJudge: true,
      bustCache: true,
      keepWorkspaces: 'none',
      nudge: 'name',
      configOverrides: { outputDir: outDir, htmlReport: false },
    });

    expect(seenPrompts).toHaveLength(2);
    // Phase 1: with skill — nudged prompt.
    expect(seenPrompts[0]).toBe('Greet me please.\n\nAvailable skills: greeting');
    // Phase 2: baseline — bare prompt, no nudge.
    expect(seenPrompts[1]).toBe('Greet me please.');
  }, 30000);
});
