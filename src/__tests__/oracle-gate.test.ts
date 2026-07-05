/**
 * Oracle-gate tests (validate's solvability proof):
 * - verifier execution routes through runVerifier, so --sandbox docker
 *   reaches the docker dispatch;
 * - the workspace mounts skills at the selected runner's mount path
 *   (e.g. codex: .agents/skills);
 * - output the oracle wrote to SKILLJACK_OUTPUT_FILE is carried into the
 *   verifier contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LoadedTask } from '../task/load.js';
import type { RunVerifierOptions } from '../score/verifier.js';
import type { VerifierOutcome } from '../types.js';

const runVerifierCalls: RunVerifierOptions[] = [];
let workspaceSkillMountSeen: string | undefined;

const passingOutcome: VerifierOutcome = {
  reward: 1, passed: true, exitCode: 0, status: 'ok', stdout: '', stderr: '', durationMs: 1,
};
let runVerifierImpl: (options: RunVerifierOptions) => Promise<VerifierOutcome> =
  async () => passingOutcome;

vi.mock('../score/verifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../score/verifier.js')>();
  return {
    ...actual,
    runVerifier: async (options: RunVerifierOptions): Promise<VerifierOutcome> => {
      runVerifierCalls.push(options);
      // Capture where skills were mounted while the workspace still exists.
      for (const mount of [path.join('.agents', 'skills'), path.join('.claude', 'skills')]) {
        if (existsSync(path.join(options.workspaceDir, mount, 'greeting', 'SKILL.md'))) {
          workspaceSkillMountSeen = mount;
        }
      }
      return runVerifierImpl(options);
    },
  };
});

const tmpDirs: string[] = [];

async function makeTaskPackage(): Promise<LoadedTask> {
  const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-gate-test-'));
  tmpDirs.push(taskDir);

  await fs.mkdir(path.join(taskDir, 'verifier'), { recursive: true });
  await fs.writeFile(path.join(taskDir, 'verifier', 'verify.mjs'), 'process.exit(0);\n', 'utf-8');

  await fs.mkdir(path.join(taskDir, 'oracle'), { recursive: true });
  await fs.writeFile(
    path.join(taskDir, 'oracle', 'solve.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.SKILLJACK_OUTPUT_FILE, 'ORACLE_OUTPUT');\n",
    'utf-8',
  );

  const skillsDir = path.join(taskDir, 'environment', 'skills');
  await fs.mkdir(path.join(skillsDir, 'greeting'), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, 'greeting', 'SKILL.md'),
    '---\nname: greeting\ndescription: greet\n---\n\n# Greeting\n',
    'utf-8',
  );

  return {
    task: { id: 'og-001', prompt: 'Greet me.', expectedSkillLoad: 'greeting', criteria: [], goldenChecklist: [] },
    taskDir,
    skillsDir,
    verifierScript: path.join(taskDir, 'verifier', 'verify.mjs'),
    oracleScript: path.join(taskDir, 'oracle', 'solve.mjs'),
  };
}

beforeEach(() => {
  runVerifierCalls.length = 0;
  workspaceSkillMountSeen = undefined;
  runVerifierImpl = async () => passingOutcome;
});

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe('runOracleGate', () => {
  it('routes the verifier through runVerifier with sandbox docker and the runner mount path', async () => {
    const { runOracleGate } = await import('../score/oracle-gate.js');
    const lt = await makeTaskPackage();

    const result = await runOracleGate(lt, {
      sandbox: 'docker',
      skillsMountPath: path.join('.agents', 'skills'), // codex
    });

    expect(result.ok).toBe(true);
    expect(runVerifierCalls).toHaveLength(1);
    // Docker routing reaches the shared runVerifier dispatch.
    expect(runVerifierCalls[0].sandbox).toBe('docker');
    expect(runVerifierCalls[0].scriptPath).toBe(lt.verifierScript);
    // Skills were mounted where the SELECTED runner (codex) discovers them.
    expect(workspaceSkillMountSeen).toBe(path.join('.agents', 'skills'));
    // Oracle-written output is carried into the verifier contract.
    expect(runVerifierCalls[0].output).toBe('ORACLE_OUTPUT');
  }, 30000);

  it('defaults to host sandbox and the default mount path when no options are given', async () => {
    const { runOracleGate } = await import('../score/oracle-gate.js');
    const lt = await makeTaskPackage();

    const result = await runOracleGate(lt);

    expect(result.ok).toBe(true);
    expect(runVerifierCalls[0].sandbox).toBeUndefined();
    expect(workspaceSkillMountSeen).toBe(path.join('.claude', 'skills'));
  }, 30000);

  it('fails when the verifier rewards below 1 after the oracle', async () => {
    const { runOracleGate } = await import('../score/oracle-gate.js');
    const lt = await makeTaskPackage();
    runVerifierImpl = async () => ({
      reward: 0.5, passed: false, exitCode: 0, status: 'ok', stdout: '', stderr: 'partial', durationMs: 1,
    });

    const result = await runOracleGate(lt);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('verifier reward 0.5');
  }, 30000);
});
