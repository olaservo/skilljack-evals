/**
 * Docker sandbox tests — mock the docker CLI via the injectable execFn.
 * No live docker daemon required (command construction + reward precedence).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  runVerifierInDocker,
  resolveContainerInterpreter,
  dockerImageTag,
  DEFAULT_DOCKER_IMAGE,
  DOCKER_UNAVAILABLE_HINT,
} from '../sandbox/docker.js';
import type { DockerExecFn, DockerExecResult } from '../sandbox/docker.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-sandbox-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

function okResult(overrides: Partial<DockerExecResult> = {}): DockerExecResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...overrides };
}

/** Extract the host path mounted at a given container path from docker args. */
function hostMountFor(args: string[], containerPath: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-v') {
      const mount = args[i + 1];
      const suffix = `:${containerPath}`;
      if (mount.endsWith(suffix)) return mount.slice(0, -suffix.length);
    }
  }
  return undefined;
}

async function makeTaskDir(verifierFile: string): Promise<string> {
  const taskDir = await makeTmpDir();
  await fs.mkdir(path.join(taskDir, 'verifier'), { recursive: true });
  await fs.writeFile(path.join(taskDir, 'verifier', verifierFile), '// verifier', 'utf-8');
  return taskDir;
}

describe('resolveContainerInterpreter', () => {
  it('dispatches .mjs/.js to node, .py to python3, .sh to bash', () => {
    expect(resolveContainerInterpreter('verifier/verify.mjs').interpreter).toBe('node');
    expect(resolveContainerInterpreter('verifier/verify.js').interpreter).toBe('node');
    expect(resolveContainerInterpreter('verifier/verify.py').interpreter).toBe('python3');
    expect(resolveContainerInterpreter('verifier/test.sh').interpreter).toBe('bash');
  });

  it('rejects .ps1 (no PowerShell in the Linux image)', () => {
    const { interpreter, error } = resolveContainerInterpreter('verifier/verify.ps1');
    expect(interpreter).toBeUndefined();
    expect(error).toContain('.ps1');
  });
});

describe('dockerImageTag', () => {
  it('builds a sanitized tag with a 12-char content hash', () => {
    const tag = dockerImageTag('My Task!', 'FROM node:20-slim\n');
    expect(tag).toMatch(/^skilljack-eval-my-task-[0-9a-f]{12}$/);
  });

  it('changes when the Dockerfile content changes', () => {
    expect(dockerImageTag('t', 'FROM a')).not.toBe(dockerImageTag('t', 'FROM b'));
  });
});

