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
 * Extract the raw YAML frontmatter block (between the --- fences) from a
 * markdown file, or null when the file has no frontmatter. Callers that need
 * structured (non-flat) frontmatter can parse the returned block with js-yaml.
 */
export function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? null;
}

/**
 * Strip YAML frontmatter from a SKILL.md file, returning the body content.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

/**
 * Layout of a skills directory. Shared by the task loader, workspace
 * mounting, the nudge builder, and the pipeline's compare-skill resolution
 * so their semantics can't drift:
 * - 'multi': immediate subdirectories containing their own SKILL.md are the
 *   skills (subdirs without a SKILL.md are ignored).
 * - 'root': no such subdirectory exists but the directory itself has a
 *   root-level SKILL.md — the whole directory is ONE skill named after its
 *   basename (references/, scripts/, etc. belong to that skill).
 * - 'none': no skills found.
 */
export interface SkillsDirLayout {
  kind: 'multi' | 'root' | 'none';
  /** Skill names: subdir names for 'multi', [basename(dir)] for 'root', [] for 'none'. */
  names: string[];
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Decide how a skills directory is laid out (see SkillsDirLayout).
 * Missing/unreadable directories resolve to 'none'.
 */
export async function resolveSkillsDirLayout(skillsDir: string): Promise<SkillsDirLayout> {
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return { kind: 'none', names: [] };
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isFile(path.join(skillsDir, entry.name, 'SKILL.md'))) {
      names.push(entry.name);
    }
  }
  if (names.length > 0) return { kind: 'multi', names };

  if (await isFile(path.join(skillsDir, 'SKILL.md'))) {
    return { kind: 'root', names: [path.basename(path.resolve(skillsDir))] };
  }
  return { kind: 'none', names: [] };
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
      } else if (frontmatter.name || frontmatter.description) {
        console.warn(
          `Skipping skill in ${entry.name}: SKILL.md frontmatter missing ${!frontmatter.name ? 'name' : 'description'}`,
        );
      }
    } catch {
      continue;
    }
  }

  return skills;
}
