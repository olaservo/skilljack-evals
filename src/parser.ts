/**
 * YAML parser for skill evaluation task files.
 *
 * Supports enriched YAML schema with:
 * - defaults block (shared criteria, expected_skill_load)
 * - deterministic block (marker-based checks, tool call expectations)
 * - fixture block (setup/teardown scripts per task)
 */

import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import type {
  EvalTask,
  EvalCriteria,
  SkillEvaluation,
  EvalDefaults,
  DeterministicCheck,
  FixtureConfig,
} from './types.js';

// ============================================
// Raw YAML structures
// ============================================

interface RawEvalFile {
  skill: string;
  version?: string;
  defaults?: RawDefaults;
  tasks: RawTask[];
}

interface RawDefaults {
  expected_skill_load?: string;
  criteria?: {
    discovery?: RawCriteria;
    adherence?: RawCriteria;
    output?: RawCriteria;
  };
}

interface RawTask {
  id: string;
  prompt: string;
  expected_skill_load?: string;
  criteria?: {
    discovery?: RawCriteria;
    adherence?: RawCriteria;
    output?: RawCriteria;
  };
  golden_checklist?: string[];
  deterministic?: RawDeterministic;
  fixture?: RawFixture;
}

interface RawCriteria {
  weight?: number;
  description?: string;
}

interface RawDeterministic {
  expect_skill_activation?: boolean;
  expect_marker?: string;
  expect_tool_calls?: string[];
  expect_no_tool_calls?: string[];
}

interface RawFixture {
  state?: string;
  setup?: string;
  teardown?: string;
}

// ============================================
// Parser
// ============================================

/**
 * Parse a YAML evaluation file into a SkillEvaluation object.
 */
export async function parseEvalFile(filePath: string): Promise<SkillEvaluation> {
  const content = await fs.readFile(filePath, 'utf-8');
  const raw = yaml.load(content) as RawEvalFile;

  if (!raw || !raw.skill) {
    throw new Error(`Invalid evaluation file: missing 'skill' field`);
  }

  const defaults = raw.defaults ? parseDefaults(raw.defaults) : undefined;
  const tasks = (raw.tasks || []).map((t) => parseTask(t, defaults));

  return {
    skillName: raw.skill,
    version: raw.version,
    defaults,
    tasks,
  };
}

/**
 * Parse the defaults block.
 */
function parseDefaults(raw: RawDefaults): EvalDefaults {
  const defaults: EvalDefaults = {};

  if (raw.expected_skill_load) {
    defaults.expectedSkillLoad = raw.expected_skill_load;
  }

  if (raw.criteria) {
    defaults.criteria = {};
    for (const dim of ['discovery', 'adherence', 'output'] as const) {
      const rawCrit = raw.criteria[dim];
      if (rawCrit) {
        defaults.criteria[dim] = {
          weight: rawCrit.weight,
          description: rawCrit.description,
        };
      }
    }
  }

  return defaults;
}

/**
 * Parse a single task from raw YAML, merging with defaults.
 */
function parseTask(raw: RawTask, defaults?: EvalDefaults): EvalTask {
  // Merge expected skill load: task overrides defaults
  const expectedSkillLoad = raw.expected_skill_load
    ?? defaults?.expectedSkillLoad
    ?? '';

  // Merge criteria: task-level overrides default-level
  const criteria: EvalCriteria[] = [];
  const dimensions = ['discovery', 'adherence', 'output'] as const;

  for (const dim of dimensions) {
    const taskCrit = raw.criteria?.[dim];
    const defaultCrit = defaults?.criteria?.[dim];

    if (taskCrit || defaultCrit) {
      criteria.push({
        dimension: dim,
        weight: taskCrit?.weight ?? defaultCrit?.weight ?? 0.33,
        description: taskCrit?.description ?? defaultCrit?.description ?? '',
      });
    }
  }

  // Parse deterministic block
  let deterministic: DeterministicCheck | undefined;
  if (raw.deterministic) {
    deterministic = {
      expectSkillActivation: raw.deterministic.expect_skill_activation ?? true,
      expectMarker: raw.deterministic.expect_marker,
      expectToolCalls: raw.deterministic.expect_tool_calls,
      expectNoToolCalls: raw.deterministic.expect_no_tool_calls,
    };
  }

  // Parse fixture block
  let fixture: FixtureConfig | undefined;
  if (raw.fixture) {
    fixture = {
      state: raw.fixture.state ?? 'default',
      setup: raw.fixture.setup,
      teardown: raw.fixture.teardown,
    };
  }

  return {
    id: raw.id || '',
    prompt: raw.prompt || '',
    expectedSkillLoad,
    criteria,
    goldenChecklist: raw.golden_checklist || [],
    deterministic,
    fixture,
  };
}

