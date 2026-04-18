import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { ResponseCache, isTaskCacheable } from '../cache/response-cache.js';
import type { CacheConfig, CacheKeyParams } from '../cache/response-cache.js';
import type { EvalTask, TaskResult } from '../types.js';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `eval-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'test-001',
    prompt: 'Test prompt',
    output: 'Test output',
    durationMs: 1234,
    numTurns: 3,
    costUsd: 0.005,
    skillLoads: ['my-skill'],
    toolCalls: [],
    isError: false,
    errorMessage: '',
    ...overrides,
  };
}

// Valid 64-char hex strings for use as cache keys in tests
const hexKey1 = 'a'.repeat(64);
const hexKey2 = 'b'.repeat(64);

function makeKeyParams(overrides: Partial<CacheKeyParams> = {}): CacheKeyParams {
  return {
    taskId: 'test-001',
    prompt: 'Test prompt',
    model: 'sonnet',
    runnerType: 'claude-sdk',
    skillsHash: 'abc123',
    fixturesHash: 'no-fixture',
    taskTimeoutMs: 300000,
    allowedWriteDirs: ['./results/', './fixtures/'],
    ...overrides,
  };
}

const keyInputs = {
  taskId: 'test-001',
  cacheKeyPrefix: 'abcd1234',
  modelId: 'sonnet',
  runnerType: 'claude-sdk',
  skillsHash: 'abc123',
};

describe('ResponseCache.computeCacheKey', () => {
  it('produces deterministic hashes for identical inputs', () => {
    const params = makeKeyParams();
    const key1 = ResponseCache.computeCacheKey(params);
    const key2 = ResponseCache.computeCacheKey(params);
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64); // SHA-256 hex
  });

  it('produces different hashes when prompt changes', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ prompt: 'prompt A' }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ prompt: 'prompt B' }));
    expect(key1).not.toBe(key2);
  });

  it('produces different hashes when model changes', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ model: 'sonnet' }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ model: 'haiku' }));
    expect(key1).not.toBe(key2);
  });

  it('produces different hashes when runner type changes', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ runnerType: 'claude-sdk' }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ runnerType: 'vercel-ai' }));
    expect(key1).not.toBe(key2);
  });

  it('produces different hashes when skills hash changes', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ skillsHash: 'hash-a' }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ skillsHash: 'hash-b' }));
    expect(key1).not.toBe(key2);
  });

  it('produces different hashes when fixtures hash changes', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ fixturesHash: 'fx-a' }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ fixturesHash: 'fx-b' }));
    expect(key1).not.toBe(key2);
  });

  it('produces different hashes when timeout changes', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ taskTimeoutMs: 300000 }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ taskTimeoutMs: 600000 }));
    expect(key1).not.toBe(key2);
  });

  it('produces different hashes when allowedWriteDirs changes', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ allowedWriteDirs: ['./a/'] }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ allowedWriteDirs: ['./b/'] }));
    expect(key1).not.toBe(key2);
  });

  it('produces same hash regardless of allowedWriteDirs order', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ allowedWriteDirs: ['./a/', './b/'] }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ allowedWriteDirs: ['./b/', './a/'] }));
    expect(key1).toBe(key2);
  });

  it('produces different hashes for different run indices', () => {
    const key0 = ResponseCache.computeCacheKey(makeKeyParams({ runIndex: 0 }));
    const key1 = ResponseCache.computeCacheKey(makeKeyParams({ runIndex: 1 }));
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ runIndex: 2 }));
    expect(key0).not.toBe(key1);
    expect(key1).not.toBe(key2);
    expect(key0).not.toBe(key2);
  });

  it('produces same hash when runIndex is undefined (single-run mode)', () => {
    const key1 = ResponseCache.computeCacheKey(makeKeyParams());
    const key2 = ResponseCache.computeCacheKey(makeKeyParams({ runIndex: undefined }));
    expect(key1).toBe(key2);
  });

  it('produces different hash with vs without runIndex', () => {
    const keyNoIndex = ResponseCache.computeCacheKey(makeKeyParams());
    const keyWithIndex = ResponseCache.computeCacheKey(makeKeyParams({ runIndex: 0 }));
    expect(keyNoIndex).not.toBe(keyWithIndex);
  });
});

describe('ResponseCache.hashSkillsDir', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  it('returns sentinel for undefined skillsDir', async () => {
    expect(await ResponseCache.hashSkillsDir(undefined)).toBe('no-skills');
  });

  it('returns sentinel for nonexistent directory', async () => {
    expect(await ResponseCache.hashSkillsDir('/nonexistent/path')).toBe('no-skills');
  });

  it('returns sentinel for empty directory', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });
    expect(await ResponseCache.hashSkillsDir(dir)).toBe('no-skills');
  });

  it('produces consistent hashes for same contents', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    await fs.mkdir(path.join(dir, 'skill-a'), { recursive: true });
    await fs.writeFile(path.join(dir, 'skill-a', 'SKILL.md'), '# My Skill');

    const hash1 = await ResponseCache.hashSkillsDir(dir);
    const hash2 = await ResponseCache.hashSkillsDir(dir);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('produces different hashes when file contents change', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    await fs.mkdir(path.join(dir, 'skill-a'), { recursive: true });

    await fs.writeFile(path.join(dir, 'skill-a', 'SKILL.md'), '# Version 1');
    const hash1 = await ResponseCache.hashSkillsDir(dir);

    await fs.writeFile(path.join(dir, 'skill-a', 'SKILL.md'), '# Version 2');
    const hash2 = await ResponseCache.hashSkillsDir(dir);

    expect(hash1).not.toBe(hash2);
  });
});

describe('isTaskCacheable', () => {
  function makeTask(overrides: Partial<EvalTask> = {}): EvalTask {
    return {
      id: 't1',
      prompt: 'p',
      expectedSkillLoad: 'none',
      criteria: [],
      goldenChecklist: [],
      ...overrides,
    };
  }

  it('caches a plain task with no fixture or file checks', () => {
    expect(isTaskCacheable(makeTask())).toBe(true);
  });

  it('does not cache tasks with a fixture', () => {
    expect(isTaskCacheable(makeTask({ fixture: { state: 'dirty', setup: 'setup.sh' } }))).toBe(false);
  });

  it('does not cache tasks with fixture.state only (still fs-stateful by author claim)', () => {
    expect(isTaskCacheable(makeTask({ fixture: { state: 'clean' } }))).toBe(false);
  });

  it('does not cache tasks with expectFileExists assertions', () => {
    expect(isTaskCacheable(makeTask({
      deterministic: { expectSkillActivation: true, expectFileExists: ['./out.txt'] },
    }))).toBe(false);
  });

  it('caches tasks with other deterministic checks but no file-exists', () => {
    expect(isTaskCacheable(makeTask({
      deterministic: { expectSkillActivation: true, expectMarker: 'DONE' },
    }))).toBe(true);
  });

  it('caches tasks with an empty expectFileExists array', () => {
    expect(isTaskCacheable(makeTask({
      deterministic: { expectSkillActivation: true, expectFileExists: [] },
    }))).toBe(true);
  });
});

describe('ResponseCache.hashFixtures', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  it('returns sentinel when fixture is undefined', async () => {
    expect(await ResponseCache.hashFixtures(undefined, process.cwd())).toBe('no-fixture');
  });

  it('returns sentinel when fixture has only a state marker (no scripts)', async () => {
    expect(await ResponseCache.hashFixtures({ state: 'clean' }, process.cwd())).toBe('no-fixture');
  });

  it('produces a stable hash for the same script contents', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'setup.sh'), '#!/bin/sh\necho hi');

    const h1 = await ResponseCache.hashFixtures({ state: 's', setup: 'setup.sh' }, dir);
    const h2 = await ResponseCache.hashFixtures({ state: 's', setup: 'setup.sh' }, dir);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('changes hash when setup script contents change', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(path.join(dir, 'setup.sh'), 'v1');
    const h1 = await ResponseCache.hashFixtures({ state: 's', setup: 'setup.sh' }, dir);

    await fs.writeFile(path.join(dir, 'setup.sh'), 'v2');
    const h2 = await ResponseCache.hashFixtures({ state: 's', setup: 'setup.sh' }, dir);

    expect(h1).not.toBe(h2);
  });

  it('changes hash when teardown script contents change', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'setup.sh'), 'setup');

    await fs.writeFile(path.join(dir, 'teardown.sh'), 't1');
    const h1 = await ResponseCache.hashFixtures(
      { state: 's', setup: 'setup.sh', teardown: 'teardown.sh' }, dir,
    );

    await fs.writeFile(path.join(dir, 'teardown.sh'), 't2');
    const h2 = await ResponseCache.hashFixtures(
      { state: 's', setup: 'setup.sh', teardown: 'teardown.sh' }, dir,
    );

    expect(h1).not.toBe(h2);
  });

  it('distinguishes between a missing script and a present one', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });

    const hMissing = await ResponseCache.hashFixtures({ state: 's', setup: 'setup.sh' }, dir);

    await fs.writeFile(path.join(dir, 'setup.sh'), 'content');
    const hPresent = await ResponseCache.hashFixtures({ state: 's', setup: 'setup.sh' }, dir);

    expect(hMissing).not.toBe(hPresent);
  });
});

describe('ResponseCache get/set', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  function makeCache(overrides: Partial<CacheConfig> = {}): ResponseCache {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    return new ResponseCache({ enabled: true, dir, ttlHours: 168, ...overrides });
  }

  it('returns null for missing key', async () => {
    const cache = makeCache();
    const result = await cache.get(hexKey1);
    expect(result).toBeNull();
  });

  it('returns null for invalid key format', async () => {
    const cache = makeCache();
    const result = await cache.get('not-a-valid-hex-key');
    expect(result).toBeNull();
  });

  it('round-trips a TaskResult', async () => {
    const cache = makeCache();
    const taskResult = makeTaskResult();

    await cache.set(hexKey1, taskResult, keyInputs);
    const retrieved = await cache.get(hexKey1);

    expect(retrieved).toEqual(taskResult);
  });

  it('round-trips tokens on a TaskResult', async () => {
    const cache = makeCache();
    const taskResult = makeTaskResult({
      tokens: { input: 1234, output: 567, cacheRead: 89, cacheCreation: 12, total: 1902 },
    });

    await cache.set(hexKey1, taskResult, keyInputs);
    const retrieved = await cache.get(hexKey1);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.tokens).toEqual(taskResult.tokens);
  });

  it('returns null for expired entries', async () => {
    const cache = makeCache({ ttlHours: 1 });
    const taskResult = makeTaskResult();

    // Write the entry, then patch cachedAt to 2 hours ago to guarantee expiry
    await cache.set(hexKey1, taskResult, keyInputs);
    const cacheDir = (cache as unknown as { config: CacheConfig }).config.dir;
    const filePath = path.join(cacheDir, `${hexKey1}.json`);
    const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    raw.cachedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(filePath, JSON.stringify(raw));

    const retrieved = await cache.get(hexKey1);
    expect(retrieved).toBeNull();
  });

  it('short-circuits get and set when disabled', async () => {
    const cache = makeCache({ enabled: false });
    const taskResult = makeTaskResult();

    await cache.set(hexKey1, taskResult, keyInputs);
    const retrieved = await cache.get(hexKey1);
    expect(retrieved).toBeNull();
  });

  it('returns null for malformed cache entries', async () => {
    const cache = makeCache();
    const cacheDir = (cache as unknown as { config: CacheConfig }).config.dir;
    await fs.mkdir(cacheDir, { recursive: true });

    // Write a JSON file missing required fields
    const filePath = path.join(cacheDir, `${hexKey1}.json`);
    await fs.writeFile(filePath, JSON.stringify({ bad: 'data' }));

    const retrieved = await cache.get(hexKey1);
    expect(retrieved).toBeNull();
  });

  it('handles concurrent sets to same key', async () => {
    const cache = makeCache();

    await Promise.all([
      cache.set(hexKey1, makeTaskResult({ output: 'A' }), keyInputs),
      cache.set(hexKey1, makeTaskResult({ output: 'B' }), keyInputs),
    ]);

    const retrieved = await cache.get(hexKey1);
    expect(retrieved).not.toBeNull();
    expect(['A', 'B']).toContain(retrieved!.output);
  });
});

describe('ResponseCache clear', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  it('removes all cached entries', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const cache = new ResponseCache({ enabled: true, dir, ttlHours: 168 });

    await cache.set(hexKey1, makeTaskResult({ taskId: 'a' }), keyInputs);
    await cache.set(hexKey2, makeTaskResult({ taskId: 'b' }), keyInputs);

    const { deletedCount } = await cache.clear();
    expect(deletedCount).toBe(2);

    expect(await cache.get(hexKey1)).toBeNull();
    expect(await cache.get(hexKey2)).toBeNull();
  });

  it('returns 0 for nonexistent cache directory', async () => {
    const cache = new ResponseCache({ enabled: true, dir: '/nonexistent/cache/dir', ttlHours: 168 });
    const { deletedCount } = await cache.clear();
    expect(deletedCount).toBe(0);
  });

  it('only deletes files matching cache key pattern', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const cache = new ResponseCache({ enabled: true, dir, ttlHours: 168 });

    // Write a valid cache entry and a non-cache JSON file
    await cache.set(hexKey1, makeTaskResult({ taskId: 'a' }), keyInputs);
    const fs = await import('fs/promises');
    await fs.writeFile(path.join(dir, 'other-file.json'), '{}');

    const { deletedCount } = await cache.clear();
    expect(deletedCount).toBe(1);

    // Non-cache file should still exist
    const remaining = await fs.readdir(dir);
    expect(remaining).toContain('other-file.json');
  });
});

describe('constructor validation', () => {
  it('rejects zero TTL', () => {
    expect(() => new ResponseCache({ enabled: true, dir: '/tmp', ttlHours: 0 }))
      .toThrow('Cache TTL must be a positive number of hours');
  });

  it('rejects negative TTL', () => {
    expect(() => new ResponseCache({ enabled: true, dir: '/tmp', ttlHours: -1 }))
      .toThrow('Cache TTL must be a positive number of hours');
  });
});
