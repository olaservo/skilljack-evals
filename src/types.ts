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
  expectMarker?: string; // String to match in output (case-insensitive)
  expectToolCalls?: string[]; // Tools that should be called
  expectNoToolCalls?: string[]; // Tools that should NOT be called
  expectContains?: string[]; // Substrings that must appear in output (case-sensitive)
  expectNotContains?: string[]; // Substrings that must NOT appear in output (case-sensitive)
  expectRegex?: string[]; // Regex patterns that must match output
  expectJavascript?: string; // JS expression evaluated with `output` in scope, must return true
  expectFileExists?: string[]; // Files that must exist (relative to cwd)
}

export type TaskDifficulty = 'easy' | 'medium' | 'hard';

export interface EvalTask {
  id: string;
  prompt: string;
  expectedSkillLoad: string;
  criteria: EvalCriteria[];
  goldenChecklist: string[];
  deterministic?: DeterministicCheck;
  /** Task-package metadata (optional). */
  difficulty?: TaskDifficulty;
  category?: string;
  tags?: string[];
  /** Per-task timeout override in ms. */
  timeoutMs?: number;
  /** Per-trial workspace directory (set by the pipeline before each run). */
  workspaceDir?: string;
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

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
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
  /** Undefined when the runner cannot report usage (e.g. Copilot SDK). */
  tokens?: TokenUsage;
  /** Outcome of the task's verifier script, when the task package has one. */
  verifier?: VerifierOutcome;
}

// ============================================
// Verifier Types
// ============================================

export type VerifierStatus = 'ok' | 'error' | 'timeout' | 'missing-interpreter';

export interface VerifierOutcome {
  /** Reward in [0, 1]: reward file contents if written, else exit code (0 → 1, nonzero → 0). */
  reward: number;
  /** True when reward >= 1. */
  passed: boolean;
  exitCode: number | null;
  status: VerifierStatus;
  stdout: string;
  stderr: string;
  durationMs: number;
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
  verifierPassed: boolean | null; // null = task has no verifier outcome
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

  /**
   * Reward-authoritative trial outcome: true when all deterministic checks
   * passed (including verifier reward >= 1) and the agent did not error.
   * For aggregated multi-trial scores: true only when every trial passed.
   */
  passed: boolean;
  /**
   * Reward in [0, 1]. 1 when passed; the verifier's partial reward (or 0)
   * when failed. For aggregated scores this is the mean across trials —
   * i.e. the per-task resolution rate.
   */
  reward: number;
  /**
   * Deterministic skill-discovery signal (0/1; rate across trials when
   * aggregated). For anti-trigger tasks 1 = correctly did NOT activate.
   */
  discovery: number;
  /**
   * Expected-skill invocation signal (0/1; rate when aggregated). Undefined
   * for anti-trigger tasks and baseline (no-skill) trials — feeds the
   * Skill Invocation Rate metric.
   */
  invocation?: number;

  // Judge diagnostics (present only when the judge ran). Never affect passed.
  adherence?: number; // 1-5
  outputQuality?: number; // 1-5

  failureCategory: FailureCategory;
  reasoning: string;
  checklistResults?: ChecklistItemResult[];
  /** Per-trial outcomes (populated by multi-run aggregation). */
  trials?: { passed: boolean[]; rewards: number[] };
  stddev?: ScoreStddev; // Only populated when N >= 2
}

export interface ScoreStddev {
  reward: number;
  discovery: number;
  adherence?: number;
  outputQuality?: number;
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

/** Binomial confidence interval bounds, clamped to [0, 1]. */
export interface ResolutionCI {
  low: number;
  high: number;
}

export interface EvaluationSummary {
  totalTasks: number;
  numRuns: number;
  /** Mean per-task trial pass rate (0-1) — the headline metric. */
  resolutionRate: number;
  /** 95% binomial CI on the resolution rate. */
  resolutionCI: ResolutionCI;
  /** Share of tasks with at least one passing trial (0-1). */
  passAtK: number;
  /**
   * Share of trials where the expected skill was invoked, over tasks that
   * expect an invocation. Undefined when no task expects one (e.g. baseline).
   */
  invocationRate?: number;
  /** Judge diagnostics — present only when the judge ran. */
  avgAdherence?: number; // 1-5
  avgOutputQuality?: number; // 1-5
  totalDurationMs: number;
  totalCostUsd: number;
  /** Undefined when any task's runner couldn't report tokens. */
  totalTokens?: number;
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
  /** Skill lift: with-skill resolution rate minus baseline resolution rate. */
  lift: number;
  durationDeltaMs: number;
  costDeltaUsd: number;
  /** Undefined when either arm lacks tokens. */
  totalTokensDelta?: number;
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
    /** Macro skill lift: with-skill resolution rate minus baseline. */
    resolutionRateDelta: number;
    passAtKDelta: number;
    totalDurationDeltaMs: number;
    totalCostDeltaUsd: number;
    /** Undefined when either arm lacks tokens. */
    totalTokensDelta?: number;
  };
  baselineLabel: string;
}

/** Comparison data included in report when --compare is used */
export interface ComparisonData {
  compareSkillPath?: string;
  summary: ComparisonSummary;
  tasks: TaskComparison[];
}

/** Per-task score snapshot for cross-iteration comparison */
export interface ScoreSnapshot {
  resolutionRate: number;
  lift?: number;
}

/** Summary snapshot for cross-iteration comparison */
export interface SummarySnapshot {
  resolutionRate: number;
  passAtK: number;
  skillLift?: number;
}

/** Per-task delta for cross-iteration comparison */
export interface TaskDelta {
  taskId: string;
  previous: ScoreSnapshot;
  current: ScoreSnapshot;
  /** Resolution-rate delta (current minus previous). */
  delta: number;
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
