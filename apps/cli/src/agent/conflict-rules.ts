import type { ResearchBrief, ResearchConflict } from './research-contracts.js';

type ConflictRule = (brief: ResearchBrief) => ResearchConflict | null;

const conflict = (
  id: string,
  severity: ResearchConflict['severity'],
  fields: string[],
  message: string,
  resolution: string,
): ResearchConflict => ({ id, severity, fields, message, resolution });

const trendWithoutTime: ConflictRule = (brief) =>
  brief.trendAnalysis &&
  brief.expectedRowCount !== undefined &&
  !brief.timeRange &&
  brief.candidateTimeColumns.length === 0
    ? conflict(
        'conflict.trend-without-time',
        'blocking',
        ['trendAnalysis', 'timeRange', 'candidateTimeColumns'],
        '你希望分析时间趋势，但检查后的数据中还没有可用的时间列或时间范围。',
        '请提供时间范围，或说明数据中哪一列代表时间。',
      )
    : null;

const comparisonWithoutGroup: ConflictRule = (brief) =>
  brief.comparisonGroups.length > 0 &&
  brief.expectedRowCount !== undefined &&
  brief.candidateGroupColumns.length === 0
    ? conflict(
        'conflict.comparison-without-group-column',
        'blocking',
        ['comparisonGroups', 'candidateGroupColumns'],
        '你希望比较不同群体，但检查后的数据中还没有可用的分组列。',
        '请说明数据中哪一列用于把记录分配到不同比较组。',
      )
    : null;

const fineTopicsWithSmallSample: ConflictRule = (brief) =>
  brief.topicGranularity === 'fine' &&
  brief.expectedRowCount !== undefined &&
  brief.expectedRowCount < 100
    ? conflict(
        'conflict.fine-topics-small-sample',
        'warning',
        ['topicGranularity', 'expectedRowCount'],
        'Fine-grained topics were requested for a very small sample.',
        'Use broader topics or provide more rows.',
      )
    : null;

const offlineRemoteEmbedding: ConflictRule = (brief) =>
  brief.offlineOnly && brief.requestedEmbedding === 'remote'
    ? conflict(
        'conflict.offline-remote-embedding',
        'blocking',
        ['offlineOnly', 'requestedEmbedding'],
        'A remote embedding provider conflicts with the offline-only constraint.',
        'Select a local embedding provider or relax the offline-only constraint.',
      )
    : null;

const cpuLargeModel: ConflictRule = (brief) =>
  brief.hardwareLimit.device === 'cpu' &&
  brief.topicGranularity === 'fine' &&
  (brief.expectedRowCount ?? 0) > 100_000
    ? conflict(
        'conflict.cpu-large-workload',
        'warning',
        ['hardwareLimit', 'topicGranularity', 'expectedRowCount'],
        'A large fine-grained workload is unlikely to finish efficiently on CPU only.',
        'Reduce granularity, sample the dataset, or provide a GPU.',
      )
    : null;

const shortDeadlineLargeWorkload: ConflictRule = (brief) =>
  brief.timeLimitHours !== undefined &&
  brief.timeLimitHours < 1 &&
  (brief.expectedRowCount ?? 0) > 100_000
    ? conflict(
        'conflict.short-deadline-large-workload',
        'warning',
        ['timeLimitHours', 'expectedRowCount'],
        'The requested time limit is too short for the expected dataset size.',
        'Increase the time limit or reduce the dataset before training.',
      )
    : null;

export const researchConflictRules: readonly ConflictRule[] = [
  trendWithoutTime,
  comparisonWithoutGroup,
  fineTopicsWithSmallSample,
  offlineRemoteEmbedding,
  cpuLargeModel,
  shortDeadlineLargeWorkload,
];

export const detectResearchConflicts = (
  brief: ResearchBrief,
): ResearchConflict[] =>
  researchConflictRules
    .map((rule) => rule(brief))
    .filter((value): value is ResearchConflict => value !== null);
