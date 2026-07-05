/**
 * Docker sandbox — VERIFIER/ORACLE containerization only.
 *
 * SCOPE DECISION (v2): `--sandbox docker` containerizes the VERIFIER (and
 * oracle wrappers on export), NOT the agent. The agent — a host CLI like
 * claude/codex — works against the trial workspace on the host; the verifier
 * then runs inside a container with that workspace bind-mounted at
 * /workspace. Running the agent itself in a container (network policies,
 * resource limits, big isolated sweeps) is BenchFlow's territory and is
 * deliberately out of scope here — graduate tasks with `skilljack-evals
 * export` when you need that.
 *
 * Container contract (mirrors the host verifier contract, container paths):
 *   docker run --rm -v <workspace>:/workspace -v <taskDir>:/task:ro
 *     -v <logsTmp>:/logs -w /workspace
 *     -e SKILLJACK_OUTPUT_FILE=/logs/contract/output.txt
 *     -e SKILLJACK_TRAJECTORY_FILE=/logs/contract/trajectory.json
 *     -e SKILLJACK_TASK_DIR=/task
 *     -e SKILLJACK_REWARD_FILE=/logs/contract/reward.txt
 *     <image> <interpreter> /task/<verifierRelPath>
 *
 * Reward precedence after the run:
 *   1. /logs/verifier/reward.txt (the SkillsBench/BenchFlow convention) wins
 *   2. /logs/contract/reward.txt (our SKILLJACK_REWARD_FILE)
 *   3. exit code (0 → 1, nonzero → 0)
 *
 * `.sh` verifiers always dispatch to bash inside the container — this is the
 * Windows escape hatch for imported SkillsBench tasks.
 *
 * Image: the task's environment/Dockerfile when present (built once, tagged
 * skilljack-eval-<taskid>-<contenthash12>, build skipped when the tag already
 * exists), else DEFAULT_DOCKER_IMAGE.
 */

import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ToolCallRecord, VerifierOutcome } from '../types.js';
import { createOutcomeBuilder, readReward } from '../score/verifier.js';
import { isDirectory, isFile } from '../utils/fs.js';

export const DEFAULT_DOCKER_IMAGE = 'node:20-slim';

export const DOCKER_UNAVAILABLE_HINT =
  'Docker is required for --sandbox docker but the `docker` CLI could not be run. ' +
  'Install Docker (https://docs.docker.com/get-docker/), make sure the daemon is running, ' +
  'or drop --sandbox docker to run verifiers on the host.';

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the docker binary itself could not be spawned (ENOENT). */
  spawnErrorCode?: string;
}

/** Injectable `docker <args>` executor — tests inject a fake. */
export type DockerExecFn = (
  args: string[],
  options: { timeoutMs?: number },
) => Promise<DockerExecResult>;

function defaultDockerExec(args: string[], options: { timeoutMs?: number }): Promise<DockerExecResult> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { timeout: options.timeoutMs, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, timedOut: false });
          return;
        }
        const execErr = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: typeof execErr.code === 'number' ? execErr.code : null,
          timedOut: execErr.killed === true,
          spawnErrorCode: typeof execErr.code === 'string' ? execErr.code : undefined,
        });
      },
    );
  });
}

/**
 * Container-side interpreter for a verifier script, by extension.
 * `.ps1` has no interpreter in the default Linux image → error.
 */
export function resolveContainerInterpreter(scriptRelPath: string): { interpreter?: string; error?: string } {
  const ext = path.extname(scriptRelPath).toLowerCase();
  switch (ext) {
    case '.mjs':
    case '.js':
      return { interpreter: 'node' };
    case '.py':
      return { interpreter: 'python3' };
    case '.sh':
      // Always bash inside the container — the Windows escape hatch.
      return { interpreter: 'bash' };
    default:
      return {
        error: `Unsupported verifier extension '${ext}' for --sandbox docker (${scriptRelPath}). Supported in-container: .mjs, .js, .py, .sh.`,
      };
  }
}

/** Sanitize an id for use in docker object names (images, containers). */
function sanitizeDockerName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'task';
}

