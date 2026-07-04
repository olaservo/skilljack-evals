/**
 * Google ADK Runner (subprocess bridge)
 *
 * Wraps the Python google-adk SDK by spawning python/adk_runner.py as a
 * subprocess. Task spec is sent on stdin as JSON; the script returns a single
 * JSON line on stdout with the final response.
 *
 * v1: returns output, numTurns, durationMs only. toolCalls and skillLoads
 * are empty — see plan for follow-up work to wire those through.
 *
 * Requires Python 3 + `pip install -r python/requirements.txt` + GOOGLE_API_KEY.
 */

import type { EvalTask, TaskResult } from '../types.js';
import { BaseRunner } from './base-runner.js';
import type { SessionLogger } from '../session/session-logger.js';

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

interface AdkResult {
  output: string;
  numTurns: number;
  durationMs: number;
  skillLoads: string[];
}

function resolveScriptPath(): string {
  // python/adk_runner.py lives at the repo root and is NOT compiled into dist.
  // The distance from this module to the repo root differs between layouts:
  //   dev  (tsx):  src/runner/google-adk-runner.ts      → ../../python
  //   built (tsc): dist/src/runner/google-adk-runner.js  → ../../../python
  // Probe the candidates and return the first that exists.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'python', 'adk_runner.py'),
    path.resolve(here, '..', '..', '..', 'python', 'adk_runner.py'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

function resolvePythonBin(): string {
  const override = process.env.PYTHON_BIN;
  if (override && override.trim()) return override.trim();
  return process.platform === 'win32' ? 'python' : 'python3';
}

function parseAdkResult(stdout: string): AdkResult {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('ADK subprocess produced no output');
  }
  const last = lines[lines.length - 1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`ADK subprocess output was not JSON: ${detail}\nLast line: ${last}`);
  }
  const obj = parsed as Partial<AdkResult>;
  if (typeof obj.output !== 'string' || typeof obj.numTurns !== 'number' || typeof obj.durationMs !== 'number') {
    throw new Error(`ADK subprocess returned malformed result: ${last}`);
  }
  return {
    output: obj.output,
    numTurns: obj.numTurns,
    durationMs: obj.durationMs,
    skillLoads: Array.isArray(obj.skillLoads) ? obj.skillLoads.filter((s): s is string => typeof s === 'string') : [],
  };
}

export class GoogleAdkRunner extends BaseRunner {
  readonly providerName = 'google-adk';

  async runTask(task: EvalTask, logger?: SessionLogger): Promise<TaskResult> {
    const startTime = Date.now();
    const cwd = this.options.cwd ?? process.cwd();
    const model = this.options.model ?? 'gemini-2.5-flash';
    const scriptPath = resolveScriptPath();
    const pythonBin = resolvePythonBin();

    try {
      const result = await this.spawnPython(pythonBin, scriptPath, cwd, {
        taskId: task.id,
        prompt: task.prompt,
        model,
        cwd,
      });

      logger?.addTextMessage(result.output);

      return this.buildTaskResult(task, {
        output: result.output,
        durationMs: result.durationMs || (Date.now() - startTime),
        numTurns: result.numTurns,
        costUsd: 0,
        skillLoads: result.skillLoads,
        toolCalls: [],
      });
    } catch (error) {
      return this.handleRunError(task, error, startTime, logger);
    }
  }

  protected spawnPython(
    pythonBin: string,
    scriptPath: string,
    cwd: string,
    payload: Record<string, unknown>,
  ): Promise<AdkResult> {
    // google-genai expects GOOGLE_API_KEY; users with Vercel-AI .env may have
    // GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY instead. Alias any of them.
    const env = { ...process.env };
    if (!env.GOOGLE_API_KEY) {
      env.GOOGLE_API_KEY = env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY;
    }

    return new Promise<AdkResult>((resolve, reject) => {
      const child = spawn(pythonBin, [scriptPath], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });

      child.on('error', (err) => {
        const hint = err && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? ` (is "${pythonBin}" on PATH? Set PYTHON_BIN to override.)`
          : '';
        reject(new Error(`Failed to spawn ADK subprocess: ${err.message}${hint}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const tail = stderr.trim().split(/\r?\n/).slice(-10).join('\n');
          reject(new Error(`ADK subprocess exited ${code}\n${tail || '(no stderr)'}`));
          return;
        }
        try {
          resolve(parseAdkResult(stdout));
        } catch (err) {
          reject(err);
        }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }
}
