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
import type { EvalTask, TaskResult } from '../types.js';

export interface TaskCacheabilityContext {
  /** True when the task package has a verifier script or command. */
  hasVerifier?: boolean;
  /** True when the task package has an environment/workspace/ seed dir. */
  hasWorkspaceSeed?: boolean;
}

/**
 * Tasks whose outcome depends on filesystem state (verifiers, workspace seeds,
 * or file-exists assertions) can't be safely cached: a cached TaskResult
 * doesn't represent the current filesystem, so replaying it alongside fresh
 * deterministic scoring would produce wrong scores.
 */
export function isTaskCacheable(task: EvalTask, context: TaskCacheabilityContext = {}): boolean {
  if (context.hasVerifier) return false;
  if (context.hasWorkspaceSeed) return false;
  if (task.deterministic?.expectFileExists && task.deterministic.expectFileExists.length > 0) {
    return false;
  }
  return true;
}

export interface CacheConfig {
  enabled: boolean;
  dir: string;
  ttlHours: number;
}

export interface CacheKeyParams {
  taskId: string;
  prompt: string;
  model: string;
  runnerType: string;
  skillsHash: string;
  /** Hash of the task's environment/workspace/ seed contents. 'no-environment' when absent. */
  environmentHash: string;
  taskTimeoutMs: number;
  allowedWriteDirs: string[];
  runIndex?: number;
}

export interface CacheKeyInputs {
  taskId: string;
  cacheKeyPrefix: string;
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
    if (config.ttlHours <= 0) {
      throw new Error('Cache TTL must be a positive number of hours');
    }
    this.config = config;
  }

  /**
   * Look up a cached TaskResult by key. Returns null on miss, expiry, or error.
   */
  async get(key: string): Promise<TaskResult | null> {
    if (!this.config.enabled) return null;
    if (!/^[a-f0-9]{64}$/.test(key)) {
      return null;
    }
    try {
      const filePath = path.join(this.config.dir, `${key}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      const entry = JSON.parse(content);

      // Shape check — guard against stale or corrupted entries
      if (!entry?.taskResult?.taskId || !entry?.cachedAt) {
        return null;
      }

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
    if (!this.config.enabled) return;
    if (!/^[a-f0-9]{64}$/.test(key)) {
      return;
    }
    try {
      await fs.mkdir(this.config.dir, { recursive: true });

      const entry: CacheEntry = {
        taskResult: result,
        cachedAt: new Date().toISOString(),
        cacheKeyInputs: keyInputs,
      };

      const filePath = path.join(this.config.dir, `${key}.json`);
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2));
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      console.warn(`Cache write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Remove all cached entries. Returns the count of deleted files.
   */
  async clear(): Promise<{ deletedCount: number }> {
    try {
      const entries = await fs.readdir(this.config.dir);
      const cacheFiles = entries.filter(e => /^[a-f0-9]{64}\.json$/.test(e));
      await Promise.all(
        cacheFiles.map(f => fs.unlink(path.join(this.config.dir, f)))
      );
      return { deletedCount: cacheFiles.length };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        // Directory doesn't exist — nothing to clear
        return { deletedCount: 0 };
      }
      throw err;
    }
  }

  /**
   * Execution-semantics version salt. Bump whenever a runner's execution
   * behavior changes in a way that makes previously cached TaskResults
   * unrepresentative (e.g. v2: opencode gained per-trial isolation env and
   * builtin-skill filtering) — otherwise stale pre-change results replay as
   * fresh until the TTL expires.
   */
  private static readonly EXECUTION_SCHEMA_VERSION = 2;

  /**
   * Compute a deterministic SHA-256 cache key from execution-affecting params.
   */
  static computeCacheKey(params: CacheKeyParams): string {
    const canonical: Record<string, unknown> = {
      v: ResponseCache.EXECUTION_SCHEMA_VERSION,
      taskId: params.taskId,
      prompt: params.prompt,
      model: params.model,
      runnerType: params.runnerType,
      skillsHash: params.skillsHash,
      environmentHash: params.environmentHash,
      taskTimeoutMs: params.taskTimeoutMs,
      allowedWriteDirs: [...params.allowedWriteDirs].sort(),
    };
    if (params.runIndex !== undefined) {
      canonical.runIndex = params.runIndex;
    }
    const json = JSON.stringify(canonical);
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Compute a content hash of a task's environment/workspace/ seed directory.
   * Returns 'no-environment' when the task has no seed dir.
   */
  static async hashEnvironment(seedDir: string | undefined): Promise<string> {
    if (!seedDir) return 'no-environment';
    const hash = await ResponseCache.hashSkillsDir(seedDir);
    return hash === 'no-skills' ? 'no-environment' : hash;
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

      // Normalize to relative paths first, then sort for cross-platform determinism
      const relativePaths = files.map(f => path.relative(skillsDir, f).split(path.sep).join('/'));
      relativePaths.sort();

      const hash = crypto.createHash('sha256');
      for (const relPath of relativePaths) {
        const content = await fs.readFile(path.join(skillsDir, relPath));
        hash.update(relPath);
        hash.update('\0');
        hash.update(content);
      }
      return hash.digest('hex');
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return 'no-skills';
      }
      throw err;
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
