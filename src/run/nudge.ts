/**
 * Skill nudge — optional prompt suffix advertising the mounted skills.
 *
 * Mirrors SkillsBench's skill-nudge knob: at higher levels the agent is told
 * more about the skills available in its workspace, isolating discovery
 * difficulty from usage difficulty. The pipeline appends the nudge to the
 * with-skill phase prompt only; baseline phases always get the bare prompt.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { discoverSkills, stripFrontmatter } from '../runner/skill-discovery.js';

export type NudgeLevel = 'off' | 'name' | 'description' | 'full';

export const NUDGE_LEVELS: NudgeLevel[] = ['off', 'name', 'description', 'full'];

export interface NudgeSkill {
  name: string;
  description: string;
  /** Absolute path to the skill directory (containing SKILL.md). */
  skillDir: string;
}

/**
 * Build the nudge text for a set of skills. Returns '' for level 'off' or
 * when there are no skills; otherwise a block to append to the task prompt.
 */
export async function buildNudge(level: NudgeLevel, skills: NudgeSkill[]): Promise<string> {
  if (level === 'off' || skills.length === 0) return '';

  if (level === 'name') {
    return `\n\nAvailable skills: ${skills.map((s) => s.name).join(', ')}`;
  }

  if (level === 'description') {
    const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
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
 * Convenience wrapper: discover skills in a directory and build the nudge.
 * Returns '' when the level is 'off' or the directory has no skills.
 */
export async function buildNudgeForSkillsDir(
  level: NudgeLevel,
  skillsDir: string | undefined,
): Promise<string> {
  if (level === 'off' || !skillsDir) return '';
  const skills = await discoverSkills(skillsDir);
  return buildNudge(
    level,
    skills.map((s) => ({ name: s.name, description: s.description, skillDir: s.path })),
  );
}
