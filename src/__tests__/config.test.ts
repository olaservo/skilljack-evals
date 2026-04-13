import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  it('returns defaults when config file does not exist', async () => {
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config).toBeDefined();
    expect(config.runnerType).toBe('claude-sdk');
    expect(config.defaultWeights).toEqual({
      discovery: 0.3,
      adherence: 0.4,
      output: 0.3,
    });
    expect(config.taskTimeoutMs).toBe(300000);
  });

  it('loads valid YAML config file', async () => {
    const jsonPath = path.resolve('package.json');
    const config = await loadConfig(jsonPath);
    expect(config).toBeDefined();
  });

  it('throws on invalid runner type in config file', async () => {
    const tmpDir = path.join(os.tmpdir(), `eval-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, 'runner:\n  type: invalid-runner\n');

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid runner type');
  });
});

describe('loadConfig htmlReport', () => {
  const tmpDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.EVAL_HTML_REPORT = process.env.EVAL_HTML_REPORT;
    delete process.env.EVAL_HTML_REPORT;
  });

  afterEach(async () => {
    if (savedEnv.EVAL_HTML_REPORT !== undefined) {
      process.env.EVAL_HTML_REPORT = savedEnv.EVAL_HTML_REPORT;
    } else {
      delete process.env.EVAL_HTML_REPORT;
    }
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  it('defaults to true', async () => {
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.htmlReport).toBe(true);
  });

  it('YAML ci.html_report: false overrides the default', async () => {
    const tmpDir = path.join(os.tmpdir(), `eval-html-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, 'ci:\n  html_report: false\n');

    const config = await loadConfig(configPath);
    expect(config.htmlReport).toBe(false);
  });

  it('EVAL_HTML_REPORT=false env var sets it to false', async () => {
    process.env.EVAL_HTML_REPORT = 'false';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.htmlReport).toBe(false);
  });

  it('EVAL_HTML_REPORT=FALSE env var sets it to false (case-insensitive)', async () => {
    process.env.EVAL_HTML_REPORT = 'FALSE';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.htmlReport).toBe(false);
  });

  it('EVAL_HTML_REPORT=true env var sets it to true', async () => {
    process.env.EVAL_HTML_REPORT = 'true';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.htmlReport).toBe(true);
  });

  it('CLI override takes precedence over env var', async () => {
    process.env.EVAL_HTML_REPORT = 'true';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml', { htmlReport: false });
    expect(config.htmlReport).toBe(false);
  });

  it('CLI override takes precedence over YAML', async () => {
    const tmpDir = path.join(os.tmpdir(), `eval-html-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, 'ci:\n  html_report: false\n');

    const config = await loadConfig(configPath, { htmlReport: true });
    expect(config.htmlReport).toBe(true);
  });
});
