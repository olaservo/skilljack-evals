/**
 * Backward-compatible re-export of the Claude SDK runner.
 *
 * New code should import from './claude-sdk-runner.js' or use the
 * runner factory via './runner-factory.js'.
 */

export { ClaudeSdkRunner as SkillEvalRunner } from './claude-sdk-runner.js';
export type { ClaudeSdkRunnerOptions } from './claude-sdk-runner.js';
