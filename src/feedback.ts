/**
 * Human review feedback utilities.
 *
 * Handles generation, loading, and validation of feedback JSON files
 * used to capture structured human review of eval results.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { EvalTask, HumanFeedback } from './types.js';

/**
 * Generate a feedback template from tasks.
 * Returns an object with task IDs as keys and empty strings as values.
 */
export function generateFeedbackTemplate(tasks: EvalTask[]): HumanFeedback {
  const template: HumanFeedback = {};
  for (const task of tasks) {
    template[task.id] = '';
  }
  return template;
}

/**
 * Write a feedback template JSON file.
 */
export async function writeFeedbackTemplate(
  tasks: EvalTask[],
  outputPath: string
): Promise<void> {
  const template = generateFeedbackTemplate(tasks);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(template, null, 2));
}

/**
 * Load and validate a feedback file.
 *
 * - Warns about unknown task IDs but does not fail.
 * - Returns only entries with non-empty feedback strings.
 */
export async function loadFeedback(
  feedbackPath: string,
  taskIds: Set<string>
): Promise<HumanFeedback> {
  const content = await fs.readFile(feedbackPath, 'utf-8');
  const raw = JSON.parse(content);

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid feedback file: expected a JSON object with task IDs as keys');
  }

  const feedback: HumanFeedback = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid feedback for task "${key}": expected string, got ${typeof value}`);
    }
    if (!taskIds.has(key)) {
      console.warn(`Warning: Feedback file contains unknown task ID "${key}" — ignoring`);
      continue;
    }
    if (value.trim() !== '') {
      feedback[key] = value;
    }
  }

  return feedback;
}

/**
 * Get feedback text for a specific task, or undefined if none.
 */
export function getFeedbackForTask(
  feedback: HumanFeedback | undefined,
  taskId: string
): string | undefined {
  if (!feedback) return undefined;
  const text = feedback[taskId];
  return text && text.trim() !== '' ? text : undefined;
}