/** Docker image tag for a task-specific Dockerfile build. */
export function dockerImageTag(taskId: string, dockerfileContent: string): string {
  const hash = createHash('sha256').update(dockerfileContent).digest('hex').slice(0, 12);
  return `skilljack-eval-${sanitizeDockerName(taskId)}-${hash}`;
}

/** Monotonic per-process counter for unique verifier container names. */
let containerCounter = 0;

/**
 * Unique container name for one verifier run: pid + counter make it unique
 * within this process, and a random hex suffix guards against collisions
 * across concurrent harness processes on the same host.
 */
export function verifierContainerName(taskId: string): string {
  return `skilljack-verifier-${sanitizeDockerName(taskId)}-${process.pid}-${++containerCounter}-${randomBytes(4).toString('hex')}`;
}

export interface RunVerifierInDockerOptions {
  /** Task package directory (mounted read-only at /task). */
  taskDir: string;
  /** Trial workspace (mounted read-write at /workspace, container cwd). */
  workspaceDir: string;
  /** Verifier script path relative to taskDir (e.g. 'verifier/verify.mjs'). */
  verifierRelPath: string;
  /** Task id, used for build tags. Defaults to the taskDir basename. */
  taskId?: string;
  /** Image override. Defaults to a task Dockerfile build or DEFAULT_DOCKER_IMAGE. */
  image?: string;
  /**
   * Path to a Dockerfile to build the verifier image from. Defaults to
   * <taskDir>/environment/Dockerfile when that file exists.
   */
  dockerfile?: string;
  timeoutMs?: number;
  /** Agent's final output — materialized as SKILLJACK_OUTPUT_FILE. */
  output: string;
  /** Agent's tool calls — materialized as SKILLJACK_TRAJECTORY_FILE. */
  toolCalls: ToolCallRecord[];
  /** Extra environment variables passed into the container. */
  env?: Record<string, string>;
  /** Injectable docker executor (tests). */
  execFn?: DockerExecFn;
}

const BUILD_TIMEOUT_MS = 600_000;

/**
 * Image tags already verified (inspected or built) by this process. Tags are
 * content-addressed (taskId + Dockerfile hash), so once a tag is known to
 * exist there is no need to `docker image inspect` (or rebuild) it again for
 * subsequent trials — a Dockerfile edit changes the tag and misses the memo.
 * Failures are never memoized, so a transient docker outage can recover.
 */
const verifiedImageTags = new Set<string>();

/** Test hook: forget which image tags this process has verified. */
export function resetVerifiedImageTagsForTests(): void {
  verifiedImageTags.clear();
}

/**
 * Run a task's verifier inside a Docker container. Never throws — all failure
 * modes return a structured VerifierOutcome.
 */
