/**
 * SkillsBench → skilljack task-package importer.
 *
 * Converts a SkillsBench-native task package (schema_version 1.3 style:
 * task.md + environment/ + verifier/ + oracle/) into our task-package format:
 *
 *   metadata.difficulty        → difficulty (when easy|medium|hard)
 *   metadata.category          → category
 *   metadata.tags              → tags
 *   verifier.timeout_sec       → verifier.timeout_ms (*1000)
 *   agent.timeout_sec          → timeout_ms (*1000)
 *   prompt body                → verbatim
 *   environment/skills/        → environment/skills/
 *   other environment files    → environment/workspace/ (trial seed files)
 *   environment/Dockerfile     → environment/Dockerfile
 *   verifier/, oracle/         → copied wholesale
 *
 * Everything unknown or unmappable (schema_version, author metadata,
 * verifier hardening, environment resources, ...) is PRESERVED under an
 * `x_skillsbench:` frontmatter block with a warning — imports are tolerant
 * and never hard-fail on unknown keys. An `x_skilljack:` block (written by
 * our exporter) is restored to native keys, making export→import lossless.
 *
 * Tasks whose verifier is a `.sh` script are tagged `requires_docker: true`:
 * on Windows hosts they need `--sandbox docker` (or bash on PATH).
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractFrontmatterBlock, stripFrontmatter } from '../runner/skill-discovery.js';
import { copyDir } from '../run/workspace.js';
import { VALID_DIFFICULTIES } from './schema.js';
import type { TaskDifficulty } from '../types.js';

export interface ImportResult {
  /** Directory the imported task package was written to. */
  taskDir: string;
  warnings: string[];
}

export interface ImportOptions {
  /** Parent directory for the imported package (default: ./evals). */
  outDir?: string;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Convert a `*_sec` value to whole milliseconds when it is a finite number. */
function secToMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000)
    : undefined;
}

/** Native keys the exporter round-trips through x_skilljack. */
const X_SKILLJACK_KEYS = ['checks', 'assertions', 'expected_skill', 'expect_skill_invocation'] as const;

/** SkillsBench top-level keys we know how to (partially) map. */
const MAPPED_TOP_LEVEL_KEYS = new Set(['metadata', 'verifier', 'agent', 'x_skilljack']);

/**
 * Import a SkillsBench-native task package directory into <outDir>/<name>/.
 * Tolerant: unknown keys are preserved under x_skillsbench, never fatal.
 */
