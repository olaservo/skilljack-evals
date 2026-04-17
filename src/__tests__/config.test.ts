import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { loadConfig, DEFAULT_CONFIG } from '../config.js';

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

describe('concurrency config', () => {
  const tmpDirs: string[] = [];
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.EVAL_RUNNER_CONCURRENCY;
    delete process.env.EVAL_RUNNER_CONCURRENCY;
  });

  afterEach(async () => {
    if (savedEnv !== undefined) {
      process.env.EVAL_RUNNER_CONCURRENCY = savedEnv;
    } else {
      delete process.env.EVAL_RUNNER_CONCURRENCY;
    }
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  it('defaults concurrency to 1 (sequential)', async () => {
    expect(DEFAULT_CONFIG.concurrency).toBe(1);
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.concurrency).toBe(1);
  });

  it('loads concurrency from EVAL_RUNNER_CONCURRENCY env var', async () => {
    process.env.EVAL_RUNNER_CONCURRENCY = '5';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.concurrency).toBe(5);
  });

  it('loads concurrency=0 (unlimited) from env var', async () => {
    process.env.EVAL_RUNNER_CONCURRENCY = '0';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.concurrency).toBe(0);
  });

  it('throws on negative EVAL_RUNNER_CONCURRENCY', async () => {
    process.env.EVAL_RUNNER_CONCURRENCY = '-1';
    await expect(loadConfig('/nonexistent/path/eval.config.yaml')).rejects.toThrow('Must be a non-negative integer');
  });

  it('throws on non-integer EVAL_RUNNER_CONCURRENCY', async () => {
    process.env.EVAL_RUNNER_CONCURRENCY = '2.5';
    await expect(loadConfig('/nonexistent/path/eval.config.yaml')).rejects.toThrow('Must be a non-negative integer');
  });

  it('loads concurrency from YAML config', async () => {
    const tmpDir = path.join(os.tmpdir(), `eval-test-concurrency-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, 'runner:\n  concurrency: 3\n');

    const config = await loadConfig(configPath);
    expect(config.concurrency).toBe(3);
  });

  it('CLI override takes precedence over env var', async () => {
    process.env.EVAL_RUNNER_CONCURRENCY = '5';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml', { concurrency: 2 });
    expect(config.concurrency).toBe(2);
  });

  it('throws on negative concurrency in YAML config', async () => {
    const tmpDir = path.join(os.tmpdir(), `eval-test-concurrency-neg-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, 'runner:\n  concurrency: -3\n');

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid runner.concurrency');
  });

  it('throws on non-integer concurrency in YAML config', async () => {
    const tmpDir = path.join(os.tmpdir(), `eval-test-concurrency-float-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, 'runner:\n  concurrency: 2.5\n');

    await expect(loadConfig(configPath)).rejects.toThrow('Must be a non-negative integer');
  });
});
