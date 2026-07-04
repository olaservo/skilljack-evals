/**
 * SkillsBench/BenchFlow interop tests: import a hand-built SkillsBench-style
 * fixture (a tiny mimic, NOT copied from .inbox), and round-trip one of our
 * committed task packages through export → import.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { importSkillsBenchTask } from '../task/import-skillsbench.js';
import { exportSkillsBenchTask } from '../task/export-skillsbench.js';
import { validateTaskPackages } from '../task/load.js';
import { extractFrontmatterBlock, stripFrontmatter } from '../runner/skill-discovery.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GR_001_DIR = path.join(REPO_ROOT, 'evals', 'example-greeting', 'gr-001');

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFrontmatter(taskMdPath: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(taskMdPath, 'utf-8');
  const block = extractFrontmatterBlock(content);
  return block ? (yaml.load(block) as Record<string, unknown>) : {};
}

/** Build a tiny SkillsBench-style task package mimic (schema_version 1.3 shape). */
async function buildSkillsBenchFixture(): Promise<string> {
  const parent = await makeTmpDir();
  const dir = path.join(parent, 'invoice-filler');
  await fs.mkdir(path.join(dir, 'environment', 'skills', 'invoicing'), { recursive: true });
  await fs.mkdir(path.join(dir, 'verifier'), { recursive: true });
  await fs.mkdir(path.join(dir, 'oracle'), { recursive: true });

  await fs.writeFile(path.join(dir, 'task.md'), `---
schema_version: '1.3'
metadata:
  author_name: Test Author
  difficulty: easy
  category: office
  tags: [invoice, template]
  task_type: [generation]
verifier:
  type: test-script
  timeout_sec: 120.0
  hardening:
    cleanup_conftests: true
agent:
  timeout_sec: 600.0
environment:
  network_mode: public
  os: linux
some_future_key: hello
---

Fill in the invoice template using the data in customers.json.
`, 'utf-8');

  await fs.writeFile(
    path.join(dir, 'environment', 'skills', 'invoicing', 'SKILL.md'),
    '---\nname: invoicing\ndescription: Fill invoice templates.\n---\n\n# Invoicing\n',
    'utf-8',
  );
  await fs.writeFile(path.join(dir, 'environment', 'customers.json'), '{"name":"Acme"}', 'utf-8');
  await fs.writeFile(path.join(dir, 'environment', 'Dockerfile'), 'FROM ubuntu:24.04\n', 'utf-8');
  await fs.writeFile(path.join(dir, 'verifier', 'test.sh'), '#!/bin/bash\necho 1 > /logs/verifier/reward.txt\n', 'utf-8');
  await fs.writeFile(path.join(dir, 'verifier', 'test_outputs.py'), 'def test(): pass\n', 'utf-8');
  await fs.writeFile(path.join(dir, 'oracle', 'solve.sh'), '#!/bin/bash\necho done\n', 'utf-8');

  return dir;
}

