/**
 * Per-trial workspace management.
 *
 * Each trial (task x run) gets a throwaway workspace directory seeded from the
 * task package's environment/workspace/ files, with skills mounted at the
 * harness's skill discovery path. The pipeline passes each runner's
 * `skillsMountPath` ('.claude/skills' for Claude runners, '.agents/skills' for
 * Codex, etc.); DEFAULT_SKILLS_MOUNT_PATH is only a fallback for direct API
 * callers. Workspaces replace the old global setupSkills + fixture scripts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSkillsDirLayout } from '../runner/skill-discovery.js';

export type WorkspaceCleanupPolicy = 'all' | 'failures' | 'none';

export const DEFAULT_SKILLS_MOUNT_PATH = path.join('.claude', 'skills');

export interface TrialWorkspace {
  /** Absolute path to the workspace directory. */
  dir: string;
  /** Names of skills mounted into the workspace. */
  skillNames: string[];
  /** Remove the workspace directory. */
  cleanup(): Promise<void>;
}

export interface CreateTrialWorkspaceOptions {
  /** Base directory under which workspaces/<taskId>/run-<n>/ is created. */
  baseDir: string;
  taskId: string;
  /** Zero-based run index; directory name uses run-<index + 1>. */
  runIndex: number;
  /** Optional seed directory whose contents are copied into the workspace. */
  seedDir?: string;
  /** Optional skills directory (skill folders, or a single skill with root SKILL.md). */
  skillsDir?: string;
  /**
   * Mount path for skills inside the workspace. The pipeline always passes the
   * runner's skillsMountPath; defaults to .claude/skills for direct callers.
   */
  skillsMountPath?: string;
}

/**
 * Recursively copy a directory. (Moved from runner/skill-setup.ts.)
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Mount skills from a source directory into targetDir, mirroring the task
 * loader's layout semantics exactly (shared resolveSkillsDirLayout helper):
 * - root layout (root SKILL.md, no skill subdirs): the ENTIRE directory is
 *   one skill copied to <targetDir>/<basename>/ — references/, scripts/, and
 *   other relative resources stay intact.
 * - multi layout: only immediate subdirs CONTAINING a SKILL.md are skills;
 *   each is copied whole. Subdirs without a SKILL.md are not mounted.
 */
async function mountSkills(skillsSourceDir: string, targetDir: string): Promise<string[]> {
  await fs.mkdir(targetDir, { recursive: true });
  const layout = await resolveSkillsDirLayout(skillsSourceDir);

  if (layout.kind === 'root') {
    await copyDir(skillsSourceDir, path.join(targetDir, layout.names[0]));
  } else {
    for (const name of layout.names) {
      await copyDir(path.join(skillsSourceDir, name), path.join(targetDir, name));
    }
  }

  return layout.names;
}

/**
 * Create a fresh trial workspace: <baseDir>/workspaces/<taskId>/run-<n>/,
 * seeded from seedDir and with skills mounted at skillsMountPath.
 */
export async function createTrialWorkspace(
  options: CreateTrialWorkspaceOptions,
): Promise<TrialWorkspace> {
  const dir = path.resolve(
    options.baseDir,
    'workspaces',
    options.taskId,
    `run-${options.runIndex + 1}`,
  );

  // Fresh workspace every trial — remove any leftovers from previous runs.
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  if (options.seedDir) {
    await copyDir(options.seedDir, dir);
  }

  let skillNames: string[] = [];
  if (options.skillsDir) {
    const mountPath = path.join(dir, options.skillsMountPath ?? DEFAULT_SKILLS_MOUNT_PATH);
    skillNames = await mountSkills(options.skillsDir, mountPath);
  }

  return {
    dir,
    skillNames,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Apply a cleanup policy to a workspace after scoring.
 * 'all' keeps everything, 'failures' keeps only failed trials, 'none' deletes.
 */
export async function applyCleanupPolicy(
  workspace: TrialWorkspace,
  policy: WorkspaceCleanupPolicy,
  trialFailed: boolean,
): Promise<void> {
  if (policy === 'all') return;
  if (policy === 'failures' && trialFailed) return;
  await workspace.cleanup();
}
