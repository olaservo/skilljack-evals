/**
 * Local skill setup and cleanup for evaluation runs.
 *
 * Copies skill directories into .claude/skills/ within the working directory
 * so the Agent SDK can discover them via settingSources: ['project'].
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Copy skills from a source directory to .claude/skills/ in the working directory.
 *
 * @param skillsSourceDir - Directory containing skill folders (each with SKILL.md)
 * @param cwd - Working directory where .claude/skills/ should be created
 * @returns List of skill names that were set up
 */
export async function setupLocalSkills(
  skillsSourceDir: string,
  cwd: string
): Promise<string[]> {
  const targetDir = path.join(cwd, '.claude', 'skills');
  await fs.mkdir(targetDir, { recursive: true });

  const skillNames: string[] = [];

  try {
    const entries = await fs.readdir(skillsSourceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const srcSkillDir = path.join(skillsSourceDir, entry.name);
        const destSkillDir = path.join(targetDir, entry.name);

        await copyDir(srcSkillDir, destSkillDir);
        skillNames.push(entry.name);
      } else if (entry.name === 'SKILL.md') {
        // Single skill file at root level
        const skillName = path.basename(skillsSourceDir);
        await fs.mkdir(path.join(targetDir, skillName), { recursive: true });
        await fs.copyFile(
          path.join(skillsSourceDir, entry.name),
          path.join(targetDir, skillName, 'SKILL.md')
        );
        skillNames.push(skillName);
      }
    }
  } catch (err) {
    throw new Error(
      `Failed to setup local skills from ${skillsSourceDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return skillNames;
}

/**
 * Remove .claude/skills/ from the working directory.
 */
export async function cleanupLocalSkills(cwd: string): Promise<void> {
  const skillsDir = path.join(cwd, '.claude', 'skills');
  try {
    await fs.rm(skillsDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Recursively copy a directory.
 */
async function copyDir(src: string, dest: string): Promise<void> {
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
