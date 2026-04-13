/**
 * Content-addressed response cache for task execution results.
 *
 * Caches TaskResult objects keyed by a SHA-256 hash of execution-affecting
 * inputs (prompt, model, runner type, skill content, timeout, allowed dirs).
 * Scoring/judging config is NOT part of the key — only agent execution is cached.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { TaskResult } from '../types.js';
import type { RunnerType } from '../config.js';

export interface CacheConfig {
  enabled: boolean;
  dir: string;
  ttlHours: number;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  enabled: true,
  dir: './results/.cache',
  ttlHours: 168, // 7 days
};

export interface CacheKeyParams {
  taskId: string;
  prompt: string;
  model: string;
  runnerType: RunnerType;
  skillsHash: string;
  taskTimeoutMs: number;
  allowedWriteDirs: string[];
}

export interface CacheKeyInputs {
  taskId: string;
  promptHash: string;
  modelId: string;
  runnerType: string;
  skillsHash: string;
}

export interface CacheEntry {
  taskResult: TaskResult;
  cachedAt: string;
  cacheKeyInputs: CacheKeyInputs;
}

export class ResponseCache {
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
  }

  /**
   * Look up a cached TaskResult by key. Returns null on miss, expiry, or error.
   */
  async get(key: string): Promise<TaskResult | null> {
    try {
      const filePath = path.join(this.config.dir, `${key}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      const entry: CacheEntry = JSON.parse(content);

      // TTL check
      const age = Date.now() - new Date(entry.cachedAt).getTime();
      if (age > this.config.ttlHours * 3600 * 1000) {
        return null;
      }

      return entry.taskResult;
    } catch {
      return null;
    }
  }

  /**
   * Store a TaskResult in the cache.
   */
  async set(key: string, result: TaskResult, keyInputs: CacheKeyInputs): Promise<void> {
    try {
      await fs.mkdir(this.config.dir, { recursive: true });

      const entry: CacheEntry = {
        taskResult: result,
        cachedAt: new Date().toISOString(),
        cacheKeyInputs: keyInputs,
      };

      const filePath = path.join(this.config.dir, `${key}.json`);
      await fs.writeFile(filePath, JSON.stringify(entry, null, 2));
    } catch (err) {
      console.warn(`Cache write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Remove all cached entries. Returns the count of deleted files.
   */
  async clear(): Promise<{ deletedCount: number }> {
    let deletedCount = 0;
    try {
      const entries = await fs.readdir(this.config.dir);
      for (const entry of entries) {
        if (entry.endsWith('.json')) {
          await fs.unlink(path.join(this.config.dir, entry));
          deletedCount++;
        }
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        // Directory doesn't exist — nothing to clear
        return { deletedCount: 0 };
      }
      throw err;
    }
    return { deletedCount };
  }

  /**
   * Compute a deterministic SHA-256 cache key from execution-affecting params.
   */
  static computeCacheKey(params: CacheKeyParams): string {
    const canonical = {
      taskId: params.taskId,
      prompt: params.prompt,
      model: params.model,
      runnerType: params.runnerType,
      skillsHash: params.skillsHash,
      taskTimeoutMs: params.taskTimeoutMs,
      allowedWriteDirs: [...params.allowedWriteDirs].sort(),
    };
    const json = JSON.stringify(canonical);
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Compute a content hash of all files in a skills directory.
   *
   * Hashes file paths (relative, sorted) and contents for determinism.
   * Returns 'no-skills' when skillsDir is undefined or missing.
   */
  static async hashSkillsDir(skillsDir: string | undefined): Promise<string> {
    if (!skillsDir) return 'no-skills';

    try {
      const files = await collectFiles(skillsDir);
      if (files.length === 0) return 'no-skills';

      // Sort for determinism
      files.sort();

      const hash = crypto.createHash('sha256');
      for (const filePath of files) {
        const relativePath = path.relative(skillsDir, filePath);
        const content = await fs.readFile(filePath);
        hash.update(relativePath);
        hash.update(content);
      }
      return hash.digest('hex');
    } catch {
      return 'no-skills';
    }
  }
}

/**
 * Recursively collect all file paths in a directory.
 */
async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }

  return results;
}
