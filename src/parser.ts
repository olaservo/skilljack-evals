/**
 * XML parser for skill evaluation task files.
 */

import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import type { EvalTask, EvalCriteria, SkillEvaluation } from './types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

/**
 * Parse an XML evaluation file into a SkillEvaluation object.
 */
export async function parseEvalFile(filePath: string): Promise<SkillEvaluation> {
  const content = await fs.readFile(filePath, 'utf-8');
  const xml = parser.parse(content);

  const root = xml.skill_evaluation;
  if (!root) {
    throw new Error(`Invalid evaluation file: missing <skill_evaluation> root element`);
  }

  const skillName = root['@_skill'] || 'unknown';

  // Handle single task vs array of tasks
  const taskElems = root.eval_task
    ? Array.isArray(root.eval_task)
      ? root.eval_task
      : [root.eval_task]
    : [];

  const tasks = taskElems.map(parseTask);

  return { skillName, tasks };
}

/**
 * Parse a single eval_task element.
 */
function parseTask(elem: any): EvalTask {
  const id = elem['@_id'] || '';

  // Handle text content (may be nested or direct)
  const prompt = extractText(elem.prompt);
  const expectedSkillLoad = extractText(elem.expected_skill_load);

  const criteria = parseCriteria(elem.criteria);
  const goldenChecklist = parseChecklist(elem.golden_checklist);

  return {
    id,
    prompt,
    expectedSkillLoad,
    criteria,
    goldenChecklist,
  };
}

/**
 * Extract text from an XML element that may be a string or object with #text.
 */
function extractText(elem: any): string {
  if (!elem) return '';
  if (typeof elem === 'string') return elem.trim();
  if (elem['#text']) return String(elem['#text']).trim();
  return '';
}

/**
 * Parse criteria element into array of EvalCriteria.
 */
function parseCriteria(criteriaElem: any): EvalCriteria[] {
  if (!criteriaElem) return [];

  const criteria: EvalCriteria[] = [];
  const dimensions = ['discovery', 'adherence', 'output'] as const;

  for (const dimension of dimensions) {
    const dimElem = criteriaElem[dimension];
    if (dimElem) {
      const weight = parseFloat(dimElem['@_weight'] || '0.33');
      const description = extractText(dimElem);
      criteria.push({ dimension, weight, description });
    }
  }

  return criteria;
}

/**
 * Parse golden_checklist into array of strings.
 */
function parseChecklist(checklistElem: any): string[] {
  const text = extractText(checklistElem);
  if (!text) return [];

  const items: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      items.push(trimmed.slice(2));
    } else if (trimmed) {
      items.push(trimmed);
    }
  }

  return items;
}

/**
 * Generate an XML template for a new skill evaluation.
 */
export function createEvalTemplate(skillName: string, numTasks = 5): string {
  const prefix = skillName.slice(0, 2).toLowerCase();

  const tasks = Array.from({ length: numTasks }, (_, i) => {
    const taskId = `${prefix}-${String(i + 1).padStart(3, '0')}`;
    return `  <eval_task id="${taskId}">
    <prompt>TODO: Write a realistic prompt that should trigger ${skillName}</prompt>
    <expected_skill_load>${skillName}</expected_skill_load>
    <criteria>
      <discovery weight="0.3">Should load ${skillName} based on task context</discovery>
      <adherence weight="0.4">Should follow ${skillName} instructions</adherence>
      <output weight="0.3">Should produce quality output meeting requirements</output>
    </criteria>
    <golden_checklist>
      - TODO: Add expected behavior 1
      - TODO: Add expected behavior 2
      - TODO: Add expected behavior 3
    </golden_checklist>
  </eval_task>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<skill_evaluation skill="${skillName}">
${tasks.join('\n\n')}
</skill_evaluation>
`;
}
