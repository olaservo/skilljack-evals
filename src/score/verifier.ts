/**
 * Cross-platform verifier executor.
 *
 * Runs a task package's verifier (or oracle) script in a trial workspace with
 * the SkillsBench-style env contract:
 *   SKILLJACK_OUTPUT_FILE      - path to a file containing the agent's final output
 *   SKILLJACK_TRAJECTORY_FILE  - path to a JSON file of the agent's tool calls
 *   SKILLJACK_TASK_DIR         - path to the task package directory
 *   SKILLJACK_REWARD_FILE      - path the script may write a float reward (0..1) to
 *
 * Reward: reward file contents when written (clamped 0..1, NaN → 0), else the
 * exit code (0 → 1, nonzero → 0). Never throws — all failure modes return a
 * structured VerifierOutcome.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ToolCallRecord, VerifierOutcome } from '../types.js';

export type { VerifierOutcome, VerifierStatus } from '../types.js';

export const DEFAULT_VERIFIER_TIMEOUT_MS = 60_000;

export interface VerifierInvocation {
  file: string;
  args: string[];
}

export interface InterpreterResolution {
  /** Candidate invocations tried in order; ENOENT falls through to the next. */
  candidates: VerifierInvocation[];
  /** Set when no interpreter can be dispatched for the script. */
  error?: string;
}

/**
 * Resolve the interpreter invocation(s) for a verifier script by extension.
 * Pure function — exported for unit testing the dispatch table.
 */
export function resolveInterpreter(scriptPath: string, platform: NodeJS.Platform = process.platform): InterpreterResolution {
  const ext = path.extname(scriptPath).toLowerCase();

  switch (ext) {
    case '.mjs':
    case '.js':
      return { candidates: [{ file: process.execPath, args: [scriptPath] }] };
    case '.py':
      return platform === 'win32'
        ? {
            candidates: [
              { file: 'py', args: ['-3', scriptPath] },
              { file: 'python', args: [scriptPath] },
            ],
          }
        : {
            candidates: [
              { file: 'python3', args: [scriptPath] },
              { file: 'python', args: [scriptPath] },
            ],
          };
    case '.sh':
      return { candidates: [{ file: 'bash', args: [scriptPath] }] };
    case '.ps1':
      return {
        candidates: [
          { file: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath] },
        ],
      };
    default:
      return {
        candidates: [],
        error: `Unsupported verifier script extension '${ext}' (${scriptPath}). Supported: .mjs, .js, .py, .sh, .ps1 — or set verifier.command in task.md frontmatter.`,
      };
  }
}

export interface ExecuteVerifierOptions {
  /** Path to the verifier script. Optional when `command` is provided. */
  scriptPath?: string;
  /** Explicit command override (split on spaces, run with shell:false). */
  command?: string;
  /** Trial workspace — becomes the script's cwd. */
  workspaceDir: string;
  /** Task package directory (SKILLJACK_TASK_DIR). */
  taskDir: string;
  outputFile: string;
  trajectoryFile: string;
  rewardFile: string;
  timeoutMs?: number;
}

interface ExecAttempt {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  enoent: boolean;
  errorMessage?: string;
}

function execAttempt(
  invocation: VerifierInvocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecAttempt> {
  return new Promise((resolve) => {
    execFile(
      invocation.file,
      invocation.args,
      { cwd, env, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, timedOut: false, enoent: false });
          return;
        }
        const execErr = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        const timedOut = execErr.killed === true;
        const enoent = execErr.code === 'ENOENT';
        const exitCode = typeof execErr.code === 'number' ? execErr.code : null;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode,
          timedOut,
          enoent,
          errorMessage: execErr.message,
        });
      },
    );
  });
}

/**
 * Parse the reward file into a clamped [0, 1] float. Returns null when the
 * file was not written.
 */