describe('importSkillsBenchTask', () => {
  it('maps frontmatter, copies the layout, and preserves unknowns under x_skillsbench', async () => {
    const src = await buildSkillsBenchFixture();
    const out = await makeTmpDir();

    const { taskDir, warnings } = await importSkillsBenchTask(src, { outDir: out });

    expect(taskDir).toBe(path.join(out, 'invoice-filler'));

    const fm = await readFrontmatter(path.join(taskDir, 'task.md'));
    expect(fm.difficulty).toBe('easy');
    expect(fm.category).toBe('office');
    expect(fm.tags).toEqual(['invoice', 'template']);
    expect(fm.timeout_ms).toBe(600000);
    expect((fm.verifier as Record<string, unknown>).timeout_ms).toBe(120000);
    // .sh verifier → requires_docker tag.
    expect(fm.requires_docker).toBe(true);

    // Unmapped keys preserved, not dropped.
    const x = fm.x_skillsbench as Record<string, unknown>;
    expect(x.schema_version).toBe('1.3');
    expect((x.metadata as Record<string, unknown>).author_name).toBe('Test Author');
    expect((x.metadata as Record<string, unknown>).task_type).toEqual(['generation']);
    expect((x.verifier as Record<string, unknown>).type).toBe('test-script');
    expect((x.environment as Record<string, unknown>).network_mode).toBe('public');
    expect(x.some_future_key).toBe('hello');
    expect(warnings.some((w) => w.includes('some_future_key'))).toBe(true);
    expect(warnings.some((w) => w.includes('requires_docker'))).toBe(true);

    // Prompt body verbatim.
    const body = stripFrontmatter(await fs.readFile(path.join(taskDir, 'task.md'), 'utf-8')).trim();
    expect(body).toBe('Fill in the invoice template using the data in customers.json.');

    // Layout: skills stay skills, other environment files become workspace seeds.
    expect(await exists(path.join(taskDir, 'environment', 'skills', 'invoicing', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(taskDir, 'environment', 'workspace', 'customers.json'))).toBe(true);
    expect(await exists(path.join(taskDir, 'environment', 'Dockerfile'))).toBe(true);
    expect(await exists(path.join(taskDir, 'verifier', 'test.sh'))).toBe(true);
    expect(await exists(path.join(taskDir, 'verifier', 'test_outputs.py'))).toBe(true);
    expect(await exists(path.join(taskDir, 'oracle', 'solve.sh'))).toBe(true);
  });

  it('produces a package that passes our loader validation', async () => {
    const src = await buildSkillsBenchFixture();
    const out = await makeTmpDir();
    const { taskDir } = await importSkillsBenchTask(src, { outDir: out });

    const { errors, suite } = await validateTaskPackages(taskDir);
    expect(errors).toEqual([]);
    expect(suite!.tasks).toHaveLength(1);
    expect(suite!.tasks[0].task.id).toBe('invoice-filler');
    expect(suite!.tasks[0].task.expectedSkillLoad).toBe('invoicing');
    expect(suite!.tasks[0].verifierScript).toContain('test.sh');
  });

  it('refuses to clobber an existing target', async () => {
    const src = await buildSkillsBenchFixture();
    const out = await makeTmpDir();
    await importSkillsBenchTask(src, { outDir: out });
    await expect(importSkillsBenchTask(src, { outDir: out })).rejects.toThrow('already exists');
  });
});

describe('exportSkillsBenchTask', () => {
  it('emits a BenchFlow-native package from gr-001', async () => {
    const out = path.join(await makeTmpDir(), 'gr-001');
    const { outDir, warnings } = await exportSkillsBenchTask(GR_001_DIR, { outDir: out });

    const fm = await readFrontmatter(path.join(outDir, 'task.md'));
    expect(fm.schema_version).toBe('1.3');
    expect((fm.metadata as Record<string, unknown>).difficulty).toBe('medium');
    expect((fm.verifier as Record<string, unknown>).type).toBe('test-script');
    expect(typeof (fm.verifier as Record<string, unknown>).timeout_sec).toBe('number');
    expect(typeof (fm.agent as Record<string, unknown>).timeout_sec).toBe('number');
    expect((fm.environment as Record<string, unknown>).os).toBe('linux');

    // Round-trip payload for our native fields.
    const x = fm.x_skilljack as Record<string, unknown>;
    expect((x.checks as Record<string, unknown>).marker).toBe('GREETING_SUCCESS');
    expect(x.expected_skill).toBe('greeting');

    // Layout: skills (suite-level for gr-001), verifier wrapper + original,
    // oracle wrapper + original, Dockerfile stub.
    expect(await exists(path.join(outDir, 'environment', 'skills', 'greeting', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(outDir, 'environment', 'Dockerfile'))).toBe(true);
    expect(await exists(path.join(outDir, 'verifier', 'verify.mjs'))).toBe(true);
    expect(await exists(path.join(outDir, 'oracle', 'solve.mjs'))).toBe(true);
    expect(await exists(path.join(outDir, 'oracle', 'solve.sh'))).toBe(true);

    const testSh = await fs.readFile(path.join(outDir, 'verifier', 'test.sh'), 'utf-8');
    expect(testSh).toContain('node /verifier/verify.mjs');
    expect(testSh).toContain('/logs/verifier/reward.txt');

    expect(warnings.length).toBeGreaterThanOrEqual(0);
  });

  it('compiles lite-checks-only tasks into a generated checks.mjs verifier', async () => {
    // Build a lite task (checks only, no verifier dir).
    const parent = await makeTmpDir();
    const taskDir = path.join(parent, 'lite-task');
    await fs.mkdir(path.join(taskDir, 'environment', 'skills', 'greeting'), { recursive: true });
    await fs.writeFile(
      path.join(taskDir, 'environment', 'skills', 'greeting', 'SKILL.md'),
      '---\nname: greeting\ndescription: Greet.\n---\n# G\n',
      'utf-8',
    );
    await fs.writeFile(path.join(taskDir, 'task.md'), `---
checks:
  contains: [GREETING_SUCCESS]
  marker: GREETING_SUCCESS
  tool_calls: [Read]
  javascript: "output.length > 5"
---

Greet me.
`, 'utf-8');

    const out = path.join(await makeTmpDir(), 'lite-task');
    const { outDir, warnings } = await exportSkillsBenchTask(taskDir, { outDir: out });

    const checksMjs = await fs.readFile(path.join(outDir, 'verifier', 'checks.mjs'), 'utf-8');
    expect(checksMjs).toContain('GREETING_SUCCESS');
    const testSh = await fs.readFile(path.join(outDir, 'verifier', 'test.sh'), 'utf-8');
    expect(testSh).toContain('node /verifier/checks.mjs');

    // Host-only concepts warned as dropped.
    expect(warnings.some((w) => w.includes('tool_calls') && w.includes('javascript'))).toBe(true);
  });
});

describe('export → import round-trip (gr-001)', () => {
  it('survives with checks and prompt intact and validates under the loader', async () => {
    const exportOut = path.join(await makeTmpDir(), 'gr-001');
    const { outDir } = await exportSkillsBenchTask(GR_001_DIR, { outDir: exportOut });

    const importOut = await makeTmpDir();
    const { taskDir } = await importSkillsBenchTask(outDir, { outDir: importOut });

    // Loader validates the re-imported package.
    const { errors, suite } = await validateTaskPackages(taskDir);
    expect(errors).toEqual([]);
    const lt = suite!.tasks[0];

    // Prompt survives verbatim.
    const originalPrompt = stripFrontmatter(await fs.readFile(path.join(GR_001_DIR, 'task.md'), 'utf-8')).trim();
    expect(lt.task.prompt).toBe(originalPrompt);

    // Checks survive the round-trip via x_skilljack.
    expect(lt.task.deterministic?.expectMarker).toBe('GREETING_SUCCESS');
    expect(lt.task.deterministic?.expectContains).toEqual(['GREETING_SUCCESS']);
    expect(lt.task.deterministic?.expectNotContains).toEqual(['ERROR', 'FIXME']);
    expect(lt.task.expectedSkillLoad).toBe('greeting');
    expect(lt.task.goldenChecklist.length).toBeGreaterThan(0);

    // The loader picks verify.mjs (host-runnable), so no requires_docker tag.
    const fm = await readFrontmatter(path.join(taskDir, 'task.md'));
    expect(fm.requires_docker).toBeUndefined();

    // Skills came along.
    expect(lt.skillsDir).toBeDefined();
    expect(await exists(path.join(lt.skillsDir!, 'greeting', 'SKILL.md'))).toBe(true);
  });
});
