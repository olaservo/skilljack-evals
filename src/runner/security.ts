/**
 * Security policies for the evaluation runner.
 *
 * Restricts file writes to allowed directories. Provides both:
 * - createToolPolicy(): Agent SDK canUseTool callback (Claude SDK runner)
 * - isWriteAllowed(): Standalone path check (Vercel AI / OpenAI runners)
 */

import * as path from 'path';

/**
 * Resolve allowed write directory patterns to absolute paths with trailing separators.
 */
function resolveWriteDirs(allowedWriteDirs: string[], cwd: string): string[] {
  return allowedWriteDirs.map((dir) => {
    const resolved = path.resolve(cwd, dir);
    // Ensure trailing separator so "/app/results" won't match "/app/results-evil"
    return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  });
}

/**
 * Check whether a resolved path falls within any of the resolved allowed directories.
 */
function isPathInDirs(resolvedPath: string, resolvedDirs: string[]): boolean {
  return resolvedDirs.some(
    (dir) => resolvedPath.startsWith(dir) || resolvedPath === dir.slice(0, -1),
  );
}

/**
 * Check whether a resolved file path falls within the allowed write directories.
 * Used by non-Claude runners that don't have canUseTool callbacks.
 */
export function isWriteAllowed(
  resolvedPath: string,
  allowedWriteDirs: string[],
  cwd: string,
): boolean {
  // No restrictions configured — allow all writes.
  // Default config provides ['./results/', './fixtures/'].
  // Direct API users should set allowedWriteDirs explicitly.
  if (allowedWriteDirs.length === 0) return true;

  return isPathInDirs(resolvedPath, resolveWriteDirs(allowedWriteDirs, cwd));
}

/**
 * Create a canUseTool callback that restricts Write/Edit to allowed directories.
 *
 * Matches the Agent SDK's CanUseTool signature:
 *   (toolName, input, options) => Promise<PermissionResult>
 */
export function createToolPolicy(
  allowedWriteDirs: string[],
  cwd: string
) {
  const resolvedDirs = resolveWriteDirs(allowedWriteDirs, cwd);

  return async (
    toolName: string,
    input: Record<string, unknown>,
    _options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown }
  ) => {
    // Allow all non-write tools
    if (!['Write', 'Edit'].includes(toolName)) {
      return { behavior: 'allow' as const, updatedInput: input };
    }

    // Check if file path is in allowed directories
    const filePath = (input.file_path as string) || '';
    const resolvedPath = path.resolve(cwd, filePath);

    if (isPathInDirs(resolvedPath, resolvedDirs)) {
      return { behavior: 'allow' as const, updatedInput: input };
    }

    return {
      behavior: 'deny' as const,
      message: `Write denied: ${filePath} is outside allowed directories: ${allowedWriteDirs.join(', ')}`,
    };
  };
}
