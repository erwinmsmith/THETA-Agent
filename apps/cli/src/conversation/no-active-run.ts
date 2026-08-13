import type { ConversationCommand } from './contracts.js';

const RUN_DEPENDENT_COMMANDS = new Set<ConversationCommand['kind']>([
  'status',
  'why',
  'evidence',
  'plan',
  'approve',
  'approvePlan',
  'startTraining',
  'save',
  'answer',
  'columns',
  'brief',
  'next',
  'done',
  'follow',
  'logs',
  'results',
  'openResults',
  'summary',
  'retry',
  'reevaluate',
  'adjust',
  'cancel',
]);

export interface NoActiveRunResult {
  kind: 'run.required';
  requestedCommand: string;
  message: string;
}

export const commandNeedsActiveRun = (
  command: ConversationCommand,
  activeRunId: string | undefined,
): boolean => {
  if (!RUN_DEPENDENT_COMMANDS.has(command.kind)) return false;
  if (activeRunId) return false;
  return !('runId' in command && typeof command.runId === 'string');
};

export const noActiveRunResult = (
  requestedCommand: string,
): NoActiveRunResult => ({
  kind: 'run.required',
  requestedCommand,
  message: '当前还没有分析任务。请先选择一个本地数据文件创建任务。',
});
