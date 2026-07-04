/**
 * Task-package schema definitions.
 *
 * A task package is a directory containing a `task.md` file whose YAML
 * frontmatter carries task metadata, checks, and verifier config, and whose
 * markdown body is the agent prompt. See src/task/load.ts for loading.
 */

import type { TaskDifficulty } from '../types.js';

/** Lite deterministic checks — map 1:1 onto the existing DeterministicCheck. */
export interface TaskChecks {
  contains?: string[];
  not_contains?: string[];
  regex?: string[];
  marker?: string;
  tool_calls?: string[];
  no_tool_calls?: string[];
  files_exist?: string[];
  javascript?: string;
}

export interface VerifierFrontmatter {
  timeout_ms?: number;
  command?: string;
}

/** Raw task.md frontmatter shape (all fields optional). */
export interface TaskFrontmatter {
  id?: string;
  difficulty?: TaskDifficulty;
  category?: string;
  tags?: string[];
  expected_skill?: string;
  expect_skill_invocation?: boolean;
  timeout_ms?: number;
  verifier?: VerifierFrontmatter;
  checks?: TaskChecks;
  assertions?: string[];
  /** Set by `skilljack-evals import` when the verifier needs --sandbox docker (.sh script). */
  requires_docker?: boolean;
  /** Unmapped SkillsBench frontmatter preserved by `skilljack-evals import`. */
  x_skillsbench?: Record<string, unknown>;
}

export const KNOWN_FRONTMATTER_KEYS = new Set<string>([
  'id',
  'difficulty',
  'category',
  'tags',
  'expected_skill',
  'expect_skill_invocation',
  'timeout_ms',
  'verifier',
  'checks',
  'assertions',
  'requires_docker',
  'x_skillsbench',
]);

export const KNOWN_CHECK_KEYS = new Set<string>([
  'contains',
  'not_contains',
  'regex',
  'marker',
  'tool_calls',
  'no_tool_calls',
  'files_exist',
  'javascript',
]);

export const VALID_DIFFICULTIES: TaskDifficulty[] = ['easy', 'medium', 'hard'];