describe('runVerifierInDocker command construction', () => {
  it('runs the default image with workspace/task/logs mounts, env contract, and node dispatch', async () => {
    const taskDir = await makeTaskDir('verify.mjs');
    const workspaceDir = await makeTmpDir();
    const calls: string[][] = [];
    const execFn: DockerExecFn = async (args) => {
      calls.push(args);
      return okResult();
    };

    const outcome = await runVerifierInDocker({
      taskDir,
      workspaceDir,
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: 'agent says hi',
      toolCalls: [],
      execFn,
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.reward).toBe(1); // exit 0, no reward files
    expect(calls).toHaveLength(1);

    const args = calls[0];
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    // Unique --name so the timeout path can force-remove the container.
    expect(args).toContain('--name');
    expect(args[args.indexOf('--name') + 1]).toMatch(/^skilljack-verifier-/);
    expect(hostMountFor(args, '/workspace')).toBe(workspaceDir);
    expect(hostMountFor(args, '/task:ro')).toBe(taskDir);
    expect(hostMountFor(args, '/logs')).toBeDefined();
    // SkillsBench convention: the verifier dir is also mounted at /verifier.
    expect(hostMountFor(args, '/verifier:ro')).toBe(path.join(taskDir, 'verifier'));
    expect(args).toContain('-w');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace');
    expect(args).toContain('SKILLJACK_OUTPUT_FILE=/logs/contract/output.txt');
    expect(args).toContain('SKILLJACK_TRAJECTORY_FILE=/logs/contract/trajectory.json');
    expect(args).toContain('SKILLJACK_TASK_DIR=/task');
    expect(args).toContain('SKILLJACK_REWARD_FILE=/logs/contract/reward.txt');
    // Trailing: <image> <interpreter> /task/verifier/verify.mjs
    expect(args.slice(-3)).toEqual([DEFAULT_DOCKER_IMAGE, 'node', '/task/verifier/verify.mjs']);
  });

  it('dispatches .sh verifiers to bash inside the container (Windows escape hatch)', async () => {
    const taskDir = await makeTaskDir('test.sh');
    const workspaceDir = await makeTmpDir();
    const calls: string[][] = [];
    const execFn: DockerExecFn = async (args) => {
      calls.push(args);
      return okResult();
    };

    await runVerifierInDocker({
      taskDir,
      workspaceDir,
      verifierRelPath: path.join('verifier', 'test.sh'),
      output: '',
      toolCalls: [],
      execFn,
    });

    expect(calls[0].slice(-3)).toEqual([DEFAULT_DOCKER_IMAGE, 'bash', '/task/verifier/test.sh']);
  });

  it('passes extra env vars into the container', async () => {
    const taskDir = await makeTaskDir('verify.mjs');
    const calls: string[][] = [];
    const execFn: DockerExecFn = async (args) => {
      calls.push(args);
      return okResult();
    };

    await runVerifierInDocker({
      taskDir,
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: '',
      toolCalls: [],
      env: { EXTRA_VAR: 'value-1' },
      execFn,
    });

    expect(calls[0]).toContain('EXTRA_VAR=value-1');
  });

  it('materializes output and trajectory into the /logs mount', async () => {
    const taskDir = await makeTaskDir('verify.mjs');
    let contractOutput = '';
    let contractTrajectory = '';
    const execFn: DockerExecFn = async (args) => {
      const logsHost = hostMountFor(args, '/logs')!;
      contractOutput = await fs.readFile(path.join(logsHost, 'contract', 'output.txt'), 'utf-8');
      contractTrajectory = await fs.readFile(path.join(logsHost, 'contract', 'trajectory.json'), 'utf-8');
      return okResult();
    };

    await runVerifierInDocker({
      taskDir,
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: 'GREETING_SUCCESS',
      toolCalls: [{ tool: 'Bash', toolUseId: 't1', timestamp: 1, input: { command: 'ls' } }],
      execFn,
    });

    expect(contractOutput).toBe('GREETING_SUCCESS');
    expect(JSON.parse(contractTrajectory)[0].tool).toBe('Bash');
  });
});

describe('runVerifierInDocker image build', () => {
  it('builds from the task Dockerfile when the image does not exist yet', async () => {
    const taskDir = await makeTaskDir('verify.mjs');
    await fs.mkdir(path.join(taskDir, 'environment'), { recursive: true });
    const dockerfile = path.join(taskDir, 'environment', 'Dockerfile');
    await fs.writeFile(dockerfile, 'FROM node:20-slim\n', 'utf-8');

    const calls: string[][] = [];
    const execFn: DockerExecFn = async (args) => {
      calls.push(args);
      if (args[0] === 'image') return okResult({ exitCode: 1, stderr: 'No such image' });
      return okResult();
    };

    await runVerifierInDocker({
      taskDir,
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      taskId: 'gr-001',
      output: '',
      toolCalls: [],
      execFn,
    });

    const expectedTag = dockerImageTag('gr-001', 'FROM node:20-slim\n');
    expect(calls[0].slice(0, 2)).toEqual(['image', 'inspect']);
    expect(calls[0][2]).toBe(expectedTag);
    expect(calls[1].slice(0, 3)).toEqual(['build', '-t', expectedTag]);
    expect(calls[1]).toContain('-f');
    expect(calls[1][calls[1].indexOf('-f') + 1]).toBe(dockerfile);
    // Run uses the built tag.
    expect(calls[2][0]).toBe('run');
    expect(calls[2]).toContain(expectedTag);
  });

  it('skips the build when the image already exists', async () => {
    const taskDir = await makeTaskDir('verify.mjs');
    await fs.mkdir(path.join(taskDir, 'environment'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'environment', 'Dockerfile'), 'FROM node:20-slim\n', 'utf-8');

    const calls: string[][] = [];
    const execFn: DockerExecFn = async (args) => {
      calls.push(args);
      return okResult(); // inspect succeeds
    };

    await runVerifierInDocker({
      taskDir,
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: '',
      toolCalls: [],
      execFn,
    });

    expect(calls.map((c) => c[0])).toEqual(['image', 'run']);
  });
});

describe('runVerifierInDocker reward precedence', () => {
  function rewardWritingExec(files: Record<string, string>, exitCode = 0): DockerExecFn {
    return async (args) => {
      if (args[0] !== 'run') return okResult();
      const logsHost = hostMountFor(args, '/logs')!;
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(logsHost, ...rel.split('/'));
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, 'utf-8');
      }
      return okResult({ exitCode });
    };
  }

  const baseOptions = async () => ({
    taskDir: await makeTaskDir('verify.mjs'),
    workspaceDir: await makeTmpDir(),
    verifierRelPath: path.join('verifier', 'verify.mjs'),
    output: '',
    toolCalls: [],
  });

  it('/logs/verifier/reward.txt (SkillsBench convention) wins over everything', async () => {
    const outcome = await runVerifierInDocker({
      ...(await baseOptions()),
      execFn: rewardWritingExec(
        { 'verifier/reward.txt': '0.5', 'contract/reward.txt': '1' },
        1, // nonzero exit would otherwise mean reward 0
      ),
    });

    expect(outcome.reward).toBe(0.5);
    expect(outcome.passed).toBe(false);
  });

  it('falls back to the SKILLJACK_REWARD_FILE contract file', async () => {
    const outcome = await runVerifierInDocker({
      ...(await baseOptions()),
      execFn: rewardWritingExec({ 'contract/reward.txt': '1' }, 1),
    });

    expect(outcome.reward).toBe(1);
    expect(outcome.passed).toBe(true);
  });

  it('falls back to the exit code when no reward file was written', async () => {
    const fail = await runVerifierInDocker({
      ...(await baseOptions()),
      execFn: rewardWritingExec({}, 1),
    });
    expect(fail.reward).toBe(0);

    const pass = await runVerifierInDocker({
      ...(await baseOptions()),
      execFn: rewardWritingExec({}, 0),
    });
    expect(pass.reward).toBe(1);
  });
});

