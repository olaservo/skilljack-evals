/**
 * Security policies for the evaluation runner.
 *
 * Restricts file writes to allowed directories. Provides:
 * - createPreToolUseHook(): Agent SDK PreToolUse hook (Claude SDK runner). This
 *   is the enforcement path: under permissionMode 'dontAsk' the hook is consulted
 *   for every tool call while staying fully headless.
 * - createToolPolicy(): Legacy canUseTool callback. NOTE: as of claude-agent-sdk
 *   0.3.x, canUseTool is NOT invoked when permissionMode is 'bypassPermissions'
 *   (it is shadowed by the pre-approval). Kept for API compatibility only.
 * - isWriteAllowed(): Standalone path check (Vercel AI / OpenAI runners)
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
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
 * Create a PreToolUse hook that restricts Write/Edit to allowed directories.
 *
 * Use with `permissionMode: 'dontAsk'`: pre-approved tools (via `allowedTools`)
 * are auto-allowed, this hook is still consulted per call, and nothing ever
 * produces an interactive prompt — so it works headlessly in CI. Returns 'deny'
 * for Write/Edit targeting a path outside the allowed directories.
 *
 * Replaces createToolPolicy() (canUseTool), which the SDK no longer invokes
 * under 'bypassPermissions'.
 */
export function createPreToolUseHook(
  allowedWriteDirs: string[],
  cwd: string,
): HookCallback {
  const resolvedDirs = resolveWriteDirs(allowedWriteDirs, cwd);

  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    // Allow all non-write tools (Read, Glob, Grep, Bash, Skill, Task, ...)
    if (!['Write', 'Edit'].includes(input.tool_name)) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    // No restrictions configured — allow all writes (matches isWriteAllowed).
    if (allowedWriteDirs.length === 0) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const filePath = (toolInput.file_path as string) || '';
    const resolvedPath = path.resolve(cwd, filePath);

    if (isPathInDirs(resolvedPath, resolvedDirs)) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Write denied: ${filePath} is outside allowed directories: ${allowedWriteDirs.join(', ')}`,
      },
    };
  };
}

/**
 * Create a canUseTool callback that restricts Write/Edit to allowed directories.
 *
 * Matches the Agent SDK's CanUseTool signature:
 *   (toolName, input, options) => Promise<PermissionResult>
 *
 * DEPRECATED for the Claude SDK runner: claude-agent-sdk 0.3.x does not invoke
 * canUseTool under permissionMode 'bypassPermissions'. Use createPreToolUseHook
 * with permissionMode 'dontAsk' instead. Retained for API compatibility.
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