export async function importSkillsBenchTask(srcDir: string, options: ImportOptions = {}): Promise<ImportResult> {
  const warnings: string[] = [];
  const resolvedSrc = path.resolve(srcDir);
  const name = path.basename(resolvedSrc);
  const outParent = path.resolve(options.outDir ?? path.join(process.cwd(), 'evals'));
  const taskDir = path.join(outParent, name);

  const taskMdPath = path.join(resolvedSrc, 'task.md');
  if (!(await isFile(taskMdPath))) {
    throw new Error(`Not a SkillsBench task package: ${srcDir} (no task.md)`);
  }
  if (await isDirectory(taskDir)) {
    throw new Error(`Import target already exists: ${taskDir} — remove it or pass a different --out directory.`);
  }

  const content = await fs.readFile(taskMdPath, 'utf-8');
  const fmBlock = extractFrontmatterBlock(content);
  let fm: Record<string, unknown> = {};
  if (fmBlock !== null) {
    try {
      fm = asRecord(yaml.load(fmBlock)) ?? {};
    } catch (e) {
      warnings.push(`task.md frontmatter did not parse as YAML (${e instanceof Error ? e.message : String(e)}) — importing prompt body only`);
    }
  }
  const body = stripFrontmatter(content).trim();

  // --- Map frontmatter ---
  const out: Record<string, unknown> = {};
  const xSkillsBench: Record<string, unknown> = {};

  const metadata = asRecord(fm.metadata);
  if (metadata) {
    const metaLeftover: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (key === 'difficulty') {
        if (typeof value === 'string' && VALID_DIFFICULTIES.includes(value as TaskDifficulty)) {
          out.difficulty = value;
        } else {
          warnings.push(`metadata.difficulty '${String(value)}' is not easy|medium|hard — preserved under x_skillsbench`);
          metaLeftover.difficulty = value;
        }
      } else if (key === 'category' && typeof value === 'string') {
        out.category = value;
      } else if (key === 'tags' && Array.isArray(value)) {
        out.tags = value;
      } else {
        metaLeftover[key] = value;
      }
    }
    if (Object.keys(metaLeftover).length > 0) xSkillsBench.metadata = metaLeftover;
  }

  const verifierFm = asRecord(fm.verifier);
  if (verifierFm) {
    const timeoutMs = secToMs(verifierFm.timeout_sec);
    if (timeoutMs !== undefined) {
      out.verifier = { timeout_ms: timeoutMs };
    }
    const leftover = { ...verifierFm };
    delete leftover.timeout_sec;
    if (Object.keys(leftover).length > 0) xSkillsBench.verifier = leftover;
  }

  const agentFm = asRecord(fm.agent);
  if (agentFm) {
    const timeoutMs = secToMs(agentFm.timeout_sec);
    if (timeoutMs !== undefined) out.timeout_ms = timeoutMs;
    const leftover = { ...agentFm };
    delete leftover.timeout_sec;
    if (Object.keys(leftover).length > 0) xSkillsBench.agent = leftover;
  }

  // Round-trip restore: x_skilljack (written by our exporter) → native keys.
  const xSkilljack = asRecord(fm.x_skilljack);
  if (xSkilljack) {
    for (const key of X_SKILLJACK_KEYS) {
      if (xSkilljack[key] !== undefined) out[key] = xSkilljack[key];
    }
  }

  // Everything else (schema_version, environment, unknown keys) → x_skillsbench.
  for (const [key, value] of Object.entries(fm)) {
    if (MAPPED_TOP_LEVEL_KEYS.has(key)) continue;
    xSkillsBench[key] = value;
    if (key !== 'schema_version' && key !== 'environment') {
      warnings.push(`unknown frontmatter key '${key}' preserved under x_skillsbench`);
    }
  }

  // --- Inspect source layout ---
  const srcEnv = path.join(resolvedSrc, 'environment');
  const srcSkills = path.join(srcEnv, 'skills');
  const srcVerifierDir = path.join(resolvedSrc, 'verifier');
  const srcOracleDir = path.join(resolvedSrc, 'oracle');
  const srcDockerfile = path.join(srcEnv, 'Dockerfile');

  // Detect a shell-script verifier → requires_docker tag. Mirrors the
  // loader's dispatch (first verify.* then test.*): only tag when the script
  // the loader would actually pick is a .sh.
  let hasShellVerifier = false;
  if (await isDirectory(srcVerifierDir)) {
    const files = (await fs.readdir(srcVerifierDir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    const selected = ['verify', 'test']
      .map((prefix) => files.find((f) => f.startsWith(`${prefix}.`)))
      .find((f) => f !== undefined);
    hasShellVerifier = selected !== undefined && selected.toLowerCase().endsWith('.sh');
  }
  if (hasShellVerifier) {
    out.requires_docker = true;
    const needsNetwork = asRecord(fm.environment)?.network_mode;
    warnings.push(
      'verifier is a .sh script — tagged requires_docker: true. Run with --sandbox docker (or have bash on PATH).' +
      (await isFile(srcDockerfile) ? ' Task ships an environment/Dockerfile (used for the verifier image).' : '') +
      (needsNetwork ? ` Note: SkillsBench declared network_mode '${String(needsNetwork)}' — the verifier may need network access.` : ''),
    );
  }

  // --- Write the package ---
  await fs.mkdir(taskDir, { recursive: true });

  const frontmatter: Record<string, unknown> = { ...out };
  if (Object.keys(xSkillsBench).length > 0) frontmatter.x_skillsbench = xSkillsBench;

  const fmYaml = Object.keys(frontmatter).length > 0 ? yaml.dump(frontmatter, { lineWidth: 120 }) : '';
  await fs.writeFile(
    path.join(taskDir, 'task.md'),
    `---\n${fmYaml}---\n\n${body}\n`,
    'utf-8',
  );

  // environment/: skills → skills, Dockerfile → Dockerfile, everything else → workspace/.
  if (await isDirectory(srcEnv)) {
    const entries = await fs.readdir(srcEnv, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcEnv, entry.name);
      if (entry.isDirectory() && entry.name === 'skills') {
        await copyDir(srcPath, path.join(taskDir, 'environment', 'skills'));
      } else if (entry.isFile() && entry.name === 'Dockerfile') {
        await fs.mkdir(path.join(taskDir, 'environment'), { recursive: true });
        await fs.copyFile(srcPath, path.join(taskDir, 'environment', 'Dockerfile'));
      } else if (entry.isDirectory()) {
        await copyDir(srcPath, path.join(taskDir, 'environment', 'workspace', entry.name));
      } else {
        const workspaceDir = path.join(taskDir, 'environment', 'workspace');
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.copyFile(srcPath, path.join(workspaceDir, entry.name));
      }
    }
  }

  if (await isDirectory(srcVerifierDir)) {
    await copyDir(srcVerifierDir, path.join(taskDir, 'verifier'));
  } else {
    warnings.push('no verifier/ directory found — the imported task has no scoring signal unless checks/assertions were restored from x_skilljack');
  }

  if (await isDirectory(srcOracleDir)) {
    await copyDir(srcOracleDir, path.join(taskDir, 'oracle'));
  }

  return { taskDir, warnings };
}