describe('runVerifierInDocker failure modes', () => {
  it('returns an actionable error when docker is unavailable', async () => {
    const outcome = await runVerifierInDocker({
      taskDir: await makeTaskDir('verify.mjs'),
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: '',
      toolCalls: [],
      execFn: async () => okResult({ exitCode: null, spawnErrorCode: 'ENOENT' }),
    });

    expect(outcome.status).toBe('error');
    expect(outcome.stderr).toBe(DOCKER_UNAVAILABLE_HINT);
  });

  it('returns a timeout outcome when the container run times out', async () => {
    const outcome = await runVerifierInDocker({
      taskDir: await makeTaskDir('verify.mjs'),
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      timeoutMs: 1234,
      output: '',
      toolCalls: [],
      execFn: async (args) => args[0] === 'run'
        ? okResult({ exitCode: null, timedOut: true })
        : okResult(),
    });

    expect(outcome.status).toBe('timeout');
    expect(outcome.reward).toBe(0);
    expect(outcome.stderr).toContain('1234');
  });

  it('force-removes the named container on timeout (docker rm -f, same name)', async () => {
    const calls: string[][] = [];
    const outcome = await runVerifierInDocker({
      taskDir: await makeTaskDir('verify.mjs'),
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      taskId: 'gr-001',
      timeoutMs: 1234,
      output: '',
      toolCalls: [],
      execFn: async (args) => {
        calls.push(args);
        return args[0] === 'run'
          ? okResult({ exitCode: null, timedOut: true })
          : okResult();
      },
    });

    expect(outcome.status).toBe('timeout');
    const runArgs = calls.find((c) => c[0] === 'run')!;
    const containerName = runArgs[runArgs.indexOf('--name') + 1];
    expect(containerName).toMatch(/^skilljack-verifier-gr-001-\d+-\d+-[0-9a-f]{8}$/);
    const rmCall = calls.find((c) => c[0] === 'rm');
    expect(rmCall).toEqual(['rm', '-f', containerName]);
  });

  it('generates a fresh container name per run', async () => {
    const names: string[] = [];
    const execFn: DockerExecFn = async (args) => {
      if (args[0] === 'run') names.push(args[args.indexOf('--name') + 1]);
      return okResult();
    };
    const base = {
      taskDir: await makeTaskDir('verify.mjs'),
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: '',
      toolCalls: [],
      execFn,
    };

    await runVerifierInDocker(base);
    await runVerifierInDocker(base);

    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  it('does not issue docker rm on the normal (non-timeout) path', async () => {
    const calls: string[][] = [];
    await runVerifierInDocker({
      taskDir: await makeTaskDir('verify.mjs'),
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: '',
      toolCalls: [],
      execFn: async (args) => {
        calls.push(args);
        return okResult();
      },
    });

    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
  });

  it('surfaces docker build failures', async () => {
    const taskDir = await makeTaskDir('verify.mjs');
    await fs.mkdir(path.join(taskDir, 'environment'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'environment', 'Dockerfile'), 'FROM nope\n', 'utf-8');

    const outcome = await runVerifierInDocker({
      taskDir,
      workspaceDir: await makeTmpDir(),
      verifierRelPath: path.join('verifier', 'verify.mjs'),
      output: '',
      toolCalls: [],
      execFn: async (args) => args[0] === 'build'
        ? okResult({ exitCode: 1, stderr: 'pull access denied' })
        : okResult({ exitCode: 1 }),
    });

    expect(outcome.status).toBe('error');
    expect(outcome.stderr).toContain('docker build failed');
    expect(outcome.stderr).toContain('pull access denied');
  });
});
