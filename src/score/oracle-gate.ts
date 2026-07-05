/**
 * Oracle gate (used by `skilljack-evals validate`): prove a task is solvable
 * and its verifier isn't broken. Runs oracle/solve.* in a fresh seeded
 * workspace (skills mounted at the selected runner's discovery path), then
 * requires the task's verifier to yield reward 1.0.
 *
 * The verifier is dispatched through runVerifier — the same routing as `run`
 * — so --sandbox docker containerizes it here too. The oracle itself (a
 * reference solution) always runs on the host.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { LoadedTask } from '../task/load.js';
import type { SandboxMode } from '../config.js';
import { createTrialWorkspace } from '../run/workspace.js';
import { executeVerifier, runVerifier } from './verifier.js';

export interface OracleGateOptions {
  /** Verifier sandbox mode ('docker' routes the verifier into a container). */
  sandbox?: SandboxMode;
  /** Workspace-relative skills mount path for the selected runner. */
  skillsMountPath?: string;
}

export interface OracleGateResult {
  ok: boolean;
  detail: string;
}

/**
 * Run the oracle gate for a single task: execute the oracle in a fresh seeded
 * workspace (skills mounted), then require the verifier to yield reward 1.0.
 */
export async function runOracleGate(lt: LoadedTask, options: OracleGateOptions = {}): Promise<OracleGateResult> {
  const scratchBase = await fs.mkdtemp(path.join(os.tmpdir(), 'skilljack-oracle-'));
  try {
    const workspace = await createTrialWorkspace({
      baseDir: scratchBase,
      taskId: lt.task.id,
      runIndex: 0,
      seedDir: lt.workspaceSeedDir,
      skillsDir: lt.skillsDir,
      skillsMountPath: options.skillsMountPath,
    });

    const outputFile = path.join(scratchBase, 'output.txt');
    const trajectoryFile = path.join(scratchBase, 'trajectory.json');
    const rewardFile = path.join(scratchBase, 'reward.txt');
    await fs.writeFile(outputFile, '', 'utf-8');
    await fs.writeFile(trajectoryFile, '[]', 'utf-8');

    const oracle = await executeVerifier({
      workspaceDir: workspace.dir,
      taskDir: lt.taskDir,
      outputFile,
      trajectoryFile,
      rewardFile,
      timeoutMs: lt.verifierTimeoutMs,
      scriptPath: lt.oracleScript,
    });
    if (oracle.status !== 'ok' || oracle.exitCode !== 0) {
      return {
        ok: false,
        detail: `oracle failed (status ${oracle.status}, exit ${oracle.exitCode})${oracle.stderr ? `: ${oracle.stderr.slice(0, 200)}` : ''}`,
      };
    }

    // runVerifier materializes FRESH contract files, so a reward the oracle
    // may have written cannot leak into the verifier's result; output the
    // oracle wrote to SKILLJACK_OUTPUT_FILE is carried over.
    const oracleOutput = await fs.readFile(outputFile, 'utf-8').catch(() => '');
    const verifier = await runVerifier({
      scriptPath: lt.verifierScript,
      command: lt.verifierCommand,
      workspaceDir: workspace.dir,
      taskDir: lt.taskDir,
      output: oracleOutput,
      toolCalls: [],
      timeoutMs: lt.verifierTimeoutMs,
      sandbox: options.sandbox,
    });
    if (verifier.reward < 1) {
      return {
        ok: false,
        detail: `verifier reward ${verifier.reward} after oracle (status ${verifier.status})${verifier.stderr ? `: ${verifier.stderr.slice(0, 200)}` : ''}`,
      };
    }

    return { ok: true, detail: 'oracle → verifier reward 1.0' };
  } finally {
    await fs.rm(scratchBase, { recursive: true, force: true }).catch(() => {});
  }
}
