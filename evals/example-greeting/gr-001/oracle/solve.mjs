// Oracle for gr-001: reference solution that must satisfy the verifier.
// Writes the expected agent output (per the greeting skill format) to
// SKILLJACK_OUTPUT_FILE so the verifier can assert against it.
import { writeFileSync } from 'node:fs';

const output = `Hello! GREETING_SUCCESS

It's wonderful to meet you! I hope you're having a fantastic day.

Warm regards!
`;

writeFileSync(process.env.SKILLJACK_OUTPUT_FILE, output);
