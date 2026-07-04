import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadTaskPackages, validateTaskPackages } from '../task/load.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-load-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

async function writeTask(taskDir: string, taskMd: string): Promise<void> {
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'task.md'), taskMd);
}

async function writeSkill(skillsDir: string, name: string): Promise<void> {
  const dir = path.join(skillsDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 'Test skill ${name}'\n---\n\n# ${name}\n`,
  );
}

const BASIC_TASK = `---
checks:
  contains: [hello]
---

Say hello to me.
`;

describe('loadTaskPackages — single package', () => {
  it('loads a single task package, defaulting id to the directory name', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 'my-task');
    await writeTask(taskDir, BASIC_TASK);

    const suite = await loadTaskPackages(taskDir);

    expect(suite.tasks).toHaveLength(1);
    expect(suite.tasks[0].task.id).toBe('my-task');
    expect(suite.tasks[0].task.prompt).toBe('Say hello to me.');
    expect(suite.tasks[0].taskDir).toBe(path.resolve(taskDir));
  });

  it('errors when frontmatter id mismatches directory name', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 'my-task');
    await writeTask(taskDir, `---\nid: other-id\nchecks: { contains: [x] }\n---\n\nPrompt.\n`);

    await expect(loadTaskPackages(taskDir)).rejects.toThrow(/does not match directory name/);
  });

  it('accepts a matching explicit id', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 'my-task');
    await writeTask(taskDir, `---\nid: my-task\nchecks: { contains: [x] }\n---\n\nPrompt.\n`);

    const suite = await loadTaskPackages(taskDir);
    expect(suite.tasks[0].task.id).toBe('my-task');
  });

  it('errors on missing prompt body', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nchecks: { contains: [x] }\n---\n`);

    await expect(loadTaskPackages(taskDir)).rejects.toThrow(/missing prompt body/);
  });

  it('errors when a task has no checks, verifier, or assertions', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `Just a prompt with no frontmatter.\n`);

    await expect(loadTaskPackages(taskDir)).rejects.toThrow(/at least one of/);
  });

  it('errors on invalid regex in checks.regex', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nchecks:\n  regex: ["[invalid"]\n---\n\nPrompt.\n`);

    await expect(loadTaskPackages(taskDir)).rejects.toThrow(/invalid regex/);
  });

  it('errors on invalid difficulty', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\ndifficulty: extreme\nchecks: { contains: [x] }\n---\n\nPrompt.\n`);

    await expect(loadTaskPackages(taskDir)).rejects.toThrow(/invalid difficulty/);
  });
});

describe('loadTaskPackages — checks mapping', () => {
  it('maps all lite checks 1:1 onto DeterministicCheck', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---
checks:
  contains: [hello, world]
  not_contains: [ERROR]
  regex: ["\\\\d{4}"]
  marker: DONE
  tool_calls: [Write]
  no_tool_calls: [Bash]
  files_exist: [out/report.md]
  javascript: "output.length > 10"
---

Prompt body.
`);

    const suite = await loadTaskPackages(taskDir);
    const det = suite.tasks[0].task.deterministic!;
    expect(det.expectContains).toEqual(['hello', 'world']);
    expect(det.expectNotContains).toEqual(['ERROR']);
    expect(det.expectRegex).toEqual(['\\d{4}']);
    expect(det.expectMarker).toBe('DONE');
    expect(det.expectToolCalls).toEqual(['Write']);
    expect(det.expectNoToolCalls).toEqual(['Bash']);
    expect(det.expectFileExists).toEqual(['out/report.md']);
    expect(det.expectJavascript).toBe('output.length > 10');
    expect(det.expectSkillActivation).toBe(false); // no skills present
  });

  it('maps metadata, timeout, and assertions', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---
difficulty: hard
category: docs
tags: [pdf, forms]
timeout_ms: 120000
assertions:
  - "Output is valid JSON"
---

Prompt body.
`);

    const suite = await loadTaskPackages(taskDir);
    const task = suite.tasks[0].task;
    expect(task.difficulty).toBe('hard');
    expect(task.category).toBe('docs');
    expect(task.tags).toEqual(['pdf', 'forms']);
    expect(task.timeoutMs).toBe(120000);
    expect(task.goldenChecklist).toEqual(['Output is valid JSON']);
  });

  it('synthesizes judge criteria for all three dimensions', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, BASIC_TASK);

    const suite = await loadTaskPackages(taskDir, {
      weights: { discovery: 0.2, adherence: 0.5, output: 0.3 },
    });
    const criteria = suite.tasks[0].task.criteria;
    expect(criteria.map((c) => c.dimension)).toEqual(['discovery', 'adherence', 'output']);
    expect(criteria.map((c) => c.weight)).toEqual([0.2, 0.5, 0.3]);
    expect(criteria.every((c) => c.description.length > 0)).toBe(true);
  });
});

describe('loadTaskPackages — expect_skill_invocation', () => {
  it('maps expect_skill_invocation: false to expectedSkillLoad none + no activation', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 'fp-1');
    await writeTask(taskDir, `---\nexpect_skill_invocation: false\n---\n\nPrompt.\n`);
    await writeSkill(path.join(suiteDir, 'skills'), 'my-skill');

    const suite = await loadTaskPackages(taskDir);
    const task = suite.tasks[0].task;
    expect(task.expectedSkillLoad).toBe('none');
    expect(task.deterministic!.expectSkillActivation).toBe(false);
  });

  it('warns when a negative task has output checks', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 'fp-1');
    await writeTask(taskDir, `---\nexpect_skill_invocation: false\nchecks:\n  contains: [hello]\n---\n\nPrompt.\n`);

    const { errors, warnings } = await validateTaskPackages(taskDir);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('no effect on pass/fail'))).toBe(true);
  });
});

describe('loadTaskPackages — skills resolution', () => {
  it('resolves task-level environment/skills and defaults expected_skill to the single skill', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, BASIC_TASK);
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'pdf-tools');

    const suite = await loadTaskPackages(taskDir);
    const lt = suite.tasks[0];
    expect(lt.skillsDir).toBe(path.join(taskDir, 'environment', 'skills'));
    expect(lt.task.expectedSkillLoad).toBe('pdf-tools');
    expect(lt.task.deterministic!.expectSkillActivation).toBe(true);
    expect(suite.skillName).toBe('pdf-tools');
  });

  it('falls back to suite-level skills dir', async () => {
    const suiteDir = await makeTmpDir();
    await writeTask(path.join(suiteDir, 't1'), BASIC_TASK);
    await writeSkill(path.join(suiteDir, 'skills'), 'shared-skill');

    const suite = await loadTaskPackages(suiteDir);
    expect(suite.tasks[0].skillsDir).toBe(path.join(suiteDir, 'skills'));
    expect(suite.tasks[0].task.expectedSkillLoad).toBe('shared-skill');
  });

  it('task-level skills take precedence over suite-level', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, BASIC_TASK);
    await writeSkill(path.join(suiteDir, 'skills'), 'shared-skill');
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'local-skill');

    const suite = await loadTaskPackages(suiteDir);
    expect(suite.tasks[0].task.expectedSkillLoad).toBe('local-skill');
  });

  it('--skills-dir override wins for all tasks', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, BASIC_TASK);
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'local-skill');

    const overrideDir = await makeTmpDir();
    await writeSkill(overrideDir, 'candidate-skill');

    const suite = await loadTaskPackages(taskDir, { skillsDirOverride: overrideDir });
    expect(suite.tasks[0].skillsDir).toBe(path.resolve(overrideDir));
    expect(suite.tasks[0].task.expectedSkillLoad).toBe('candidate-skill');
  });

  it('defaults expected_skill to none when no skills exist', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, BASIC_TASK);

    const suite = await loadTaskPackages(taskDir);
    expect(suite.tasks[0].task.expectedSkillLoad).toBe('none');
    expect(suite.tasks[0].skillsDir).toBeUndefined();
  });

  it('errors when multiple skills exist and expected_skill is not set', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, BASIC_TASK);
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'skill-a');
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'skill-b');

    await expect(loadTaskPackages(taskDir)).rejects.toThrow(/set expected_skill/);
  });

  it('respects explicit expected_skill with multiple skills', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nexpected_skill: skill-b\nchecks: { contains: [x] }\n---\n\nPrompt.\n`);
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'skill-a');
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'skill-b');

    const suite = await loadTaskPackages(taskDir);
    expect(suite.tasks[0].task.expectedSkillLoad).toBe('skill-b');
  });
});

