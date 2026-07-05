import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
    expect(config.taskTimeoutMs).toBe(300000);
  });

  it('warns on removed scoring.weights instead of loading it', async () => {
    const tmpDir = path.join(os.tmpdir(), `eval-test-weights-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, 'scoring:\n  weights:\n    discovery: 0.5\n');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = await loadConfig(configPath);
      expect('defaultWeights' in config).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('scoring.weights was removed in v2'));
    } finally {
      warn.mockRestore();
    }
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

describe('judge + threshold config', () => {
  const tmpDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['EVAL_JUDGE', 'EVAL_RESOLUTION_THRESHOLD', 'EVAL_LIFT_THRESHOLD'];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function writeConfig(content: string): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), `eval-test-judge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);
    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, content);
    return configPath;
  }

  it('judge is disabled by default', async () => {
    expect(DEFAULT_CONFIG.judgeEnabled).toBe(false);
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.judgeEnabled).toBe(false);
  });

  it('resolution threshold defaults to 0.8 and lift threshold is unset', async () => {
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.resolutionThreshold).toBe(0.8);
    expect(config.liftThreshold).toBeUndefined();
  });

  it('EVAL_JUDGE=true enables the judge', async () => {
    process.env.EVAL_JUDGE = 'true';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.judgeEnabled).toBe(true);
  });

  it('EVAL_RESOLUTION_THRESHOLD and EVAL_LIFT_THRESHOLD are honored', async () => {
    process.env.EVAL_RESOLUTION_THRESHOLD = '0.6';
    process.env.EVAL_LIFT_THRESHOLD = '0.15';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(config.resolutionThreshold).toBe(0.6);
    expect(config.liftThreshold).toBe(0.15);
  });

  it('reads judge.enabled + judge.model from the config file', async () => {
    const configPath = await writeConfig('judge:\n  enabled: true\n  model: opus\n');
    const config = await loadConfig(configPath);
    expect(config.judgeEnabled).toBe(true);
    expect(config.defaultJudgeModel).toBe('opus');
  });

  it('reads thresholds.resolution_rate + thresholds.min_lift from the config file', async () => {
    const configPath = await writeConfig('thresholds:\n  resolution_rate: 0.9\n  min_lift: 0.25\n');
    const config = await loadConfig(configPath);
    expect(config.resolutionThreshold).toBe(0.9);
    expect(config.liftThreshold).toBe(0.25);
  });

  it('CLI overrides win over env vars', async () => {
    process.env.EVAL_RESOLUTION_THRESHOLD = '0.6';
    const config = await loadConfig('/nonexistent/path/eval.config.yaml', { resolutionThreshold: 0.95 });
    expect(config.resolutionThreshold).toBe(0.95);
  });
});

describe('removed pre-2.0 threshold surfaces warn instead of silently ignoring', () => {
  const tmpDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['EVAL_DISCOVERY_THRESHOLD', 'EVAL_SCORE_THRESHOLD'];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
    vi.restoreAllMocks();
  });

  async function writeConfig(content: string): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), `eval-test-removed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);
    const configPath = path.join(tmpDir, 'eval.config.yaml');
    await fs.writeFile(configPath, content);
    return configPath;
  }

  it('warns when eval.config.yaml sets thresholds.discovery_rate', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = await writeConfig('thresholds:\n  discovery_rate: 0.9\n');
    const config = await loadConfig(configPath);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('thresholds.discovery_rate/avg_score were removed in v2 and are IGNORED'));
    // The removed keys never leak into the config.
    expect(config.resolutionThreshold).toBe(0.8);
  });

  it('warns when eval.config.yaml sets thresholds.avg_score', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = await writeConfig('thresholds:\n  avg_score: 0.7\n  resolution_rate: 0.9\n');
    const config = await loadConfig(configPath);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('removed in v2 and are IGNORED'));
    // Supported sibling keys still apply.
    expect(config.resolutionThreshold).toBe(0.9);
  });

  it('does not warn for supported thresholds keys', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = await writeConfig('thresholds:\n  resolution_rate: 0.9\n  min_lift: 0.1\n');
    await loadConfig(configPath);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when EVAL_DISCOVERY_THRESHOLD is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EVAL_DISCOVERY_THRESHOLD = '0.9';
    await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EVAL_DISCOVERY_THRESHOLD/EVAL_SCORE_THRESHOLD were removed in v2 and are IGNORED'));
  });

  it('warns when EVAL_SCORE_THRESHOLD is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EVAL_SCORE_THRESHOLD = '0.7';
    await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('removed in v2 and are IGNORED'));
  });

  it('does not warn when neither removed env var is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadConfig('/nonexistent/path/eval.config.yaml');
    expect(warnSpy).not.toHaveBeenCalled();
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
