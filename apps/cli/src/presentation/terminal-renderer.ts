import type {
  HumanFacingResponse,
  HumanOutputMode,
} from '@theta-agent/agent/presentation/contracts.js';
import { buildHumanResponse } from '@theta-agent/agent/presentation/human-response-builder.js';

export const renderValue = (
  value: unknown,
  mode: HumanOutputMode = 'human',
): string => {
  if (mode === 'json') return JSON.stringify(value);
  if (mode === 'debug') return JSON.stringify(value, null, 2);
  return renderHumanResponse(buildHumanResponse(value), mode);
};

export const renderHumanResponse = (
  view: HumanFacingResponse,
  mode: Exclude<HumanOutputMode, 'json' | 'debug'> = 'human',
): string => {
  const lines: string[] = [];
  lines.push(`\n${view.title}`);
  if (view.progress) {
    const step = `步骤 ${view.progress.current}/${view.progress.total}`;
    const percent =
      view.progress.percent === undefined
        ? ''
        : ` · ${Math.max(0, Math.min(100, view.progress.percent)).toFixed(0)}%`;
    lines.push(`${step} · ${view.progress.label}${percent}`);
  }
  lines.push('', view.summary);

  for (const section of view.sections ?? []) {
    lines.push('');
    if (section.title) lines.push(section.title);
    lines.push(...section.lines.map((line) => `  ${line}`));
  }

  if (view.warnings?.length) {
    lines.push('', '需要注意');
    lines.push(...view.warnings.map((warning) => `  ! ${warning}`));
  }

  if (view.nextActions.length) {
    lines.push('', '下一步');
    for (const item of view.nextActions) {
      const marker = item.recommended ? '→' : ' ';
      const command = item.command ? `  ${item.command}` : '';
      lines.push(`${marker} ${item.label}${command}`);
      if (mode === 'verbose') lines.push(`    ${item.description}`);
    }
  }

  if (mode === 'verbose' && view.technicalDetails !== undefined) {
    lines.push('', '提示：使用 --json 或 /details 查看完整机器数据。');
  }
  return lines.join('\n');
};

export const renderUserError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/Run not found:/iu.test(message)) {
    const runId = message.split(':').slice(1).join(':').trim();
    return [
      '',
      '没有找到这个任务',
      '',
      `Run ${runId || '（未知）'} 尚未创建，或它存储在另一个 Runtime DB 中。`,
      '',
      '下一步',
      '→ 在 REPL 中使用 /start <数据文件> 创建新任务',
      '  使用 /runs 查看本地已有任务',
      '  使用 /back 清除当前任务 ID',
    ].join('\n');
  }
  if (/No active Run/iu.test(message)) {
    return [
      '',
      '当前没有活动任务',
      '',
      '请先创建或选择一个任务。',
      '',
      '下一步',
      '→ /start <数据文件>',
      '  /runs',
    ].join('\n');
  }
  if (/not waiting for a research answer/iu.test(message)) {
    return '\n当前步骤不需要研究回答。\n\n下一步\n→ /status\n  /next';
  }
  if (/not waiting for column confirmation/iu.test(message)) {
    return '\n当前步骤不需要确认数据列。\n\n下一步\n→ /status\n  /next';
  }
  return [
    '',
    '操作未完成',
    '',
    message,
    '',
    '下一步',
    '→ /status  查看当前状态',
    '  /help    查看可用命令',
    '  /details 查看技术信息',
  ].join('\n');
};
