import { describe, it, expect, afterEach } from 'vitest';
import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createEvalTemplate, validateEvalFile, parseEvalFile } from '../parser.js';

describe('createEvalTemplate', () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    for (const f of tmpFiles) {
      await fs.rm(f, { force: true }).catch(() => {});
    }
    tmpFiles.length = 0;
  });

  it('generates correct number of positive + 1 false-positive task', () => {
    const template = createEvalTemplate('my-skill', 5);
    const doc = yaml.load(template) as { tasks: { id: string; deterministic?: { expect_skill_activation: boolean } }[] };

    const positive = doc.tasks.filter(t => t.deterministic?.expect_skill_activation !== false);
    const fp = doc.tasks.filter(t => t.deterministic?.expect_skill_activation === false);

    expect(positive).toHaveLength(4);
    expect(fp).toHaveLength(1);
    expect(doc.tasks).toHaveLength(5);
  });

  it('ensures at least 1 positive task when numTasks is 1', () => {
    const template = createEvalTemplate('my-skill', 1);
    const doc = yaml.load(template) as { tasks: { id: string; deterministic?: { expect_skill_activation: boolean } }[] };

    const positive = doc.tasks.filter(t => t.deterministic?.expect_skill_activation !== false);
    const fp = doc.tasks.filter(t => t.deterministic?.expect_skill_activation === false);

    expect(positive).toHaveLength(1);
    expect(fp).toHaveLength(1);
    // Total is 2 because we always guarantee at least 1 positive + 1 FP
    expect(doc.tasks).toHaveLength(2);
  });

  it('produces valid YAML that round-trips', () => {
    const template = createEvalTemplate('test-skill', 3);
    const doc = yaml.load(template) as Record<string, unknown>;

    expect(doc).toBeDefined();
    expect(doc.skill).toBe('test-skill');
    expect(doc.version).toBe('1.0');
    expect(Array.isArray(doc.tasks)).toBe(true);
  });

  it('has unique task IDs', () => {
    const template = createEvalTemplate('my-skill', 10);
    const doc = yaml.load(template) as { tasks: { id: string }[] };

    const ids = doc.tasks.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('false-positive task has expected_skill_load: none', () => {
    const template = createEvalTemplate('my-skill', 3);
    const doc = yaml.load(template) as { tasks: { id: string; expected_skill_load?: string; deterministic?: { expect_skill_activation: boolean } }[] };

    const fp = doc.tasks.find(t => t.deterministic?.expect_skill_activation === false);
    expect(fp).toBeDefined();
    expect(fp!.expected_skill_load).toBe('none');
  });

  it('passes validateEvalFile', async () => {
    const template = createEvalTemplate('my-skill', 5);
    const tmpFile = path.join(os.tmpdir(), `parser-test-${Date.now()}.yaml`);
    tmpFiles.push(tmpFile);

    await fs.writeFile(tmpFile, template);
    const errors = await validateEvalFile(tmpFile);

    expect(errors).toEqual([]);
  });
});

describe('parseEvalFile — deterministic assertion fields', () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    for (const f of tmpFiles) {
      await fs.rm(f, { force: true }).catch(() => {});
    }
    tmpFiles.length = 0;
  });

  async function writeAndParse(yamlContent: string) {
    const tmpFile = path.join(os.tmpdir(), `parser-det-${Date.now()}.yaml`);
    tmpFiles.push(tmpFile);
    await fs.writeFile(tmpFile, yamlContent);
    return parseEvalFile(tmpFile);
  }

  it('parses expect_contains and expect_not_contains', async () => {
    const eval_ = await writeAndParse(`
skill: test
tasks:
  - id: t1
    prompt: test
    deterministic:
      expect_contains:
        - "hello"
        - "world"
      expect_not_contains:
        - "error"
`);
    const det = eval_.tasks[0].deterministic!;
    expect(det.expectContains).toEqual(['hello', 'world']);
    expect(det.expectNotContains).toEqual(['error']);
  });

  it('parses expect_regex', async () => {
    const eval_ = await writeAndParse(`
skill: test
tasks:
  - id: t1
    prompt: test
    deterministic:
      expect_regex:
        - "\\\\d{4}-\\\\d{2}-\\\\d{2}"
        - "^hello"
`);
    const det = eval_.tasks[0].deterministic!;
    expect(det.expectRegex).toHaveLength(2);
  });

  it('parses expect_javascript', async () => {
    const eval_ = await writeAndParse(`
skill: test
tasks:
  - id: t1
    prompt: test
    deterministic:
      expect_javascript: "output.length > 10"
`);
    const det = eval_.tasks[0].deterministic!;
    expect(det.expectJavascript).toBe('output.length > 10');
  });

  it('parses expect_file_exists', async () => {
    const eval_ = await writeAndParse(`
skill: test
tasks:
  - id: t1
    prompt: test
    deterministic:
      expect_file_exists:
        - "./output.json"
        - "./report.md"
`);
    const det = eval_.tasks[0].deterministic!;
    expect(det.expectFileExists).toEqual(['./output.json', './report.md']);
  });

  it('leaves new fields undefined when not specified', async () => {
    const eval_ = await writeAndParse(`
skill: test
tasks:
  - id: t1
    prompt: test
    deterministic:
      expect_skill_activation: true
`);
    const det = eval_.tasks[0].deterministic!;
    expect(det.expectContains).toBeUndefined();
    expect(det.expectNotContains).toBeUndefined();
    expect(det.expectRegex).toBeUndefined();
    expect(det.expectJavascript).toBeUndefined();
    expect(det.expectFileExists).toBeUndefined();
  });
});