export async function runVerifierInDocker(options: RunVerifierInDockerOptions): Promise<VerifierOutcome> {
  const execFn = options.execFn ?? defaultDockerExec;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const outcome = createOutcomeBuilder(Date.now());

  const { interpreter, error: interpError } = resolveContainerInterpreter(options.verifierRelPath);
  if (!interpreter) {
    return outcome({ status: 'error', stderr: interpError ?? 'No container interpreter' });
  }

  // Resolve the image: explicit image > task Dockerfile build > default.
  let image = options.image;
  if (!image) {
    const dockerfile = options.dockerfile ?? path.join(options.taskDir, 'environment', 'Dockerfile');
    if (await isFile(dockerfile)) {
      const content = await fs.readFile(dockerfile, 'utf-8');
      const tag = dockerImageTag(options.taskId ?? path.basename(options.taskDir), content);

      // Content-addressed memo: an already-verified tag skips the repeat
      // `docker image inspect` (and any rebuild) for later trials.
      if (!verifiedImageTags.has(tag)) {
        const inspect = await execFn(['image', 'inspect', tag], { timeoutMs: 30_000 });
        if (inspect.spawnErrorCode === 'ENOENT') {
          return outcome({ status: 'error', stderr: DOCKER_UNAVAILABLE_HINT });
        }
        if (inspect.exitCode !== 0) {
          const build = await execFn(
            ['build', '-t', tag, '-f', dockerfile, path.dirname(dockerfile)],
            { timeoutMs: BUILD_TIMEOUT_MS },
          );
          if (build.spawnErrorCode === 'ENOENT') {
            return outcome({ status: 'error', stderr: DOCKER_UNAVAILABLE_HINT });
          }
          if (build.exitCode !== 0) {
            return outcome({
              status: 'error',
              exitCode: build.exitCode,
              stdout: build.stdout,
              stderr: `docker build failed for ${dockerfile}: ${build.stderr.slice(0, 1000)}`,
            });
          }
        }
        verifiedImageTags.add(tag);
      }
      image = tag;
    } else {
      image = DEFAULT_DOCKER_IMAGE;
    }
  }

  // Materialize the contract files in a temp dir mounted at /logs.
  let logsTmp: string;
  try {
    logsTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skilljack-docker-'));
  } catch (err) {
    return outcome({
      status: 'error',
      stderr: `Failed to create docker logs temp dir: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const contractDir = path.join(logsTmp, 'contract');
    await fs.mkdir(contractDir, { recursive: true });
    await fs.mkdir(path.join(logsTmp, 'verifier'), { recursive: true });
    await fs.writeFile(path.join(contractDir, 'output.txt'), options.output, 'utf-8');
    await fs.writeFile(path.join(contractDir, 'trajectory.json'), JSON.stringify(options.toolCalls, null, 2), 'utf-8');

    const scriptContainerPath = '/task/' + options.verifierRelPath.split(path.sep).join('/');

    // --rm cleans up on normal exit, but a timeout only kills the docker
    // CLIENT — the container keeps running. A unique --name lets the timeout
    // path force-remove it.
    const containerName = verifierContainerName(options.taskId ?? path.basename(options.taskDir));

    const args = [
      'run', '--rm',
      '--name', containerName,
      '-v', `${options.workspaceDir}:/workspace`,
      '-v', `${options.taskDir}:/task:ro`,
      '-v', `${logsTmp}:/logs`,
    ];
    // SkillsBench-convention verifiers reference /verifier/<file> internally —
    // mount the task's verifier dir there too when it exists.
    const verifierDir = path.join(options.taskDir, path.dirname(options.verifierRelPath));
    if (path.basename(verifierDir) === 'verifier' && (await isDirectory(verifierDir))) {
      args.push('-v', `${verifierDir}:/verifier:ro`);
    }
    args.push(
      '-w', '/workspace',
      '-e', 'SKILLJACK_OUTPUT_FILE=/logs/contract/output.txt',
      '-e', 'SKILLJACK_TRAJECTORY_FILE=/logs/contract/trajectory.json',
      '-e', 'SKILLJACK_TASK_DIR=/task',
      '-e', 'SKILLJACK_REWARD_FILE=/logs/contract/reward.txt',
    );
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(image, interpreter, scriptContainerPath);

    const run = await execFn(args, { timeoutMs });

    if (run.spawnErrorCode === 'ENOENT') {
      return outcome({ status: 'error', stderr: DOCKER_UNAVAILABLE_HINT });
    }
    if (run.timedOut) {
      // Best-effort cleanup: kill + remove the container the timeout leaked
      // (the timeout only killed the docker CLI process). Failures ignored.
      try {
        await execFn(['rm', '-f', containerName], { timeoutMs: 30_000 });
      } catch { /* best-effort */ }
      return outcome({
        status: 'timeout',
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr || `Docker verifier timed out after ${timeoutMs}ms`,
      });
    }

    // Reward precedence: SkillsBench /logs/verifier/reward.txt > our contract
    // reward file > exit code.
    const skillsBenchReward = await readReward(path.join(logsTmp, 'verifier', 'reward.txt'));
    const contractReward = await readReward(path.join(contractDir, 'reward.txt'));
    const reward = skillsBenchReward ?? contractReward ?? (run.exitCode === 0 ? 1 : 0);

    return outcome({
      status: 'ok',
      reward,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
    });
  } finally {
    await fs.rm(logsTmp, { recursive: true, force: true }).catch(() => {});
  }
}
