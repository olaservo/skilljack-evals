/**
 * Type definitions for the skill evaluation framework.
 */

// ============================================
// Parser Types
// ============================================

export interface EvalCriteria {
  dimension: 'discovery' | 'adherence' | 'output';
  weight: number;
  description: string;
}

export interface DeterministicCheck {
  expectSkillActivation: boolean;
  expectMarker?: string; // String or regex pattern to match in output
  expectToolCalls?: string[]; // Tools that should be called
  expectNoToolCalls?: string[]; // Tools that should NOT be called
}

export interface FixtureConfig {
  state: string;
  setup?: string; // Path to setup script
  teardown?: string; // Path to teardown script
}

export interface EvalTask {
  id: string;
  prompt: string;
  expectedSkillLoad: string;
  criteria: EvalCriteria[];
  goldenChecklist: string[];
  deterministic?: DeterministicCheck;
  fixture?: FixtureConfig;
}

export interface EvalDefaults {
  expectedSkillLoad?: string;
  criteria?: Partial<Record<'discovery' | 'adherence' | 'output', { weight?: number; description?: string }>>;
}

export interface SkillEvaluation {
  skillName: string;
  version?: string;
  defaults?: EvalDefaults;
  tasks: EvalTask[];
}

// ============================================
// Runner Types
// ============================================

export interface ToolCallRecord {
  tool: string;
  toolUseId: string;
  timestamp: number;
  input?: unknown;
}

export interface TaskResult {
  taskId: string;
  prompt: string;
  output: string;
  durationMs: number;
  numTurns: number;
  costUsd: number;
  skillLoads: string[];
  toolCalls: ToolCallRecord[];
  isError: boolean;
  errorMessage: string;
}

export interface RunnerOptions {
  cwd?: string;
  parallel?: boolean;
  model?: string;
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** Count Read calls to SKILL.md as skill discovery (default: false) */
  countReadAsFallback?: boolean;
  /** Directories the agent is allowed to write to */
  allowedWriteDirs?: string[];
}

// ============================================
// Deterministic Scoring Types
// ============================================

export interface DeterministicResult {
  skillActivated: boolean;
  skillName?: string;
  markerFound: boolean | null; // null = not tested
  expectedToolsCalled: boolean | null; // null = not tested
  unexpectedToolsCalled: boolean | null; // null = not tested
  passed: boolean;
  details: string[];
}

// ============================================
// Judge Types
// ============================================

export type FailureCategory =
  | 'discovery_failure'
  | 'false_positive'
  | 'instruction_ambiguity'
  | 'missing_guidance'
  | 'agent_error'
  | 'none';

export interface JudgeScore {
  taskId: string;
  discovery: number; // 0 or 1
  adherence: number; // 1-5
  outputQuality: number; // 1-5
  weightedScore: number; // 0-1 (normalized)
  failureCategory: FailureCategory;
  reasoning: string;
}

export interface JudgeOptions {
  model?: string;
  outputTruncation?: number;
}

// ============================================
// Combined Scoring Types
// ============================================

export interface CombinedScore {
  taskId: string;
  deterministic: DeterministicResult | null;
  judge: JudgeScore | null;

  // Final computed scores
  discovery: number; // 0 or 1
  adherence: number; // 1-5
  outputQuality: number; // 1-5
  weightedScore: number; // 0-1 normalized
  failureCategory: FailureCategory;
  reasoning: string;
}

// ============================================
// Session Logging Types
// ============================================

export interface SessionLogEntry {
  timestamp: string;
  type: 'text' | 'tool_use' | 'tool_result' | 'assistant';
  data: unknown;
}

export interface MetricsData {
  timestamp: string;
  task: string;
  timing: {
    totalElapsedMs: number;
    sdkDurationMs: number;
    apiDurationMs: number;
    overheadMs: number;
  };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  cost: number;
  turns: number;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }>;
}

export interface SessionLog {
  sessionId: string;
  task: string;
  startTime: string;
  endTime?: string;
  status: 'success' | 'error';
  errorMessage?: string;
  entries: SessionLogEntry[];
  metrics?: MetricsData;
}

// ============================================
// Report Types
// ============================================

export interface EvaluationSummary {
  totalTasks: number;
  numRuns: number;
  discoveryAccuracy: number; // 0-1
  avgAdherence: number; // 1-5
  avgOutputQuality: number; // 1-5
  avgWeightedScore: number; // 0-1
  totalDurationMs: number;
  totalCostUsd: number;
}

export interface FailureBreakdown {
  category: FailureCategory;
  count: number;
  percentage: number;
}

export interface ReportMetadata {
  skillPath: string;
  gitCommit?: string;
  gitBranch?: string;
  version?: string;
  agentModel: string;
  judgeModel: string;
}

export interface EvaluationReport {
  skillName: string;
  timestamp: string;
  passed: boolean;
  failureReasons: string[];
  metadata?: ReportMetadata;
  summary: EvaluationSummary;
  failureBreakdown: FailureBreakdown[];
  tasks: Array<{
    task: EvalTask;
    result: TaskResult;
    score: CombinedScore;
    sessionLogPath?: string;
    runDetails?: Array<{ result: TaskResult; score: CombinedScore }>;
  }>;
}

// ============================================
// SDK Message Type Guards
// ============================================

export interface SdkTextBlock {
  type: 'text';
  text: string;
}

export interface SdkToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type SdkContentBlock = SdkTextBlock | SdkToolUseBlock | { type: string; [key: string]: unknown };

export interface SdkAssistantMessage {
  type: 'assistant';
  message: {
    content: SdkContentBlock[];
  };
}

export interface SdkResultMessage {
  type: 'result';
  result?: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }>;
}

export type SdkStreamMessage = SdkAssistantMessage | SdkResultMessage | { type: string; [key: string]: unknown };

export function isAssistantMessage(msg: unknown): msg is SdkAssistantMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'assistant';
}

export function isResultMessage(msg: unknown): msg is SdkResultMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'result';
}

export function isTextBlock(block: unknown): block is SdkTextBlock {
  return typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text';
}

export function isToolUseBlock(block: unknown): block is SdkToolUseBlock {
  return typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use';
}
