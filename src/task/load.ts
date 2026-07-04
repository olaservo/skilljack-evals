/**
 * Task-package loader.
 *
 * Loads SkillsBench-style task packages (directories containing `task.md`)
 * into the existing SkillEvaluation/EvalTask domain types so the scorer,
 * judge, reports, and cache keep working unchanged.
 *
 * Layout:
 *   <task-id>/
 *     task.md                  # YAML frontmatter + markdown prompt body
 *     environment/
 *       skills/<name>/         # skills under test (else suite-level <suite>/skills/)
 *       workspace/             # optional seed files for each trial workspace
 *     verifier/verify.*        # optional verifier script
 *     oracle/solve.*           # optional reference solution
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractFrontmatterBlock, stripFrontmatter } from '../runner/skill-discovery.js';
import {
  KNOWN_FRONTMATTER_KEYS,
  KNOWN_CHECK_KEYS,
  VALID_DIFFICULTIES,
} from './schema.js';
import type { TaskFrontmatter, TaskChecks } from './schema.js';
import type { DeterministicCheck, EvalCriteria, EvalTask } from '../types.js';
import { loadConfigSync } from '../config.js';

/** A task package resolved on disk, wrapping the compat-bridge EvalTask. */
export interface LoadedTask {
  task: EvalTask;
  /** Absolute path to the task package directory. */
  taskDir: string;
  /** Resolved skills directory for this task (task-level, suite-level, or --skills-dir override). */
  skillsDir?: string;
  /** Optional environment/workspace/ seed directory. */
  workspaceSeedDir?: string;
  /** Absolute path to the verifier script (verify.* or test.* under verifier/). */
  verifierScript?: string;
  /** Explicit verifier command override from frontmatter. */
  verifierCommand?: string;
  /** Verifier timeout override in ms. */
  verifierTimeoutMs?: number;
  /** Absolute path to the oracle script (solve.* under oracle/). */
  oracleScript?: string;
}

export interface LoadedSuite {
  skillName: string;
  /** Absolute path to the suite (or single-package) directory that was loaded. */
  suiteDir: string;
  tasks: LoadedTask[];
  warnings: string[];
}

export interface LoadTaskOptions {
  /** Override the resolved skills directory for ALL tasks (candidate injection). */
  skillsDirOverride?: string;
  /** Dimension weights used to synthesize judge criteria. Defaults to config weights. */
  weights?: { discovery: number; adherence: number; output: number };
}

export interface TaskValidationResult {
  errors: string[];
  warnings: string[];
  suite?: LoadedSuite;
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

/** List sub-directory names of a directory (empty when missing). */
async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Resolve skill directory names within a skills dir. A directory counts as a
 * skill when it contains a SKILL.md, or when the skills dir itself has a
 * root-level SKILL.md (single-skill convention, matching the old skill-setup).
 */
async function resolveSkillNames(skillsDir: string): Promise<string[]> {
  const names: string[] = [];
  for (const sub of await listSubdirs(skillsDir)) {
    if (await isFile(path.join(skillsDir, sub, 'SKILL.md'))) {
      names.push(sub);
    }
  }
  if (names.length === 0 && (await isFile(path.join(skillsDir, 'SKILL.md')))) {
    names.push(path.basename(skillsDir));
  }
  return names;
}

/** Find the first file in `dir` whose basename matches one of the given prefixes. */
async function findScript(dir: string, prefixes: string[]): Promise<string | undefined> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  for (const prefix of prefixes) {
    const match = files.find((f) => f.startsWith(`${prefix}.`));
    if (match) return path.join(dir, match);
  }
  return undefined;
}

function asStringArray(value: unknown, label: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    errors.push(`${label} must be an array of strings`);
    return undefined;
  }
  return value as string[];
}

/**
 * Build a DeterministicCheck from frontmatter checks + skill-invocation expectation.
 */
