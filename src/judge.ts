/**
 * LLM-as-judge for scoring skill evaluation results.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EvalTask, TaskResult, JudgeScore, JudgeOptions, FailureCategory } from './types.js';

const JUDGE_PROMPT_TEMPLATE = `You are an expert evaluator for AI agent skills. Score this skill evaluation result.

## Task Information
**Prompt given to agent:** {prompt}

**Expected skill to load:** {expectedSkill}

**Criteria:**
{criteriaText}

**Golden checklist (expected behaviors):**
{checklistText}

## Agent Result
**Skills that were loaded:** {skillLoads}

**Agent output:**
{output}

## Scoring Instructions

Score the agent's performance on three dimensions:

1. **Discovery (0 or 1)**: Did the agent load the expected skill "{expectedSkill}"?
   - Score 1 if the expected skill was loaded
   - Score 0 if it was not loaded

2. **Adherence (1-5)**: How well did the agent follow the skill's instructions?
   - 5 = Perfectly followed all instructions
   - 4 = Followed most instructions with minor deviations
   - 3 = Followed core instructions but missed some details
   - 2 = Partially followed instructions with significant gaps
   - 1 = Did not follow the skill's instructions

3. **Output Quality (1-5)**: Does the output meet the task requirements?
   - 5 = Excellent output, meets all requirements
   - 4 = Good output with minor issues
   - 3 = Acceptable output, meets basic requirements
   - 2 = Poor output, missing key requirements
   - 1 = Unacceptable output

4. **Failure Category** (if score < 4 on any dimension):
   - "discovery_failure": Agent didn't load the skill when it should have
   - "instruction_ambiguity": Agent misinterpreted skill instructions
   - "missing_guidance": Skill didn't cover a needed case
   - "agent_error": Agent made a mistake despite clear guidance
   - "none": No significant failure

Respond with a JSON object:
\`\`\`json
{
  "discovery": <0 or 1>,
  "adherence": <1-5>,
  "output_quality": <1-5>,
  "failure_category": "<category or none>",
  "reasoning": "<brief explanation of scores>"
}
\`\`\`
`;

/**
 * LLM-as-judge for scoring skill evaluation results.
 */
export class SkillJudge {
  private options: Required<JudgeOptions>;

  constructor(options: JudgeOptions = {}) {
    this.options = {
      model: options.model ?? 'haiku', // Haiku for faster/cheaper judging
    };
  }

  /**
   * Build the prompt for the judge.
   */
  private buildJudgePrompt(task: EvalTask, result: TaskResult): string {
    // Format criteria
    const criteriaLines = task.criteria.map(
      (c) => `- **${capitalize(c.dimension)}** (weight ${c.weight}): ${c.description}`
    );
    const criteriaText = criteriaLines.length > 0
      ? criteriaLines.join('\n')
      : '- No specific criteria defined';

    // Format checklist
    const checklistText = task.goldenChecklist.length > 0
      ? task.goldenChecklist.map((item) => `- ${item}`).join('\n')
      : '- No checklist defined';

    // Format skill loads
    const skillLoads = result.skillLoads.length > 0
      ? result.skillLoads.join(', ')
      : 'None';

    return JUDGE_PROMPT_TEMPLATE
      .replace('{prompt}', task.prompt)
      .replace(/{expectedSkill}/g, task.expectedSkillLoad)
      .replace('{criteriaText}', criteriaText)
      .replace('{checklistText}', checklistText)
      .replace('{skillLoads}', skillLoads)
      .replace('{output}', result.output.slice(0, 5000) || '(no output)');
  }

  /**
   * Parse the judge's JSON response into a JudgeScore.
   */
  private parseJudgeResponse(
    response: string,
    taskId: string,
    weights: Map<string, number>
  ): JudgeScore {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      return this.createErrorScore(taskId, 'Failed to parse judge response');
    }

    try {
      const data = JSON.parse(jsonMatch[0]);

      const discovery = Number(data.discovery) || 0;
      const adherence = Number(data.adherence) || 1;
      const outputQuality = Number(data.output_quality) || 1;

      // Normalize to 0-1 scale for weighted calculation
      const adherenceNorm = (adherence - 1) / 4;
      const outputNorm = (outputQuality - 1) / 4;

      const weightedScore =
        (weights.get('discovery') ?? 0.3) * discovery +
        (weights.get('adherence') ?? 0.4) * adherenceNorm +
        (weights.get('output') ?? 0.3) * outputNorm;

      return {
        taskId,
        discovery,
        adherence,
        outputQuality,
        weightedScore,
        failureCategory: (data.failure_category || 'none') as FailureCategory,
        reasoning: data.reasoning || '',
      };
    } catch {
      return this.createErrorScore(taskId, 'Invalid JSON in judge response');
    }
  }

  /**
   * Create an error score when parsing fails.
   */
  private createErrorScore(taskId: string, reason: string): JudgeScore {
    return {
      taskId,
      discovery: 0,
      adherence: 1,
      outputQuality: 1,
      weightedScore: 0,
      failureCategory: 'agent_error',
      reasoning: reason,
    };
  }

  /**
   * Score a single evaluation result.
   */
  async judgeResult(task: EvalTask, result: TaskResult): Promise<JudgeScore> {
    // Handle error cases
    if (result.isError) {
      return {
        taskId: task.id,
        discovery: 0,
        adherence: 1,
        outputQuality: 1,
        weightedScore: 0,
        failureCategory: 'agent_error',
        reasoning: `Task failed with error: ${result.errorMessage}`,
      };
    }

    // Build weights map from criteria
    const weights = new Map<string, number>();
    for (const c of task.criteria) {
      weights.set(c.dimension, c.weight);
    }

    const prompt = this.buildJudgePrompt(task, result);

    try {
      let responseText = '';

      for await (const message of query({
        prompt,
        options: {
          model: this.options.model,
          allowedTools: [], // No tools needed for judging
          permissionMode: 'bypassPermissions',
        },
      })) {
        // Capture text output
        if (message.type === 'assistant' && message.message) {
          const content = (message.message as any).content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                responseText += block.text;
              }
            }
          }
        }

        // Also check result message
        if (message.type === 'result') {
          const res = message as any;
          if (res.result) {
            responseText = res.result;
          }
        }
      }

      return this.parseJudgeResponse(responseText, task.id, weights);
    } catch (error) {
      // Fallback: simple heuristic scoring
      const discovery = result.skillLoads.includes(task.expectedSkillLoad) ? 1 : 0;
      return {
        taskId: task.id,
        discovery,
        adherence: 3,
        outputQuality: 3,
        weightedScore: 0.5,
        failureCategory: discovery === 0 ? 'discovery_failure' : 'none',
        reasoning: `Heuristic scoring (judge error: ${error instanceof Error ? error.message : 'unknown'})`,
      };
    }
  }

  /**
   * Score all evaluation results.
   */
  async judgeAll(tasks: EvalTask[], results: TaskResult[]): Promise<JudgeScore[]> {
    const scores: JudgeScore[] = [];
    for (let i = 0; i < tasks.length; i++) {
      console.log(`Judging task ${tasks[i].id}...`);
      const score = await this.judgeResult(tasks[i], results[i]);
      scores.push(score);
    }
    return scores;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
