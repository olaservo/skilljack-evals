/**
 * Shared filesystem predicates.
 *
 * Used by the task loader, SkillsBench import/export, and the docker sandbox
 * instead of per-module copies. Both predicates treat any stat error (missing
 * path, permission) as "no".
 */

import * as fs from 'fs/promises';

/** True when the path exists and is a directory. */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path exists and is a regular file. */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
