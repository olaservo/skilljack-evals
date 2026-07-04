import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveInterpreter, runVerifier } from '../score/verifier.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

async function writeScript(dir: string, name: string, content: string): Promise<string> {
  const scriptPath = path.join(dir, name);
  await fs.writeFile(scriptPath, content);
  return scriptPath;
}

describe('resolveInterpreter — dispatch table', () => {
  it('dispatches .mjs and .js to the current node executable', () => {
    for (const ext of ['.mjs', '.js']) {
      const res = resolveInterpreter(`verify${ext}`);
      expect(res.error).toBeUndefined();
      expect(res.candidates).toEqual([{ file: process.execPath, args: [`verify${ext}`] }]);
    }
  });

  it('dispatches .py on win32 to py -3 then python', () => {
    const res = resolveInterpreter('verify.py', 'win32');
    expect(res.candidates).toEqual([
      { file: 'py', args: ['-3', 'verify.py'] },
      { file: 'python', args: ['verify.py'] },
    ]);
  });

  it('dispatches .py on linux to python3 then python', () => {
    const res = resolveInterpreter('verify.py', 'linux');
    expect(res.candidates).toEqual([
      { file: 'python3', args: ['verify.py'] },
      { file: 'python', args: ['verify.py'] },
    ]);
  });

  it('dispatches .sh to bash', () => {
    const res = resolveInterpreter('verify.sh');
    expect(res.candidates).toEqual([{ file: 'bash', args: ['verify.sh'] }]);
  });

  it('dispatches .ps1 to powershell with bypass flags', () => {
    const res = resolveInterpreter('verify.ps1');
    expect(res.candidates).toEqual([
      { file: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'verify.ps1'] },
    ]);
  });

  it('returns an error for unsupported extensions', () => {
    const res = resolveInterpreter('verify.rb');
    expect(res.candidates).toEqual([]);
    expect(res.error).toContain('.rb');
  });
});

describe('runVerifier — execution (.mjs via process.execPath)', () => {
  it('uses the reward file when written', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'verify.mjs', `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.SKILLJACK_REWARD_FILE, '0.5');
    `);

    const outcome = await runVerifier({
      scriptPath: script, workspaceDir: dir, taskDir: dir, output: 'out', toolCalls: [],
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.reward).toBe(0.5);
    expect(outcome.passed).toBe(false);
    expect(outcome.exitCode).toBe(0);
  });

  it('clamps rewards above 1 and below 0', async () => {
    const dir = await makeTmpDir();
    const over = await writeScript(dir, 'over.mjs', `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.SKILLJACK_REWARD_FILE, '42');
    `);
    const under = await writeScript(dir, 'under.mjs', `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.SKILLJACK_REWARD_FILE, '-3');
    `);

    const overOutcome = await runVerifier({ scriptPath: over, workspaceDir: dir, taskDir: dir, output: '', toolCalls: [] });
    expect(overOutcome.reward).toBe(1);
    expect(overOutcome.passed).toBe(true);

    const underOutcome = await runVerifier({ scriptPath: under, workspaceDir: dir, taskDir: dir, output: '', toolCalls: [] });
    expect(underOutcome.reward).toBe(0);
  });

  it('treats a non-numeric reward file as 0', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'verify.mjs', `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.SKILLJACK_REWARD_FILE, 'not-a-number');
    `);

    const outcome = await runVerifier({ scriptPath: script, workspaceDir: dir, taskDir: dir, output: '', toolCalls: [] });
    expect(outcome.reward).toBe(0);
    expect(outcome.passed).toBe(false);
  });

  it('falls back to exit code 0 → reward 1 when no reward file', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'verify.mjs', `process.exit(0);`);

    const outcome = await runVerifier({ scriptPath: script, workspaceDir: dir, taskDir: dir, output: '', toolCalls: [] });
    expect(outcome.reward).toBe(1);
    expect(outcome.passed).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });

  it('falls back to nonzero exit → reward 0', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'verify.mjs', `process.exit(3);`);

    const outcome = await runVerifier({ scriptPath: script, workspaceDir: dir, taskDir: dir, output: '', toolCalls: [] });
    expect(outcome.reward).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(outcome.exitCode).toBe(3);
  });

  it('provides the output and trajectory contract files', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'verify.mjs', `
      import { readFileSync, writeFileSync } from 'node:fs';
      const output = readFileSync(process.env.SKILLJACK_OUTPUT_FILE, 'utf-8');
      const trajectory = JSON.parse(readFileSync(process.env.SKILLJACK_TRAJECTORY_FILE, 'utf-8'));
      console.log('OUTPUT=' + output);
      console.log('TOOLS=' + trajectory.map((t) => t.tool).join(','));
      console.log('CWD=' + process.cwd());
      writeFileSync(process.env.SKILLJACK_REWARD_FILE, '1');
    `);

    const outcome = await runVerifier({
      scriptPath: script,
      workspaceDir: dir,
      taskDir: dir,
      output: 'AGENT_FINAL_OUTPUT',
      toolCalls: [
        { tool: 'Read', toolUseId: '1', timestamp: 1 },
        { tool: 'Write', toolUseId: '2', timestamp: 2 },
      ],
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.stdout).toContain('OUTPUT=AGENT_FINAL_OUTPUT');
    expect(outcome.stdout).toContain('TOOLS=Read,Write');
    // cwd = workspace (compare basename to sidestep symlinked temp dirs)
    expect(outcome.stdout).toContain(`CWD=`);
    expect(outcome.stdout).toContain(path.basename(dir));
  });

  it('times out a hanging verifier with reward 0', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'verify.mjs', `setTimeout(() => {}, 30000);`);

    const outcome = await runVerifier({
      scriptPath: script, workspaceDir: dir, taskDir: dir, output: '', toolCalls: [], timeoutMs: 500,
    });

    expect(outcome.status).toBe('timeout');
    expect(outcome.reward).toBe(0);
    expect(outcome.passed).toBe(false);
  }, 15000);

  it('returns reward 0 for a missing script file', async () => {
    const dir = await makeTmpDir();
    const outcome = await runVerifier({
      scriptPath: path.join(dir, 'does-not-exist.mjs'),
      workspaceDir: dir, taskDir: dir, output: '', toolCalls: [],
    });

    expect(outcome.reward).toBe(0);
    expect(outcome.passed).toBe(false);
  });

  it('returns missing-interpreter for a command whose binary does not exist', async () => {
    const dir = await makeTmpDir();
    const outcome = await runVerifier({
      command: 'definitely-not-a-real-binary-xyz arg1',
      workspaceDir: dir, taskDir: dir, output: '', toolCalls: [],
    });

    expect(outcome.status).toBe('missing-interpreter');
    expect(outcome.reward).toBe(0);
  });

  it('returns an error when neither script nor command is provided', async () => {
    const dir = await makeTmpDir();
    const outcome = await runVerifier({ workspaceDir: dir, taskDir: dir, output: '', toolCalls: [] });

    expect(outcome.status).toBe('error');
    expect(outcome.reward).toBe(0);
  });

  it('supports an explicit command override resolved against the workspace cwd', async () => {
    const dir = await makeTmpDir();
    await writeScript(dir, 'check.mjs', `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.SKILLJACK_REWARD_FILE, '1');
    `);

    const outcome = await runVerifier({
      command: 'node check.mjs',
      workspaceDir: dir, taskDir: dir, output: '', toolCalls: [],
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.passed).toBe(true);
  });
});
