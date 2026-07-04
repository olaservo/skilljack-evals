/**
 * Task-package scaffolding for the `create-task` CLI command.
 *
 * Generates a task package skeleton: task.md (frontmatter template + prompt
 * placeholder), a verify.mjs verifier stub, an oracle solve.mjs stub, and an
 * empty environment/skills/ directory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const TASK_MD_TEMPLATE = `---
# id defaults to the directory name; only set it if you must (it must match).
difficulty: medium
# category: document-processing
# tags: [example]
# expected_skill: my-skill        # defaults to the single skill under environment/skills/
# expect_skill_invocation: true   # set false for anti-trigger (false-positive) tasks
# timeout_ms: 300000
# verifier: { timeout_ms: 60000 } # optional; presence of verifier/ also enables it
checks:
  # Lite deterministic checks (all optional):
  # contains: ["expected substring"]
  # not_contains: ["ERROR", "FIXME"]
  # regex: ["\\\\d{4}-\\\\d{2}-\\\\d{2}"]
  # marker: "SUCCESS_MARKER"
  # tool_calls: [Write]
  # no_tool_calls: [Bash]
  # files_exist: [out/result.json]
  # javascript: "output.length > 10"
assertions:
  - "TODO: Add a specific, observable expected behavior"
  - "TODO: Add a countable or verifiable requirement"
---

TODO: Write a realistic prompt that should trigger the skill. Use concrete context (file paths, column names) instead of generic placeholders, and never name the skill directly.
`;

const VERIFY_MJS_TEMPLATE = `// Verifier stub. Runs with cwd = trial workspace.
// Env: SKILLJACK_OUTPUT_FILE, SKILLJACK_TRAJECTORY_FILE, SKILLJACK_TASK_DIR, SKILLJACK_REWARD_FILE.
// Write a float 0..1 to SKILLJACK_REWARD_FILE, or exit 0 (reward 1) / nonzero (reward 0).
import { readFileSync, writeFileSync } from 'node:fs';

const output = readFileSync(process.env.SKILLJACK_OUTPUT_FILE, 'utf-8');

// Example assertion — replace with real checks against output and/or workspace files.
const passed = output.length > 0;

writeFileSync(process.env.SKILLJACK_REWARD_FILE, passed ? '1' : '0');
`;

const SOLVE_MJS_TEMPLATE = `// Oracle stub: a reference solution that must make the verifier yield reward 1.0.
// Runs with cwd = a fresh seeded workspace (skills mounted, no agent).
// It may write workspace files and/or write the expected agent output to SKILLJACK_OUTPUT_FILE.
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.SKILLJACK_OUTPUT_FILE, 'TODO: produce the reference output the verifier expects');
`;

export interface ScaffoldResult {
  taskDir: string;
  files: string[];
}

/**
 * Scaffold a new task package at <baseDir>/<id>/.
 * Throws if the task directory already exists.
 */
export async function scaffoldTaskPackage(id: string, baseDir: string): Promise<ScaffoldResult> {
  const taskDir = path.resolve(baseDir, id);

  try {
    await fs.access(taskDir);
    throw new Error(`Task package directory already exists: ${taskDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const files: string[] = [];
  const write = async (relPath: string, content: string): Promise<void> => {
    const fullPath = path.join(taskDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    files.push(fullPath);
  };

  await write('task.md', TASK_MD_TEMPLATE);
  await write(path.join('verifier', 'verify.mjs'), VERIFY_MJS_TEMPLATE);
  await write(path.join('oracle', 'solve.mjs'), SOLVE_MJS_TEMPLATE);
  await write(path.join('environment', 'skills', '.gitkeep'), '');

  return { taskDir, files };
}
