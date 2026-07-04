/**
 * Shared CLI subprocess utilities for harness runners.
 *
 * runCliJsonl spawns an agent CLI (shell:false), collects stdout as JSONL
 * events, and — critically — kills the entire process tree on timeout or
 * abort: `taskkill /pid <pid> /T /F` on Windows, detached process-group
 * SIGKILL on POSIX. The old Promise.race timeout in BaseRunner abandoned the
 * in-flight work but leaked the child process; this utility actually
 * terminates it.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

export interface RunCliJsonlOptions {
  /** Executable to spawn (resolved via PATH). */
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process tree after this many ms (undefined/0 = no timeout). */
  timeoutMs?: number;
  /** Optional stdin content. stdin is closed after writing (or immediately). */
  input?: string;
  /** Optional abort signal — kills the process tree when fired. */
  signal?: AbortSignal;
}

export interface CliJsonlResult {
  /** Parsed JSON values, one per stdout line that parsed as JSON. */
  events: unknown[];
  /** Non-JSON stdout lines, kept raw (banners, warnings, plain text). */
  rawLines: string[];
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface CliDetection {
  available: boolean;
  version?: string;
  reason?: string;
}

/** How long to wait for a `close` event after a tree kill before giving up. */
const KILL_GRACE_MS = 5000;

/**
 * Kill a child process and all of its descendants.
 *
 * Windows: `taskkill /pid <pid> /T /F` (spawned directly, no shell).
 * POSIX: the child is spawned detached (own process group), so kill the group.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => {
        // taskkill unavailable — fall back to killing the root process.
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/**
 * Spawn a CLI and collect its stdout as JSONL events.
 *
 * Lines that parse as JSON land in `events`; everything else is preserved in
 * `rawLines`. Never uses a shell, so prompt arguments need no quoting. On
 * timeout or abort the whole process tree is killed before resolving.
 */
export async function runCliJsonl(options: RunCliJsonlOptions): Promise<CliJsonlResult> {
  const start = Date.now();
  const isWindows = process.platform === 'win32';

  return new Promise<CliJsonlResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      // POSIX: own process group so the whole tree can be killed at once.
      detached: !isWindows,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const events: unknown[] = [];
    const rawLines: string[] = [];
    let stderr = '';
    let stdoutBuffer = '';
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          events.push(JSON.parse(trimmed));
          return;
        } catch {
          // Not valid JSON after all — keep as a raw line.
        }
      }
      rawLines.push(line);
    };

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stdoutBuffer) consumeLine(stdoutBuffer.replace(/\r$/, ''));
      resolve({
        events,
        rawLines,
        stderr,
        exitCode,
        durationMs: Date.now() - start,
        timedOut,
      });
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    /**
     * Safety net after a tree kill: if `close` never fires (e.g. taskkill
     * raced an already-exiting process oddly), detach the streams and resolve.
     */
    const scheduleForceFinish = () => {
      if (forceTimer) return;
      forceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, KILL_GRACE_MS);
      forceTimer.unref?.();
    };

    const onAbort = () => {
      killProcessTree(child);
      scheduleForceFinish();
    };

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        consumeLine(line);
      }
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        scheduleForceFinish();
      }, options.timeoutMs);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', fail);
    child.on('close', (code) => finish(code));

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

/**
 * Check whether a CLI is available by running its version command.
 *
 * ENOENT (and Windows' EINVAL for non-directly-spawnable shims) yields
 * `available: false` with the caller-provided install hint in the reason.
 */
export async function detectCli(
  command: string,
  versionArgs: string[] = ['--version'],
  options: { timeoutMs?: number; installHint?: string } = {},
): Promise<CliDetection> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const hint = options.installHint ? ` ${options.installHint}` : '';

  try {
    const result = await runCliJsonl({ command, args: versionArgs, timeoutMs });
    if (result.timedOut) {
      return {
        available: false,
        reason: `${command} ${versionArgs.join(' ')} timed out after ${timeoutMs}ms.${hint}`,
      };
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().slice(0, 200);
      return {
        available: false,
        reason: `${command} ${versionArgs.join(' ')} exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}.${hint}`,
      };
    }
    const version = result.rawLines.join(' ').trim() || undefined;
    return { available: true, version };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'EINVAL') {
      return { available: false, reason: `${command} not found on PATH.${hint}` };
    }
    return {
      available: false,
      reason: `${command} could not be executed: ${err instanceof Error ? err.message : String(err)}.${hint}`,
    };
  }
}