function buildDeterministic(
  checks: TaskChecks | undefined,
  expectSkillActivation: boolean,
  errors: string[],
  taskLabel: string,
): DeterministicCheck {
  const det: DeterministicCheck = { expectSkillActivation };
  if (!checks) return det;

  det.expectContains = asStringArray(checks.contains, `${taskLabel}: checks.contains`, errors);
  det.expectNotContains = asStringArray(checks.not_contains, `${taskLabel}: checks.not_contains`, errors);
  det.expectRegex = asStringArray(checks.regex, `${taskLabel}: checks.regex`, errors);
  det.expectToolCalls = asStringArray(checks.tool_calls, `${taskLabel}: checks.tool_calls`, errors);
  det.expectNoToolCalls = asStringArray(checks.no_tool_calls, `${taskLabel}: checks.no_tool_calls`, errors);
  det.expectFileExists = asStringArray(checks.files_exist, `${taskLabel}: checks.files_exist`, errors);
  if (checks.marker !== undefined) {
    if (typeof checks.marker !== 'string') {
      errors.push(`${taskLabel}: checks.marker must be a string`);
    } else {
      det.expectMarker = checks.marker;
    }
  }
  if (checks.javascript !== undefined) {
    if (typeof checks.javascript !== 'string') {
      errors.push(`${taskLabel}: checks.javascript must be a string`);
    } else {
      det.expectJavascript = checks.javascript;
    }
  }

  if (det.expectRegex) {
    for (const pattern of det.expectRegex) {
      try {
        new RegExp(pattern);
      } catch (e) {
        errors.push(`${taskLabel}: invalid regex in checks.regex: "${pattern}" — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return det;
}

/** Synthesize generic judge criteria from dimension weights. */
function synthesizeCriteria(
  weights: { discovery: number; adherence: number; output: number },
  isNegative: boolean,
): EvalCriteria[] {
  return [
    {
      dimension: 'discovery',
      weight: weights.discovery,
      description: isNegative
        ? 'Should NOT load the skill — this prompt is out of scope for it'
        : 'Should discover and load the expected skill from task context',
    },
    {
      dimension: 'adherence',
      weight: weights.adherence,
      description: 'Should follow the instructions in the loaded skill',
    },
    {
      dimension: 'output',
      weight: weights.output,
      description: 'Should produce a quality output meeting the task requirements',
    },
  ];
}

/**
 * Load a single task package directory.
 */
async function loadTaskPackage(
  taskDir: string,
  suiteSkillsDir: string | undefined,
  options: LoadTaskOptions,
  errors: string[],
  warnings: string[],
): Promise<LoadedTask | null> {
  const dirName = path.basename(taskDir);
  const taskMdPath = path.join(taskDir, 'task.md');
  const label = `${dirName}/task.md`;

  let content: string;
  try {
    content = await fs.readFile(taskMdPath, 'utf-8');
  } catch {
    errors.push(`${label}: cannot read file`);
    return null;
  }

  let fm: TaskFrontmatter = {};
  const fmBlock = extractFrontmatterBlock(content);
  if (fmBlock !== null) {
    let parsed: unknown;
    try {
      parsed = yaml.load(fmBlock);
    } catch (e) {
      errors.push(`${label}: invalid YAML frontmatter — ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${label}: frontmatter must be a YAML mapping`);
        return null;
      }
      fm = parsed as TaskFrontmatter;
    }
  }

  // Unknown-key warnings (tolerant for future SkillsBench import)
  const unknownKeys = Object.keys(fm).filter((k) => !KNOWN_FRONTMATTER_KEYS.has(k));
  if (unknownKeys.length > 0) {
    warnings.push(`${label}: unknown frontmatter key(s) ignored: ${unknownKeys.join(', ')}`);
  }
  if (fm.checks && typeof fm.checks === 'object') {
    const unknownChecks = Object.keys(fm.checks).filter((k) => !KNOWN_CHECK_KEYS.has(k));
    if (unknownChecks.length > 0) {
      warnings.push(`${label}: unknown checks key(s) ignored: ${unknownChecks.join(', ')}`);
    }
  }

  const prompt = stripFrontmatter(content).trim();
  if (!prompt) {
    errors.push(`${label}: missing prompt body (markdown after frontmatter)`);
  }

  const id = fm.id ?? dirName;
  if (fm.id !== undefined && fm.id !== dirName) {
    errors.push(`${label}: frontmatter id '${fm.id}' does not match directory name '${dirName}'`);
  }

  if (fm.difficulty !== undefined && !VALID_DIFFICULTIES.includes(fm.difficulty)) {
    errors.push(`${label}: invalid difficulty '${fm.difficulty}' (expected easy|medium|hard)`);
  }

  // Skills resolution: task-level environment/skills, else suite-level skills/,
  // else none. --skills-dir override wins for all tasks.
  let skillsDir: string | undefined;
  if (options.skillsDirOverride) {
    skillsDir = path.resolve(options.skillsDirOverride);
  } else {
    const taskSkills = path.join(taskDir, 'environment', 'skills');
    if (await isDirectory(taskSkills)) {
      skillsDir = taskSkills;
    } else if (suiteSkillsDir && (await isDirectory(suiteSkillsDir))) {
      skillsDir = suiteSkillsDir;
    }
  }

  const skillNames = skillsDir ? await resolveSkillNames(skillsDir) : [];
  if (skillsDir && skillNames.length === 0) {
    warnings.push(`${label}: skills directory ${skillsDir} contains no skills (no SKILL.md found)`);
    skillsDir = undefined;
  }

  // Skill-invocation expectation. Default: expect invocation when skills are
  // present; when the task has no skills there is nothing to invoke.
  const expectInvocation = fm.expect_skill_invocation ?? skillNames.length > 0;

  let expectedSkill: string;
  if (!expectInvocation) {
    expectedSkill = 'none';
    if (fm.expected_skill && fm.expected_skill !== 'none') {
      warnings.push(`${label}: expected_skill '${fm.expected_skill}' ignored because expect_skill_invocation is false`);
    }
  } else if (fm.expected_skill) {
    expectedSkill = fm.expected_skill;
    if (skillNames.length > 0 && !skillNames.includes(expectedSkill)) {
      warnings.push(`${label}: expected_skill '${expectedSkill}' not found among available skills: ${skillNames.join(', ')}`);
    }
  } else if (skillNames.length === 1) {
    expectedSkill = skillNames[0];
  } else if (skillNames.length > 1) {
    errors.push(`${label}: multiple skills found (${skillNames.join(', ')}) — set expected_skill in frontmatter`);
    expectedSkill = skillNames[0];
  } else {
    expectedSkill = 'none';
  }

  // Verifier resolution: verifier/ dir OR verifier: frontmatter block enables it.
  const verifierDir = path.join(taskDir, 'verifier');
  const verifierScript = await findScript(verifierDir, ['verify', 'test']);
  const verifierBlock = fm.verifier;
  const verifierCommand = verifierBlock?.command;
  const verifierTimeoutMs = verifierBlock?.timeout_ms;
  const hasVerifier = verifierScript !== undefined || verifierCommand !== undefined;
  if (verifierBlock && !hasVerifier) {
    errors.push(`${label}: verifier block present but no verifier/verify.* (or test.*) script and no verifier.command`);
  }

  const oracleScript = await findScript(path.join(taskDir, 'oracle'), ['solve']);

  const assertions = asStringArray(fm.assertions, `${label}: assertions`, errors) ?? [];

  // A task needs some scoring signal: checks, a verifier, assertions, or an
  // explicit anti-trigger expectation (expect_skill_invocation: false).
  const hasChecks = fm.checks != null && typeof fm.checks === 'object' && Object.keys(fm.checks).length > 0;
  if (!hasChecks && !hasVerifier && assertions.length === 0 && fm.expect_skill_invocation !== false) {
    errors.push(`${label}: task must define at least one of checks:, verifier, or assertions:`);
  }

  // Port of the old negative-test warning: output checks have no effect on
  // pass/fail when the skill is expected NOT to activate.
  if (fm.expect_skill_invocation === false && fm.checks) {
    const outputChecks = ['contains', 'not_contains', 'regex', 'javascript', 'files_exist']
      .filter((k) => (fm.checks as Record<string, unknown>)[k] !== undefined);
    if (outputChecks.length > 0) {
      warnings.push(`${label}: output checks (${outputChecks.join(', ')}) have no effect on pass/fail when expect_skill_invocation is false`);
    }
  }

  const deterministic = buildDeterministic(fm.checks, expectInvocation, errors, label);

  const weights = options.weights ?? loadConfigSync().defaultWeights;
  const task: EvalTask = {
    id,
    prompt,
    expectedSkillLoad: expectedSkill,
    criteria: synthesizeCriteria(weights, !expectInvocation),
    goldenChecklist: assertions,
    deterministic,
    difficulty: fm.difficulty ?? 'medium',
    category: fm.category,
    tags: fm.tags,
    timeoutMs: fm.timeout_ms,
  };

  const workspaceSeed = path.join(taskDir, 'environment', 'workspace');

  return {
    task,
    taskDir,
    skillsDir,
    workspaceSeedDir: (await isDirectory(workspaceSeed)) ? workspaceSeed : undefined,
    verifierScript,
    verifierCommand,
    verifierTimeoutMs,
    oracleScript,
  };
}

/**
 * Load task packages from a path that is either a single task-package dir
 * (contains task.md) or a suite dir containing task-package subdirs.
 * Collects errors/warnings instead of throwing.
 */
export async function validateTaskPackages(
  inputPath: string,
  options: LoadTaskOptions = {},
): Promise<TaskValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved = path.resolve(inputPath);

  if (!(await isDirectory(resolved))) {
    return { errors: [`Not a directory: ${inputPath}`], warnings };
  }

  let taskDirs: string[];
  let suiteDir: string;
  if (await isFile(path.join(resolved, 'task.md'))) {
    // Single task package. Suite-level skills fall back to a sibling skills/ dir.
    taskDirs = [resolved];
    suiteDir = path.dirname(resolved);
  } else {
    suiteDir = resolved;
    const subdirs = await listSubdirs(resolved);
    taskDirs = [];
    for (const sub of subdirs.sort()) {
      const candidate = path.join(resolved, sub);
      if (await isFile(path.join(candidate, 'task.md'))) {
        taskDirs.push(candidate);
      }
    }
    if (taskDirs.length === 0) {
      return {
        errors: [`No task packages found in ${inputPath} (expected task.md or subdirectories containing task.md)`],
        warnings,
      };
    }
  }

  const suiteSkillsDir = path.join(suiteDir, 'skills');

  const tasks: LoadedTask[] = [];
  const seenIds = new Set<string>();
  for (const taskDir of taskDirs) {
    const loaded = await loadTaskPackage(taskDir, suiteSkillsDir, options, errors, warnings);
    if (!loaded) continue;
    if (seenIds.has(loaded.task.id)) {
      errors.push(`Duplicate task id '${loaded.task.id}'`);
    } else {
      seenIds.add(loaded.task.id);
    }
    tasks.push(loaded);
  }

  // Suite skill name: the single skill under test if uniform, else the dir name.
  const skillNames = new Set(
    tasks
      .map((t) => t.task.expectedSkillLoad)
      .filter((n) => n && n !== 'none'),
  );
  const skillName = skillNames.size === 1
    ? [...skillNames][0]
    : path.basename(resolved);

  return {
    errors,
    warnings,
    suite: { skillName, suiteDir: resolved, tasks, warnings },
  };
}

/**
 * Load task packages, throwing on validation errors.
 */
export async function loadTaskPackages(
  inputPath: string,
  options: LoadTaskOptions = {},
): Promise<LoadedSuite> {
  const { errors, warnings, suite } = await validateTaskPackages(inputPath, options);
  if (errors.length > 0 || !suite) {
    throw new Error(`Invalid task package(s) at ${inputPath}:\n  - ${errors.join('\n  - ')}`);
  }
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
  return suite;
}
