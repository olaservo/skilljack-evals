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
  expectContains?: string[]; // Substrings that must appear in output
  expectNotContains?: string[]; // Substrings that must NOT appear in output
  expectRegex?: string[]; // Regex patterns that must match output
  expectJavascript?: string; // JS expression evaluated with `output` in scope, must return true
  expectFileExists?: string[]; // Files that must exist (relative to cwd)
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

// ============================================
// Deterministic Scoring Types
// ============================================

export interface DeterministicResult {
  skillActivated: boolean;
  skillName?: string;
  markerFound: boolean | null; // null = not tested
  expectedToolsCalled: boolean | null; // null = not tested
  unexpectedToolsCalled: boolean | null; // null = not tested
  containsCheckPassed: boolean | null; // null = not tested
  notContainsCheckPassed: boolean | null; // null = not tested
  regexCheckPassed: boolean | null; // null = not tested
  javascriptCheckPassed: boolean | null; // null = not tested
  fileExistsCheckPassed: boolean | null; // null = not tested
  passed: boolean;
  details: string[];
}

// ============================================
// Human Feedback Types
// ============================================

/**
 * Human review feedback keyed by task ID.
 * Empty string = task passed review (no feedback).
 * Non-empty string = reviewer comments on issues.
 */
export type HumanFeedback = Record<string, string>;

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

export interface ChecklistItemResult {
  item: string;
  passed: boolean;
  evidence?: string;
}

export interface JudgeScore {
  taskId: string;
  discovery: number; // 0 or 1
  adherence: number; // 1-5
  outputQuality: number; // 1-5
  weightedScore: number; // 0-1 (normalized)
  failureCategory: FailureCategory;
  reasoning: string;
  checklistResults: ChecklistItemResult[];
  feedbackAddressed?: boolean; // true = addressed, false = not, undefined = no feedback
}

export interface JudgeOptions {
  model?: string;
  outputTruncation?: number;
  /** True for no-skill baseline evaluation — uses baseline judge prompt */
  isBaseline?: boolean;
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
  checklistResults?: ChecklistItemResult[];
  stddev?: ScoreStddev; // Only populated when N >= 2
}

export interface ScoreStddev {
  discovery: number;
  adherence: number;
  outputQuality: number;
  weightedScore: number;
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
  stddev?: ScoreStddev; // Only populated when N >= 2
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
  runnerType?: string;
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
  humanFeedback?: HumanFeedback;
  comparison?: ComparisonData;
  blindComparison?: BlindComparisonData;
  crossIterationComparison?: ComparisonResult;
}

// ============================================
// Comparison Types
// ============================================

/** Per-task delta metrics between with-skill and baseline runs */
export interface TaskComparisonDelta {
  taskId: string;
  discoveryDelta: number;
  adherenceDelta: number;
  outputQualityDelta: number;
  weightedScoreDelta: number;
  durationDeltaMs: number;
  costDeltaUsd: number;
}

/** Per-task comparison data with both sides */
export interface TaskComparison {
  taskId: string;
  originalPrompt: string;
  withSkill: { result: TaskResult; score: CombinedScore };
  withoutSkill: { result: TaskResult; score: CombinedScore };
  delta: TaskComparisonDelta;
}

/** Summary-level comparison data */
export interface ComparisonSummary {
  withSkill: EvaluationSummary;
  withoutSkill: EvaluationSummary;
  delta: {
    discoveryAccuracyDelta: number;
    avgAdherenceDelta: number;
    avgOutputQualityDelta: number;
    avgWeightedScoreDelta: number;
    totalDurationDeltaMs: number;
    totalCostDeltaUsd: number;
  };
  baselineLabel: string;
}

/** Comparison data included in report when --compare is used */
export interface ComparisonData {
  compareSkillPath?: string;
  summary: ComparisonSummary;
  tasks: TaskComparison[];
}

/** Score snapshot for cross-iteration comparison */
export interface ScoreSnapshot {
  discovery: number;
  adherence: number;
  outputQuality: number;
  weightedScore: number;
}

/** Summary snapshot for cross-iteration comparison */
export interface SummarySnapshot {
  discoveryAccuracy: number;
  avgAdherence: number;
  avgOutputQuality: number;
  avgWeightedScore: number;
}

/** Per-task delta for cross-iteration comparison */
export interface TaskDelta {
  taskId: string;
  previous: ScoreSnapshot;
  current: ScoreSnapshot;
  delta: ScoreSnapshot;
  significantChange: 'improved' | 'regressed' | 'unchanged';
}

/** Summary-level delta for cross-iteration comparison */
export interface SummaryDelta {
  previous: SummarySnapshot;
  current: SummarySnapshot;
  delta: SummarySnapshot;
}

/** Cross-iteration comparison result (--compare-results) */
export interface ComparisonResult {
  previousTimestamp: string;
  previousSkillName: string;
  summaryDelta: SummaryDelta;
  taskDeltas: TaskDelta[];
  tasksOnlyInCurrent: string[];
  tasksOnlyInPrevious: string[];
}

// ============================================
// Blind Comparison Types
// ============================================

export interface BlindOutputScore {
  instructionFollowing: number; // 1-5 (generic rubric, distinct from skill-specific "adherence")
  outputQuality: number;       // 1-5
}

export interface BlindTaskComparison {
  taskId: string;
  withSkillLabel: 'A' | 'B';           // which label the with-skill output got
  outputA: BlindOutputScore | null;
  outputB: BlindOutputScore | null;
  preferred: 'A' | 'B' | 'tie';
  reasoning: string;
  preferredCondition: 'with-skill' | 'without-skill' | 'tie';
  biasSignal: boolean;                  // blind disagrees with standard scoring
  failed: boolean;                      // true when blind judge call failed
}

export interface BlindComparisonData {
  tasks: BlindTaskComparison[];
  aggregate: {
    withSkillPreferred: number;
    withoutSkillPreferred: number;
    ties: number;
    biasSignalCount: number;
    failedCount: number;
  };
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
