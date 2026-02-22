/**
 * Session logger for capturing evaluation run events.
 *
 * Captures tool calls, text output, metrics, and eval results
 * for debugging and reporting purposes.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionLogEntry, SessionLog, MetricsData } from '../types.js';

export class SessionLogger {
  private log: SessionLog;
  private logDir: string;

  constructor(task: string, logDir: string = './results/logs') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logDir = logDir;
    this.log = {
      sessionId: `eval-${task}-${timestamp}`,
      task,
      startTime: new Date().toISOString(),
      status: 'success',
      entries: [],
    };
  }

  addEntry(type: SessionLogEntry['type'], data: unknown): void {
    this.log.entries.push({
      timestamp: new Date().toISOString(),
      type,
      data,
    });
  }

  addTextMessage(text: string): void {
    this.addEntry('text', { text });
  }

  addToolUse(name: string, input: unknown): void {
    this.addEntry('tool_use', { name, input });
  }

  addToolResult(name: string, success: boolean): void {
    this.addEntry('tool_result', { name, success });
  }

  addAssistantMessage(content: unknown[]): void {
    this.addEntry('assistant', { content });
  }

  setMetrics(metrics: MetricsData): void {
    this.log.metrics = metrics;
  }

  markAsError(errorMessage: string): void {
    this.log.status = 'error';
    this.log.errorMessage = errorMessage;
  }

  getEntries(): SessionLogEntry[] {
    return this.log.entries;
  }

  getSessionId(): string {
    return this.log.sessionId;
  }

  /**
   * Save session log to disk as both JSON and human-readable markdown.
   */
  async save(): Promise<{ jsonPath: string; mdPath: string }> {
    this.log.endTime = new Date().toISOString();

    await fs.mkdir(this.logDir, { recursive: true });

    const prefix = this.log.status === 'error' ? 'FAILED__' : '';
    const baseName = `${prefix}${this.log.sessionId}`;

    const jsonPath = path.join(this.logDir, `${baseName}.json`);
    const mdPath = path.join(this.logDir, `${baseName}.md`);

    await fs.writeFile(jsonPath, JSON.stringify(this.log, null, 2));
    await fs.writeFile(mdPath, this.generateReadableLog());

    return { jsonPath, mdPath };
  }

  private generateReadableLog(): string {
    const lines: string[] = [];

    lines.push(`# Eval Session: ${this.log.sessionId}`);
    lines.push(`**Task:** ${this.log.task}`);
    lines.push(`**Start:** ${this.log.startTime}`);
    lines.push(`**End:** ${this.log.endTime || 'In progress'}`);
    lines.push(`**Status:** ${this.log.status === 'success' ? 'PASS' : 'FAIL'} (${this.log.status})`);
    if (this.log.errorMessage) {
      lines.push(`**Error:** ${this.log.errorMessage}`);
    }
    lines.push('');

    if (this.log.metrics) {
      lines.push('## Metrics');
      lines.push(`- **Duration:** ${formatDuration(this.log.metrics.timing.totalElapsedMs)}`);
      lines.push(`- **Cost:** $${this.log.metrics.cost.toFixed(6)}`);
      lines.push(`- **Turns:** ${this.log.metrics.turns}`);
      lines.push(`- **Tokens:** ${this.log.metrics.tokens.total.toLocaleString()}`);
      lines.push('');
    }

    lines.push('## Events');
    lines.push('');

    let toolCount = 0;
    for (const entry of this.log.entries) {
      const time = entry.timestamp.split('T')[1]?.split('.')[0] || '';

      switch (entry.type) {
        case 'text': {
          const data = entry.data as { text: string };
          const preview = data.text.length > 500 ? data.text.substring(0, 500) + '...' : data.text;
          lines.push(`### [${time}] Text`);
          lines.push('```');
          lines.push(preview);
          lines.push('```');
          lines.push('');
          break;
        }
        case 'tool_use': {
          toolCount++;
          const data = entry.data as { name: string; input: unknown };
          lines.push(`### [${time}] Tool #${toolCount}: ${data.name}`);
          const inputStr = JSON.stringify(data.input, null, 2);
          lines.push('```json');
          lines.push(inputStr.length > 1000 ? inputStr.substring(0, 1000) + '\n...' : inputStr);
          lines.push('```');
          lines.push('');
          break;
        }
        case 'tool_result': {
          const data = entry.data as { name: string; success: boolean };
          lines.push(`- Tool result: ${data.name} - ${data.success ? 'Success' : 'Failed'}`);
          lines.push('');
          break;
        }
        case 'assistant': {
          const data = entry.data as { content: unknown[] };
          lines.push(`### [${time}] Assistant`);
          for (const chunk of data.content) {
            if (typeof chunk === 'object' && chunk !== null) {
              const c = chunk as { type: string; text?: string; name?: string };
              if (c.type === 'text' && c.text) {
                const preview = c.text.length > 300 ? c.text.substring(0, 300) + '...' : c.text;
                lines.push('```');
                lines.push(preview);
                lines.push('```');
              } else if (c.type === 'tool_use' && c.name) {
                lines.push(`Tool call: ${c.name}`);
              }
            }
          }
          lines.push('');
          break;
        }
      }
    }

    lines.push('---');
    lines.push(`Total tool calls: ${toolCount}`);

    return lines.join('\n');
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(1);
  return `${min}m ${sec}s`;
}