describe('loadTaskPackages — suite loading', () => {
  it('loads multiple task packages from a suite dir', async () => {
    const suiteDir = await makeTmpDir();
    await writeTask(path.join(suiteDir, 'a-task'), BASIC_TASK);
    await writeTask(path.join(suiteDir, 'b-task'), BASIC_TASK);
    await writeSkill(path.join(suiteDir, 'skills'), 'greeting');

    const suite = await loadTaskPackages(suiteDir);
    expect(suite.tasks.map((t) => t.task.id)).toEqual(['a-task', 'b-task']);
    expect(suite.skillName).toBe('greeting');
  });

  it('errors on duplicate task ids across a suite', async () => {
    const suiteDir = await makeTmpDir();
    await writeTask(path.join(suiteDir, 'dir-one'), `---\nid: dir-one\nchecks: { contains: [x] }\n---\n\nPrompt.\n`);
    await writeTask(path.join(suiteDir, 'dir-two'), BASIC_TASK);
    // dir-two claims dir-one's id via a mismatch — construct duplicates via validate result instead
    const { errors } = await validateTaskPackages(suiteDir);
    expect(errors).toEqual([]);

    // Now create a true duplicate: same id in two dirs is impossible via dir names,
    // so a duplicate only occurs when frontmatter id matches another dir's name —
    // which is also an id/dirname mismatch. Verify both errors are reported.
    await writeTask(path.join(suiteDir, 'dir-three'), `---\nid: dir-one\nchecks: { contains: [x] }\n---\n\nPrompt.\n`);
    const dup = await validateTaskPackages(suiteDir);
    expect(dup.errors.some((e) => e.includes("Duplicate task id 'dir-one'"))).toBe(true);
  });

  it('errors when a dir contains no task packages', async () => {
    const suiteDir = await makeTmpDir();
    await fs.mkdir(path.join(suiteDir, 'not-a-task'), { recursive: true });

    await expect(loadTaskPackages(suiteDir)).rejects.toThrow(/No task packages found/);
  });

  it('errors on a nonexistent path', async () => {
    const result = await validateTaskPackages(path.join(os.tmpdir(), 'definitely-missing-dir-xyz'));
    expect(result.errors[0]).toMatch(/Not a directory/);
  });
});

