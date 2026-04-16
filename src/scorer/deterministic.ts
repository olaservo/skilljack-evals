/**
 * Deterministic scorer for skill evaluations.
 *
 * Performs fast, free checks based on tool call analysis and output markers.
 * No LLM calls required — checks are purely based on the session data.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import type {
  EvalTask,
  TaskResult,
  DeterministicResult,
} from '../types.js';

export interface DeterministicOptions {
  cwd?: string;
}

/**
 * Check if a tool name is a skill activation tool.
 */
function isSkillTool(toolName: string): boolean {
  // Local mode uses "Skill", MCP mode uses mcp__*__skill
  return toolName === 'Skill' ||
    (toolName.includes('skill') && !toolName.includes('skill-resource'));
}

/**
 * Extract skill name from a tool call input.
 */
function extractSkillName(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  // Local Skill tool uses 'skill', MCP uses 'name'
  return (obj.skill as string) || (obj.skill_name as string) || (obj.name as string) || undefined;
}

/**
 * Run deterministic checks on a task result.
 */
export function scoreDeterministic(
  task: EvalTask,
  result: TaskResult,
  options?: DeterministicOptions
): DeterministicResult | null {
  const check = task.deterministic;
  if (!check) return null;

  const details: string[] = [];

  // 1. Check skill activation
  let skillActivated = false;
  let activatedSkillName: string | undefined;

  if (result.isError) {
    details.push('Task errored — treating as no activation');
  } else {
    // Check tool calls for skill invocations
    for (const call of result.toolCalls) {
      if (isSkillTool(call.tool)) {
        const name = extractSkillName(call.input);
        if (name) {
          skillActivated = true;
          activatedSkillName = name;
          break;
        }
      }
    }

    // Also check skillLoads array (may be populated by runner)
    if (!skillActivated && result.skillLoads.length > 0) {
      skillActivated = true;
      activatedSkillName = result.skillLoads[0];
    }
  }

  // Verify activation matches expectations
  if (check.expectSkillActivation) {
    if (skillActivated) {
      // Check if the correct skill was activated
      if (task.expectedSkillLoad && task.expectedSkillLoad !== 'none') {
        if (activatedSkillName === task.expectedSkillLoad) {
          details.push(`Skill activated correctly: ${activatedSkillName}`);
        } else {
          details.push(`Wrong skill activated: expected '${task.expectedSkillLoad}', got '${activatedSkillName}'`);
          skillActivated = false; // Wrong skill doesn't count
        }
      } else {
        details.push(`Skill activated: ${activatedSkillName}`);
      }
    } else {
      details.push(`Expected skill activation but no skill was loaded`);
    }
  } else {
    // Expect NO activation (false positive test)
    if (skillActivated) {
      details.push(`Unexpected skill activation: ${activatedSkillName} (false positive)`);
    } else {
      details.push('Correctly did not activate any skill');
    }
  }

  // 2. Check marker in output (case-insensitive, unlike expect_contains)
  let markerFound: boolean | null = null;
  if (check.expectMarker) {
    const output = result.output.toLowerCase();
    const marker = check.expectMarker.toLowerCase();
    markerFound = output.includes(marker);
    details.push(
      markerFound
        ? `Marker found: "${check.expectMarker}"`
        : `Marker not found: "${check.expectMarker}"`
    );
  }

  // 3. Check expected tool calls
  let expectedToolsCalled: boolean | null = null;
  if (Array.isArray(check.expectToolCalls) && check.expectToolCalls.length > 0) {
    const calledTools = new Set(result.toolCalls.map((c) => c.tool));
    const missing = check.expectToolCalls.filter((t) => !calledTools.has(t));
    expectedToolsCalled = missing.length === 0;
    if (expectedToolsCalled) {
      details.push(`All expected tools called: ${check.expectToolCalls.join(', ')}`);
    } else {
      details.push(`Missing expected tool calls: ${missing.join(', ')}`);
    }
  }

  // 4. Check forbidden tool calls
  let unexpectedToolsCalled: boolean | null = null;
  if (Array.isArray(check.expectNoToolCalls) && check.expectNoToolCalls.length > 0) {
    const calledTools = new Set(result.toolCalls.map((c) => c.tool));
    const forbidden = check.expectNoToolCalls.filter((t) => calledTools.has(t));
    unexpectedToolsCalled = forbidden.length > 0;
    if (unexpectedToolsCalled) {
      details.push(`Forbidden tools were called: ${forbidden.join(', ')}`);
    } else {
      details.push(`No forbidden tools called`);
    }
  }

  // 5. Check expect_contains (case-sensitive, unlike expect_marker)
  let containsCheckPassed: boolean | null = null;
  if (Array.isArray(check.expectContains) && check.expectContains.length > 0) {
    const missing = check.expectContains.filter((s) => !result.output.includes(s));
    containsCheckPassed = missing.length === 0;
    if (containsCheckPassed) {
      details.push('All expected substrings found in output');
    } else {
      details.push(`Expected substrings not found: ${missing.map((s) => `"${s}"`).join(', ')}`);
    }
  }

  // 6. Check expect_not_contains (case-sensitive forbidden substring checks)
  let notContainsCheckPassed: boolean | null = null;
  if (Array.isArray(check.expectNotContains) && check.expectNotContains.length > 0) {
    const found = check.expectNotContains.filter((s) => result.output.includes(s));
    notContainsCheckPassed = found.length === 0;
    if (notContainsCheckPassed) {
      details.push('No forbidden substrings found in output');
    } else {
      details.push(`Forbidden substrings found: ${found.map((s) => `"${s}"`).join(', ')}`);
    }
  }

  // 7. Check expect_regex (regex pattern matching, with timeout to guard against ReDoS)
  let regexCheckPassed: boolean | null = null;
  if (Array.isArray(check.expectRegex) && check.expectRegex.length > 0) {
    const failures: string[] = [];
    for (const pattern of check.expectRegex) {
      try {
        const sandbox = { pattern, output: result.output, result: false };
        vm.runInNewContext('result = new RegExp(pattern).test(output)', sandbox, { timeout: 5000 });
        if (!sandbox.result) {
          failures.push(`/${pattern}/`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('timed out')) {
          failures.push(`/${pattern}/ (timed out — possible ReDoS)`);
        } else {
          failures.push(`/${pattern}/ (invalid regex)`);
        }
      }
    }
    regexCheckPassed = failures.length === 0;
    if (regexCheckPassed) {
      details.push('All regex patterns matched');
    } else {
      details.push(`Regex patterns not matched: ${failures.join(', ')}`);
    }
  }

  // 8. Check expect_javascript (JS expression returning boolean, sandboxed via vm)
  // NOTE: vm.runInNewContext is NOT a true security sandbox (per Node.js docs).
  // This is acceptable because eval YAML files are author-controlled, not
  // untrusted user input. The timeout guards against accidental infinite loops.
  let javascriptCheckPassed: boolean | null = null;
  if (check.expectJavascript) {
    try {
      const sandbox = {
        output: result.output,
        JSON, Math, parseInt, parseFloat,
        String, Number, Boolean, Array, Object, RegExp, Date,
        isNaN, isFinite,
      };
      const value = vm.runInNewContext(`(${check.expectJavascript})`, sandbox, { timeout: 5000 });
      if (value === true) {
        javascriptCheckPassed = true;
        details.push('JavaScript assertion passed');
      } else {
        javascriptCheckPassed = false;
        details.push(`JavaScript assertion returned ${JSON.stringify(value)} (expected true)`);
      }
    } catch (e) {
      javascriptCheckPassed = false;
      details.push(`JavaScript assertion error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 9. Check expect_file_exists (with path traversal guard)
  // NOTE: path traversal guard uses lexical path checks. Symlinks inside cwd
  // pointing outside are not detected. This is acceptable for controlled eval
  // environments; use fs.realpathSync if untrusted paths are ever supported.
  let fileExistsCheckPassed: boolean | null = null;
  if (Array.isArray(check.expectFileExists) && check.expectFileExists.length > 0) {
    const cwd = options?.cwd ?? process.cwd();
    const resolvedCwd = path.resolve(cwd);
    if (!fs.existsSync(resolvedCwd)) {
      fileExistsCheckPassed = false;
      details.push(`Working directory does not exist: ${resolvedCwd}`);
    } else {
      const cwdPrefix = resolvedCwd.endsWith(path.sep) ? resolvedCwd : resolvedCwd + path.sep;
      const missing: string[] = [];
      for (const filePath of check.expectFileExists) {
        const resolved = path.resolve(cwd, filePath);
        if (!resolved.startsWith(cwdPrefix) && resolved !== resolvedCwd) {
          missing.push(`${filePath} (outside working directory)`);
          continue;
        }
        if (!fs.existsSync(resolved)) {
          missing.push(filePath);
        }
      }
      fileExistsCheckPassed = missing.length === 0;
      if (fileExistsCheckPassed) {
        details.push('All expected files exist');
      } else {
        details.push(`Expected files not found: ${missing.join(', ')}`);
      }
    }
  }

  // Compute overall pass/fail
  let passed: boolean;
  if (check.expectSkillActivation) {
    // For positive tests: skill must be activated and all checks must pass
    passed = skillActivated;
    if (markerFound !== null) passed = passed && markerFound;
    if (expectedToolsCalled !== null) passed = passed && expectedToolsCalled;
    if (unexpectedToolsCalled !== null) passed = passed && !unexpectedToolsCalled;
    if (containsCheckPassed !== null) passed = passed && containsCheckPassed;
    if (notContainsCheckPassed !== null) passed = passed && notContainsCheckPassed;
    if (regexCheckPassed !== null) passed = passed && regexCheckPassed;
    if (javascriptCheckPassed !== null) passed = passed && javascriptCheckPassed;
    if (fileExistsCheckPassed !== null) passed = passed && fileExistsCheckPassed;
  } else {
    // For negative tests (false positive): skill must NOT be activated
    passed = !skillActivated;
    const hasOtherAssertions = containsCheckPassed !== null || notContainsCheckPassed !== null
      || regexCheckPassed !== null || javascriptCheckPassed !== null || fileExistsCheckPassed !== null;
    if (hasOtherAssertions) {
      details.push('Note: non-activation assertions were evaluated but do not affect pass/fail for negative tests');
    }
  }

  return {
    skillActivated,
    skillName: activatedSkillName,
    markerFound,
    expectedToolsCalled,
    unexpectedToolsCalled,
    containsCheckPassed,
    notContainsCheckPassed,
    regexCheckPassed,
    javascriptCheckPassed,
    fileExistsCheckPassed,
    passed,
    details,
  };
}
