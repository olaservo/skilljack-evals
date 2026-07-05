import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createTrialWorkspace, applyCleanupPolicy, DEFAULT_SKILLS_MOUNT_PATH } from '../run/workspace.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('createTrialWorkspace', () => {
  it('creates workspaces/<taskId>/run-<n> under the base dir', async () => {
    const baseDir = await makeTmpDir();
    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0 });

    expect(ws.dir).toBe(path.resolve(baseDir, 'workspaces', 't-1', 'run-1'));
    expect(await exists(ws.dir)).toBe(true);
  });

  it('uses 1-based run directory names', async () => {
    const baseDir = await makeTmpDir();
    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 2 });
    expect(path.basename(ws.dir)).toBe('run-3');
  });

  it('copies seed dir contents into the workspace', async () => {
    const baseDir = await makeTmpDir();
    const seedDir = await makeTmpDir();
    await fs.writeFile(path.join(seedDir, 'data.csv'), 'a,b');
    await fs.mkdir(path.join(seedDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(seedDir, 'nested', 'deep.txt'), 'deep');

    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0, seedDir });

    expect(await fs.readFile(path.join(ws.dir, 'data.csv'), 'utf-8')).toBe('a,b');
    expect(await fs.readFile(path.join(ws.dir, 'nested', 'deep.txt'), 'utf-8')).toBe('deep');
  });

  it('mounts skill folders at .claude/skills by default', async () => {
    const baseDir = await makeTmpDir();
    const skillsDir = await makeTmpDir();
    await fs.mkdir(path.join(skillsDir, 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'my-skill', 'SKILL.md'), '# skill');
    await fs.writeFile(path.join(skillsDir, 'my-skill', 'helper.py'), 'pass');

    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0, skillsDir });

    expect(ws.skillNames).toEqual(['my-skill']);
    const mounted = path.join(ws.dir, DEFAULT_SKILLS_MOUNT_PATH, 'my-skill');
    expect(await exists(path.join(mounted, 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(mounted, 'helper.py'))).toBe(true);
  });

  it('mounts a single skill with root-level SKILL.md under its dir name', async () => {
    const baseDir = await makeTmpDir();
    const parent = await makeTmpDir();
    const skillsDir = path.join(parent, 'solo-skill');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'SKILL.md'), '# solo');

    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0, skillsDir });

    expect(ws.skillNames).toEqual(['solo-skill']);
    expect(await exists(path.join(ws.dir, DEFAULT_SKILLS_MOUNT_PATH, 'solo-skill', 'SKILL.md'))).toBe(true);
  });

  it('mounts a root-layout skill INTACT: references/ and scripts/ travel with it, no phantom skills', async () => {
    const baseDir = await makeTmpDir();
    const parent = await makeTmpDir();
    const skillsDir = path.join(parent, 'pdf-tools');
    await fs.mkdir(path.join(skillsDir, 'references'), { recursive: true });
    await fs.mkdir(path.join(skillsDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'SKILL.md'), '# pdf-tools');
    await fs.writeFile(path.join(skillsDir, 'references', 'api.md'), '# api');
    await fs.writeFile(path.join(skillsDir, 'scripts', 'extract.py'), 'pass');

    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0, skillsDir });

    // One skill, named after the directory — subdirs are NOT phantom skills.
    expect(ws.skillNames).toEqual(['pdf-tools']);
    const mounted = path.join(ws.dir, DEFAULT_SKILLS_MOUNT_PATH, 'pdf-tools');
    expect(await exists(path.join(mounted, 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(mounted, 'references', 'api.md'))).toBe(true);
    expect(await exists(path.join(mounted, 'scripts', 'extract.py'))).toBe(true);
    // No phantom top-level mounts for the resource subdirs.
    expect(await exists(path.join(ws.dir, DEFAULT_SKILLS_MOUNT_PATH, 'references'))).toBe(false);
    expect(await exists(path.join(ws.dir, DEFAULT_SKILLS_MOUNT_PATH, 'scripts'))).toBe(false);
  });

  it('ignores stray subdirs without SKILL.md in a multi-skill dir', async () => {
    const baseDir = await makeTmpDir();
    const skillsDir = await makeTmpDir();
    await fs.mkdir(path.join(skillsDir, 'real-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'real-skill', 'SKILL.md'), '# real');
    await fs.mkdir(path.join(skillsDir, 'notes'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'notes', 'todo.txt'), 'not a skill');

    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0, skillsDir });

    expect(ws.skillNames).toEqual(['real-skill']);
    expect(await exists(path.join(ws.dir, DEFAULT_SKILLS_MOUNT_PATH, 'real-skill', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(ws.dir, DEFAULT_SKILLS_MOUNT_PATH, 'notes'))).toBe(false);
  });

  it('supports a custom skills mount path', async () => {
    const baseDir = await makeTmpDir();
    const skillsDir = await makeTmpDir();
    await fs.mkdir(path.join(skillsDir, 's1'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 's1', 'SKILL.md'), '# s1');

    const ws = await createTrialWorkspace({
      baseDir, taskId: 't-1', runIndex: 0, skillsDir,
      skillsMountPath: path.join('.agents', 'skills'),
    });

    expect(await exists(path.join(ws.dir, '.agents', 'skills', 's1', 'SKILL.md'))).toBe(true);
  });

  it('replaces leftovers from a previous run of the same trial', async () => {
    const baseDir = await makeTmpDir();
    const first = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0 });
    await fs.writeFile(path.join(first.dir, 'leftover.txt'), 'stale');

    const second = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0 });

    expect(second.dir).toBe(first.dir);
    expect(await exists(path.join(second.dir, 'leftover.txt'))).toBe(false);
  });

  it('cleanup removes the workspace', async () => {
    const baseDir = await makeTmpDir();
    const ws = await createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0 });

    await ws.cleanup();
    expect(await exists(ws.dir)).toBe(false);
  });
});

describe('applyCleanupPolicy', () => {
  async function makeWorkspace() {
    const baseDir = await makeTmpDir();
    return createTrialWorkspace({ baseDir, taskId: 't-1', runIndex: 0 });
  }

  it("'all' keeps passing and failing workspaces", async () => {
    const wsPass = await makeWorkspace();
    const wsFail = await makeWorkspace();

    await applyCleanupPolicy(wsPass, 'all', false);
    await applyCleanupPolicy(wsFail, 'all', true);

    expect(await exists(wsPass.dir)).toBe(true);
    expect(await exists(wsFail.dir)).toBe(true);
  });

  it("'failures' keeps only failed trials", async () => {
    const wsPass = await makeWorkspace();
    const wsFail = await makeWorkspace();

    await applyCleanupPolicy(wsPass, 'failures', false);
    await applyCleanupPolicy(wsFail, 'failures', true);

    expect(await exists(wsPass.dir)).toBe(false);
    expect(await exists(wsFail.dir)).toBe(true);
  });

  it("'none' removes everything", async () => {
    const wsPass = await makeWorkspace();
    const wsFail = await makeWorkspace();

    await applyCleanupPolicy(wsPass, 'none', false);
    await applyCleanupPolicy(wsFail, 'none', true);

    expect(await exists(wsPass.dir)).toBe(false);
    expect(await exists(wsFail.dir)).toBe(false);
  });
});
