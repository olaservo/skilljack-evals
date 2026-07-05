/**
 * Skill nudge — optional prompt suffix advertising the mounted skills.
 *
 * Mirrors SkillsBench's skill-nudge knob: at higher levels the agent is told
 * more about the skills available in its workspace, isolating discovery
 * difficulty from usage difficulty. The pipeline appends the nudge to the
 * with-skill phase prompt; the no-skill baseline always gets the bare prompt,
 * while a --compare-skill baseline gets the same nudge level built from the
 * compare directory's skills (so the two arms stay symmetric).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFrontmatter, resolveSkillsDirLayout, stripFrontmatter } from '../runner/skill-discovery.js';

export type NudgeLevel = 'off' | 'name' | 'description' | 'full';

export const NUDGE_LEVELS: NudgeLevel[] = ['off', 'name', 'description', 'full'];

export interface NudgeSkill {
  name: string;
  /** May be '' when the SKILL.md frontmatter has no description. */
  description: string;
  /** Absolute path to the skill directory (containing SKILL.md). */
  skillDir: string;
}

/**
 * Build the nudge text for a set of skills. Returns '' for level 'off' or
 * when there are no skills; otherwise a block to append to the task prompt.
 * Skills without a description still appear at every level — 'description'
 * renders them with '(no description)' rather than dropping them.
 */
export async function buildNudge(level: NudgeLevel, skills: NudgeSkill[]): Promise<string> {
  if (level === 'off' || skills.length === 0) return '';

  if (level === 'name') {
    return `\n\nAvailable skills: ${skills.map((s) => s.name).join(', ')}`;
  }

  if (level === 'description') {
    const lines = skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`);
    return `\n\nAvailable skills:\n${lines.join('\n')}`;
  }

  // 'full': inline each SKILL.md body.
  const sections: string[] = [];
  for (const skill of skills) {
    const raw = await fs.readFile(path.join(skill.skillDir, 'SKILL.md'), 'utf-8');
    sections.push(`## ${skill.name}\n${stripFrontmatter(raw)}`);
  }
  return `\n\nAvailable skills:\n\n${sections.join('\n\n')}`;
}

/**
 * Convenience wrapper: resolve the skills-dir layout (shared with the loader
 * and workspace mounting) and build the nudge. Supports both layouts —
 * a directory of skill folders and a single skill with a root-level SKILL.md.
 * Skill names come from frontmatter, falling back to the directory name;
 * a missing description does not drop the skill from the nudge.
 * Returns '' when the level is 'off' or the directory has no skills.
 */
export async function buildNudgeForSkillsDir(
  level: NudgeLevel,
  skillsDir: string | undefined,
): Promise<string> {
  if (level === 'off' || !skillsDir) return '';

  const layout = await resolveSkillsDirLayout(skillsDir);
  if (layout.kind === 'none') return '';

  const skillDirs = layout.kind === 'root'
    ? [path.resolve(skillsDir)]
    : layout.names.map((name) => path.resolve(skillsDir, name));

  const skills: NudgeSkill[] = [];
  for (let i = 0; i < skillDirs.length; i++) {
    const skillDir = skillDirs[i];
    let frontmatter: { name?: string; description?: string } = {};
    try {
      frontmatter = parseFrontmatter(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8'));
    } catch {
      continue; // SKILL.md vanished between layout resolution and read
    }
    skills.push({
      name: frontmatter.name || layout.names[i],
      description: frontmatter.description ?? '',
      skillDir,
    });
  }

  return buildNudge(level, skills);
}
