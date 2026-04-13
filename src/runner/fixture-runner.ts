/**
 * Fixture script execution for evaluation tasks.
 *
 * Runs setup/teardown scripts defined in FixtureConfig before and after
 * task execution. Scripts are executed via child_process.execFile in the
 * task's working directory.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface FixtureExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

/**
 * Execute a fixture script (setup or teardown) in the given working directory.
 *
 * Never throws — all errors are captured and returned as a structured result
 * so the caller can decide how to handle failure (skip task vs. warn).
 *
 * @param scriptPath - Path to the script (absolute, or relative to cwd)
 * @param cwd - Working directory for execution
 * @param timeoutMs - Maximum execution time in milliseconds (default: 30000)
 */
export async function runFixtureScript(
  scriptPath: string,
  cwd: string,
  timeoutMs: number = 30_000,
): Promise<FixtureExecResult> {
  const resolvedPath = path.resolve(cwd, scriptPath);

  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, [], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
    });

    return {
      success: true,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
    };
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      message?: string;
    };

    const stdout = execErr.stdout ?? '';
    const stderr = execErr.stderr ?? '';

    let errorMessage: string;
    if (execErr.killed) {
      errorMessage = `Script timed out after ${timeoutMs}ms: ${resolvedPath}`;
    } else if (execErr.code === 'ENOENT' || (execErr.message && execErr.message.includes('ENOENT'))) {
      errorMessage = `Script not found: ${resolvedPath}`;
    } else {
      errorMessage = execErr.message || `Script failed with exit code ${execErr.code}: ${resolvedPath}`;
    }

    return {
      success: false,
      stdout,
      stderr,
      errorMessage,
    };
  }
}
