/**
 * Deterministic scorer for skill evaluations.
 *
 * Performs fast, free checks based on tool call analysis and output markers.
 * No LLM calls required — checks are purely based on the session data.
 */

import type {
  EvalTask,
  TaskResult,
  DeterministicResult,
} from '../types.js';

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
  result: TaskResult
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

  // 2. Check marker in output
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
  if (check.expectToolCalls && check.expectToolCalls.length > 0) {
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
  if (check.expectNoToolCalls && check.expectNoToolCalls.length > 0) {
    const calledTools = new Set(result.toolCalls.map((c) => c.tool));
    const forbidden = check.expectNoToolCalls.filter((t) => calledTools.has(t));
    unexpectedToolsCalled = forbidden.length > 0;
    if (unexpectedToolsCalled) {
      details.push(`Forbidden tools were called: ${forbidden.join(', ')}`);
    } else {
      details.push(`No forbidden tools called`);
    }
  }

  // Compute overall pass/fail
  let passed: boolean;
  if (check.expectSkillActivation) {
    // For positive tests: skill must be activated
    passed = skillActivated;
    if (markerFound !== null) passed = passed && markerFound;
    if (expectedToolsCalled !== null) passed = passed && expectedToolsCalled;
    if (unexpectedToolsCalled !== null) passed = passed && !unexpectedToolsCalled;
  } else {
    // For negative tests (false positive): skill must NOT be activated
    passed = !skillActivated;
  }

  return {
    skillActivated,
    skillName: activatedSkillName,
    markerFound,
    expectedToolsCalled,
    unexpectedToolsCalled,
    passed,
    details,
  };
}
