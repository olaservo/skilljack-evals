// Verifier for gr-001: the agent's final output must contain the
// GREETING_SUCCESS marker produced by the greeting skill.
// Runs with cwd = trial workspace; contract files come in via env vars.
import { readFileSync, writeFileSync } from 'node:fs';

const output = readFileSync(process.env.SKILLJACK_OUTPUT_FILE, 'utf-8');

const passed = output.includes('GREETING_SUCCESS');

writeFileSync(process.env.SKILLJACK_REWARD_FILE, passed ? '1' : '0');