async function readReward(rewardFile: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.readFile(rewardFile, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseFloat(raw.trim());
  if (Number.isNaN(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Execute a verifier (or oracle) script against an existing set of contract
 * files. Never throws.
 */
export async function executeVerifier(options: ExecuteVerifierOptions): Promise<VerifierOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const started = Date.now();

  const outcome = (partial: Partial<VerifierOutcome> & Pick<VerifierOutcome, 'status'>): VerifierOutcome => {
    const reward = partial.reward ?? 0;
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      ...partial,
      reward,
      passed: reward >= 1,
    };
  };

  let candidates: VerifierInvocation[];
  if (options.command) {
    const parts = options.command.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return outcome({ status: 'error', stderr: 'verifier.command is empty' });
    }
    candidates = [{ file: parts[0], args: parts.slice(1) }];
  } else if (options.scriptPath) {
    const resolution = resolveInterpreter(options.scriptPath);
    if (resolution.error || resolution.candidates.length === 0) {
      return outcome({ status: 'error', stderr: resolution.error ?? 'No interpreter available' });
    }
    candidates = resolution.candidates;
  } else {
    return outcome({ status: 'error', stderr: 'No verifier script or command provided' });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SKILLJACK_OUTPUT_FILE: options.outputFile,
    SKILLJACK_TRAJECTORY_FILE: options.trajectoryFile,
    SKILLJACK_TASK_DIR: options.taskDir,
    SKILLJACK_REWARD_FILE: options.rewardFile,
  };

  let attempt: ExecAttempt | undefined;
  for (const invocation of candidates) {
    attempt = await execAttempt(invocation, options.workspaceDir, env, timeoutMs);
    if (!attempt.enoent) break;
  }

  if (!attempt || attempt.enoent) {
    const isShell = options.scriptPath?.toLowerCase().endsWith('.sh');
    const hint = isShell
      ? 'bash is not available on this system. Use --sandbox docker or provide a verify.mjs instead of a .sh verifier.'
      : `Interpreter not found for ${options.scriptPath ?? options.command}. Tried: ${candidates.map((c) => c.file).join(', ')}.`;
    return outcome({ status: 'missing-interpreter', stderr: hint });
  }

  if (attempt.timedOut) {
    return outcome({
      status: 'timeout',
      exitCode: attempt.exitCode,
      stdout: attempt.stdout,
      stderr: attempt.stderr || `Verifier timed out after ${timeoutMs}ms`,
    });
  }

  const rewardFromFile = await readReward(options.rewardFile);
  const reward = rewardFromFile !== null
    ? rewardFromFile
    : attempt.exitCode === 0
      ? 1
      : 0;

  return outcome({
    status: attempt.exitCode === null && attempt.errorMessage ? 'error' : 'ok',
    reward,
    exitCode: attempt.exitCode,
    stdout: attempt.stdout,
    stderr: attempt.stderr,
  });
}

export interface RunVerifierOptions {
  scriptPath?: string;
  command?: string;
  workspaceDir: string;
  taskDir: string;
  /** Agent's final output — written to SKILLJACK_OUTPUT_FILE. */
  output: string;
  /** Agent's tool calls — written as JSON to SKILLJACK_TRAJECTORY_FILE. */
  toolCalls: ToolCallRecord[];
  timeoutMs?: number;
}

/**
 * Run a task's verifier: materializes the contract files in a temp dir,
 * executes the script, and cleans up. Never throws.
 */
export async function runVerifier(options: RunVerifierOptions): Promise<VerifierOutcome> {
  let contractDir: string;
  try {
    contractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skilljack-verifier-'));
  } catch (err) {
    return {
      reward: 0,
      passed: false,
      exitCode: null,
      status: 'error',
      stdout: '',
      stderr: `Failed to create verifier temp dir: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
    };
  }

  const outputFile = path.join(contractDir, 'output.txt');
  const trajectoryFile = path.join(contractDir, 'trajectory.json');
  const rewardFile = path.join(contractDir, 'reward.txt');

  try {
    await fs.writeFile(outputFile, options.output, 'utf-8');
    await fs.writeFile(trajectoryFile, JSON.stringify(options.toolCalls, null, 2), 'utf-8');

    return await executeVerifier({
      scriptPath: options.scriptPath,
      command: options.command,
      workspaceDir: options.workspaceDir,
      taskDir: options.taskDir,
      outputFile,
      trajectoryFile,
      rewardFile,
      timeoutMs: options.timeoutMs,
    });
  } finally {
    await fs.rm(contractDir, { recursive: true, force: true }).catch(() => {});
  }
}
