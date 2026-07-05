import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCliJsonl, detectCli } from '../harness/subprocess.js';

/** True when a PID currently exists (signal 0 probe works on all platforms). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the PID is gone or the deadline passes. */
async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessAlive(pid);
}

describe('runCliJsonl', () => {
  it('parses JSONL stdout lines into events', async () => {
    const result = await runCliJsonl({
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({a:1})); console.log(JSON.stringify({b:2}));'],
      timeoutMs: 30000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.rawLines).toEqual([]);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('keeps non-JSON stdout lines in rawLines alongside events', async () => {
    const result = await runCliJsonl({
      command: process.execPath,
      args: ['-e', 'console.log("plain banner line"); console.log(JSON.stringify({ok:true})); console.log("{not json");'],
      timeoutMs: 30000,
    });

    expect(result.events).toEqual([{ ok: true }]);
    expect(result.rawLines).toEqual(['plain banner line', '{not json']);
  });

  it('collects stderr and a nonzero exit code', async () => {
    const result = await runCliJsonl({
      command: process.execPath,
      args: ['-e', 'console.error("boom"); process.exit(3);'],
      timeoutMs: 30000,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
    expect(result.timedOut).toBe(false);
  });

  it('rejects when the command does not exist', async () => {
    await expect(
      runCliJsonl({
        command: 'definitely-not-a-real-command-xyz',
        args: [],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });

  it('kills a hanging process on timeout, returns promptly, and the process is actually dead', async () => {
    const start = Date.now();
    const result = await runCliJsonl({
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);'],
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Must return promptly, not hang until some larger timeout.
    expect(elapsed).toBeLessThan(10000);

    const pid = (result.events[0] as { pid: number }).pid;
    expect(await waitForDeath(pid, 5000)).toBe(true);
  }, 20000);

  it('kills the process on AbortSignal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const start = Date.now();
    const result = await runCliJsonl({
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);'],
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10000);
    expect(result.timedOut).toBe(false);

    const pid = (result.events[0] as { pid: number }).pid;
    expect(await waitForDeath(pid, 5000)).toBe(true);
  }, 20000);

  it('delivers events incrementally via onEvent and leaves the events array empty', async () => {
    const seen: unknown[] = [];
    const result = await runCliJsonl({
      command: process.execPath,
      args: ['-e', 'console.log("plain banner line"); console.log(JSON.stringify({a:1})); console.log(JSON.stringify({b:2}));'],
      timeoutMs: 30000,
      onEvent: (event) => seen.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    // Incremental mode: events are delivered, never accumulated...
    expect(result.events).toEqual([]);
    // ...while non-JSON stdout lines are still collected as before.
    expect(result.rawLines).toEqual(['plain banner line']);
  });

  it('rejects (and kills the process) when the onEvent callback throws', async () => {
    await expect(
      runCliJsonl({
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify({a:1})); setInterval(()=>{},1000);'],
        timeoutMs: 30000,
        onEvent: () => {
          throw new Error('reducer boom');
        },
      }),
    ).rejects.toThrow('reducer boom');
  }, 20000);

  it('passes input to stdin', async () => {
    const result = await runCliJsonl({
      command: process.execPath,
      args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify({got:d.trim()})));'],
      input: 'hello stdin\n',
      timeoutMs: 30000,
    });

    expect(result.events).toEqual([{ got: 'hello stdin' }]);
  });
});

describe('Windows npm .cmd shims (cross-spawn)', () => {
  // Regression for CVE-2024-27980 hardening: plain spawn(shell:false) refuses
  // .cmd files with EINVAL, so npm-installed CLIs looked "not found on PATH".
  // cross-spawn resolves and executes the shim without shell:true.
  it.runIf(process.platform === 'win32')('executes a .cmd shim without a shell', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-shim-'));
    const shim = path.join(dir, 'fake-cli.cmd');
    await fs.writeFile(shim, '@echo {"ok":true}\r\n', 'utf-8');
    try {
      const result = await runCliJsonl({ command: shim, args: [], timeoutMs: 30000 });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.events).toEqual([{ ok: true }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.runIf(process.platform === 'win32')('detectCli reports a .cmd shim as available', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-shim-detect-'));
    const shim = path.join(dir, 'fake-cli.cmd');
    await fs.writeFile(shim, '@echo 1.2.3\r\n', 'utf-8');
    try {
      const detection = await detectCli(shim, ['--version']);
      expect(detection.available).toBe(true);
      expect(detection.version).toBe('1.2.3');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('detectCli', () => {
  it('detects an available CLI with its version output', async () => {
    const detection = await detectCli(process.execPath, ['--version']);

    expect(detection.available).toBe(true);
    expect(detection.version).toMatch(/^v\d+/);
  });

  it('returns the caller-provided install hint when the command is missing', async () => {
    const detection = await detectCli('definitely-not-a-real-command-xyz', ['--version'], {
      installHint: 'Install: npm install -g some-cli',
    });

    expect(detection.available).toBe(false);
    expect(detection.reason).toContain('not found on PATH');
    expect(detection.reason).toContain('Install: npm install -g some-cli');
  });

  it('reports a nonzero version-command exit as unavailable', async () => {
    const detection = await detectCli(process.execPath, ['-e', 'process.exit(2)']);

    expect(detection.available).toBe(false);
    expect(detection.reason).toContain('exited with code 2');
  });
});
