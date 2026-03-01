/**
 * Security policies for the evaluation runner.
 *
 * Restricts file writes to allowed directories. Provides both:
 * - createToolPolicy(): Agent SDK canUseTool callback (Claude SDK runner)
 * - isWriteAllowed(): Standalone path check (Vercel AI / OpenAI runners)
 */

import * as path from 'path';

/**
 * Check whether a resolved file path falls within the allowed write directories.
 * Used by non-Claude runners that don't have canUseTool callbacks.
 */
export function isWriteAllowed(
  resolvedPath: string,
  allowedWriteDirs: string[],
  cwd: string,
): boolean {
  if (allowedWriteDirs.length === 0) return true;

  const resolvedDirs = allowedWriteDirs.map((dir) => path.resolve(cwd, dir));
  return resolvedDirs.some((dir) => resolvedPath.startsWith(dir));
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
  const resolvedDirs = allowedWriteDirs.map((dir) =>
    path.resolve(cwd, dir)
  );

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

    const isAllowed = resolvedDirs.some((dir) =>
      resolvedPath.startsWith(dir)
    );

    if (isAllowed) {
      return { behavior: 'allow' as const, updatedInput: input };
    }

    return {
      behavior: 'deny' as const,
      message: `Write denied: ${filePath} is outside allowed directories: ${allowedWriteDirs.join(', ')}`,
    };
  };
}
