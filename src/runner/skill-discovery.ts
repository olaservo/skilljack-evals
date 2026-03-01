/**
 * Shared skill discovery utilities.
 *
 * Scans a skills directory for SKILL.md files, parses their YAML
 * frontmatter, and returns structured metadata used by all runners.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 */
export function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      result[key] = value;
    }
  }
  return result;
}

/**
 * Strip YAML frontmatter from a SKILL.md file, returning the body content.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

/**
 * Discover skills in a directory by scanning for SKILL.md files
 * and parsing their YAML frontmatter.
 */
export async function discoverSkills(skillsDir: string): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];

  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    try {
      const content = await fs.readFile(skillFile, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      if (frontmatter.name && frontmatter.description) {
        skills.push({
          name: frontmatter.name,
          description: frontmatter.description,
          path: path.resolve(skillDir),
        });
      }
    } catch {
      continue;
    }
  }

  return skills;
}
