/**
 * YAML parser for skill evaluation task files.
 */

import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import type { EvalTask, EvalCriteria, SkillEvaluation } from './types.js';

/**
 * Raw YAML structure for a task file.
 */
interface RawEvalFile {
  skill: string;
  tasks: RawTask[];
}

interface RawTask {
  id: string;
  prompt: string;
  expected_skill_load: string;
  criteria: {
    discovery?: RawCriteria;
    adherence?: RawCriteria;
    output?: RawCriteria;
  };
  golden_checklist: string[];
}

interface RawCriteria {
  weight: number;
  description: string;
}

/**
 * Parse a YAML evaluation file into a SkillEvaluation object.
 */
export async function parseEvalFile(filePath: string): Promise<SkillEvaluation> {
  const content = await fs.readFile(filePath, 'utf-8');
  const raw = yaml.load(content) as RawEvalFile;

  if (!raw || !raw.skill) {
    throw new Error(`Invalid evaluation file: missing 'skill' field`);
  }

  const tasks = (raw.tasks || []).map(parseTask);

  return { skillName: raw.skill, tasks };
}

/**
 * Parse a single task from raw YAML.
 */
function parseTask(raw: RawTask): EvalTask {
  const criteria: EvalCriteria[] = [];
  const dimensions = ['discovery', 'adherence', 'output'] as const;

  for (const dim of dimensions) {
    const rawCrit = raw.criteria?.[dim];
    if (rawCrit) {
      criteria.push({
        dimension: dim,
        weight: rawCrit.weight ?? 0.33,
        description: rawCrit.description ?? '',
      });
    }
  }

  return {
    id: raw.id || '',
    prompt: raw.prompt || '',
    expectedSkillLoad: raw.expected_skill_load || '',
    criteria,
    goldenChecklist: raw.golden_checklist || [],
  };
}

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
tasks:
${tasks.join('\n\n')}
`;
}