// ============================================
// Validation
// ============================================

/**
 * Validate a YAML evaluation file and return any errors.
 */
export async function validateEvalFile(filePath: string): Promise<string[]> {
  const errors: string[] = [];

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [`Cannot read file: ${filePath}`];
  }

  let raw: RawEvalFile;
  try {
    raw = yaml.load(content) as RawEvalFile;
  } catch (e) {
    return [`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`];
  }

  if (!raw) {
    return ['File is empty'];
  }

  if (!raw.skill) {
    errors.push("Missing required field: 'skill'");
  }

  if (!raw.tasks || !Array.isArray(raw.tasks)) {
    errors.push("Missing or invalid 'tasks' array");
    return errors;
  }

  const taskIds = new Set<string>();
  for (let i = 0; i < raw.tasks.length; i++) {
    const task = raw.tasks[i];
    const prefix = `tasks[${i}]`;

    if (!task.id) {
      errors.push(`${prefix}: Missing 'id'`);
    } else if (taskIds.has(task.id)) {
      errors.push(`${prefix}: Duplicate task id '${task.id}'`);
    } else {
      taskIds.add(task.id);
    }

    if (!task.prompt) {
      errors.push(`${prefix}: Missing 'prompt'`);
    }

    // Validate criteria weights sum roughly to 1
    if (task.criteria) {
      const weights = Object.values(task.criteria)
        .filter((c): c is RawCriteria => c !== undefined)
        .map((c) => c.weight ?? 0.33);
      const sum = weights.reduce((a, b) => a + b, 0);
      if (weights.length > 0 && Math.abs(sum - 1) > 0.1) {
        errors.push(`${prefix}: Criteria weights sum to ${sum.toFixed(2)}, expected ~1.0`);
      }
    }
  }

  return errors;
}

// ============================================
// Template Generation
// ============================================

/**
 * Generate a YAML template for a new skill evaluation.
 */
export function createEvalTemplate(skillName: string, numTasks = 5): string {
  const prefix = skillName.slice(0, 2).toLowerCase();

  const tasks = Array.from({ length: numTasks }, (_, i) => {
    const taskId = `${prefix}-${String(i + 1).padStart(3, '0')}`;
    return `  - id: ${taskId}
    prompt: "TODO: Write a realistic prompt that should trigger ${skillName}"
    expected_skill_load: ${skillName}
    deterministic:
      expect_skill_activation: true
      # expect_marker: "OPTIONAL_MARKER_TEXT"
    criteria:
      discovery: { weight: 0.3, description: "Should load ${skillName} based on task context" }
      adherence: { weight: 0.4, description: "Should follow ${skillName} instructions" }
      output: { weight: 0.3, description: "Should produce quality output meeting requirements" }
    golden_checklist:
      - "TODO: Add expected behavior 1"
      - "TODO: Add expected behavior 2"
      - "TODO: Add expected behavior 3"`;
  });

  return `skill: ${skillName}
version: "1.0"

defaults:
  expected_skill_load: ${skillName}
  criteria:
    discovery: { weight: 0.3 }
    adherence: { weight: 0.4 }
    output: { weight: 0.3 }

tasks:
${tasks.join('\n\n')}
`;
}
