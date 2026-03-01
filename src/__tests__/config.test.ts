import { describe, it, expect, afterEach } from 'vitest';
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
