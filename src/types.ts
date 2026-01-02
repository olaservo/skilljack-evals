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

export interface EvalTask {
  id: string;
  prompt: string;
  expectedSkillLoad: string;
  criteria: EvalCriteria[];
  goldenChecklist: string[];
}

export interface SkillEvaluation {
  skillName: string;
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
}

// ============================================
// Judge Types
// ============================================

export type FailureCategory =
  | 'discovery_failure'
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
}

// ============================================
// Report Types
// ============================================

export interface EvaluationSummary {
  totalTasks: number;
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
  metadata?: ReportMetadata;
  summary: EvaluationSummary;
  failureBreakdown: FailureBreakdown[];
  tasks: Array<{
    task: EvalTask;
    result: TaskResult;
    score: JudgeScore;
  }>;
}