describe('loadTaskPackages — verifier and oracle resolution', () => {
  it('resolves verifier/verify.mjs and oracle/solve.mjs', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `Prompt only, verifier provides the checks.\n`);
    await fs.mkdir(path.join(taskDir, 'verifier'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'verifier', 'verify.mjs'), 'process.exit(0);');
    await fs.mkdir(path.join(taskDir, 'oracle'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'oracle', 'solve.mjs'), '// noop');

    const suite = await loadTaskPackages(taskDir);
    const lt = suite.tasks[0];
    expect(lt.verifierScript).toBe(path.join(taskDir, 'verifier', 'verify.mjs'));
    expect(lt.oracleScript).toBe(path.join(taskDir, 'oracle', 'solve.mjs'));
  });

  it('carries verifier frontmatter timeout and command', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nverifier: { timeout_ms: 5000, command: "node check.mjs" }\n---\n\nPrompt.\n`);

    const suite = await loadTaskPackages(taskDir);
    expect(suite.tasks[0].verifierTimeoutMs).toBe(5000);
    expect(suite.tasks[0].verifierCommand).toBe('node check.mjs');
  });

  it('errors when verifier block exists but no script or command', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nverifier: { timeout_ms: 5000 }\n---\n\nPrompt.\n`);

    await expect(loadTaskPackages(taskDir)).rejects.toThrow(/verifier block present but no/);
  });

  it('resolves environment/workspace as seed dir', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, BASIC_TASK);
    await fs.mkdir(path.join(taskDir, 'environment', 'workspace'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'environment', 'workspace', 'seed.txt'), 'seed');

    const suite = await loadTaskPackages(taskDir);
    expect(suite.tasks[0].workspaceSeedDir).toBe(path.join(taskDir, 'environment', 'workspace'));
  });
});

describe('loadTaskPackages — warnings', () => {
  it('warns on unknown frontmatter keys', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nchecks: { contains: [x] }\nfuture_field: 42\nanother_one: yes\n---\n\nPrompt.\n`);

    const { errors, warnings } = await validateTaskPackages(taskDir);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('future_field') && w.includes('another_one'))).toBe(true);
  });

  it('warns on unknown checks keys', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nchecks:\n  contains: [x]\n  fancy_check: [y]\n---\n\nPrompt.\n`);

    const { errors, warnings } = await validateTaskPackages(taskDir);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('fancy_check'))).toBe(true);
  });

  it('warns when expected_skill is not among available skills', async () => {
    const suiteDir = await makeTmpDir();
    const taskDir = path.join(suiteDir, 't1');
    await writeTask(taskDir, `---\nexpected_skill: missing-skill\nchecks: { contains: [x] }\n---\n\nPrompt.\n`);
    await writeSkill(path.join(taskDir, 'environment', 'skills'), 'real-skill');

    const { warnings } = await validateTaskPackages(taskDir);
    expect(warnings.some((w) => w.includes('missing-skill'))).toBe(true);
  });
});
