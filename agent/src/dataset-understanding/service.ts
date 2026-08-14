import {
  datasetFactsSchema,
  datasetUnderstandingDraftSchema,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
} from '@theta-agent/domain/dataset-understanding/contracts.js';
import type { ThetaDatasetExploreOutput } from '@theta-agent/tools/dataset-explore-tool.js';

export const buildDatasetFacts = (
  output: ThetaDatasetExploreOutput,
): DatasetFacts =>
  datasetFactsSchema.parse({
    schemaVersion: '2.0.0',
    datasetRef: output.datasetRef,
    datasetHash: output.datasetHash,
    fileName: output.fileName,
    format: output.format,
    sizeBytes: output.sizeBytes,
    encoding: output.encoding ?? 'unknown',
    delimiter: output.delimiter ?? null,
    sheets: output.sheets ?? [],
    selectedSheet: output.selectedSheet ?? null,
    rowCount: output.rowCount,
    columns: output.columnProfiles.map((profile) => ({
      name: profile.name,
      inferredType: profile.inferredType,
      missingRatio: profile.missingRatio,
      uniqueCount: profile.uniqueCount,
      uniqueRatio: profile.uniqueRatio ?? 0,
      averageLength: profile.averageLength,
      maximumLength: profile.maximumLength,
      parseSuccessRatio: profile.parseSuccessRatio ?? 0,
      sampleValues: profile.sampleValues ?? [],
    })),
    languageDistribution: output.languageDistribution,
    duplicateRatio: output.duplicateRatio,
    timeCoverage: output.timeCoverage,
    samplePolicy: output.samplePolicy ?? {
      method: 'deterministic_reservoir',
      requestedRows: 10,
      returnedRows: output.sampleRows.length,
      profileRows: output.rowCount,
      profileTruncated: false,
    },
    redactionApplied: output.redactionSummary.applied,
    sensitiveDataRisk: output.redactionSummary.applied ? 'redacted' : 'none_detected',
    qualityWarnings: output.qualityWarnings,
    generatedAt: new Date().toISOString(),
  });

export const buildDeterministicUnderstanding = (
  facts: DatasetFacts,
  output: ThetaDatasetExploreOutput,
): DatasetUnderstandingDraft => {
  const candidate = (column: string, confidence: number, reason: string) => ({
    column,
    confidence,
    reason,
  });
  const textColumns = output.candidateRoles.text.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const timeColumns = output.candidateRoles.time.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const idColumns = output.candidateRoles.id.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const metadataColumns = output.candidateRoles.metadata.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const groupColumns = (output.candidateRoles.group ?? []).map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const covariateColumns = (output.candidateRoles.covariate ?? []).map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const evaluationColumns = (output.candidateRoles.evaluation ?? []).map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const ignoredColumns = (output.candidateRoles.ignored ?? []).map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const contentSummary = buildLocalContentSummary(
    output,
    textColumns[0]?.column,
  );
  const analysisUnit = textColumns[0]
    ? `每一行是一条独立记录，主要分析 ${textColumns[0].column} 列中的文本。`
    : '每一行是一条独立记录；当前没有足够证据确定正文列。';
  return datasetUnderstandingDraftSchema.parse({
    schemaVersion: '2.0.0',
    datasetRef: facts.datasetRef,
    datasetHash: facts.datasetHash,
    domain: output.inferredDomain,
    analysisUnit,
    contentSummary,
    evidenceReferences: [
      ...textColumns.slice(0, 3).map((entry) => ({
        kind: 'column_profile' as const,
        column: entry.column,
        claim: entry.reason,
      })),
      ...timeColumns.slice(0, 2).map((entry) => ({
        kind: 'column_profile' as const,
        column: entry.column,
        claim: entry.reason,
      })),
      ...contentSummary.candidateTopics.flatMap((topic) =>
        topic.evidenceSampleIndexes.slice(0, 1).map((sampleIndex) => ({
          kind: 'sample_row' as const,
          sampleIndex,
          claim: `原始文本样本支持候选主题“${topic.label}”。`,
        })),
      ).slice(0, 5),
    ],
    textColumns,
    timeColumns,
    idColumns,
    metadataColumns,
    groupColumns,
    covariateColumns,
    evaluationColumns,
    ignoredColumns,
    qualityWarnings: output.qualityWarnings,
    assumptions: [
      '列角色来自字段名、数据类型、长度与唯一性统计，尚未替代用户的领域确认。',
      '候选主题来自本地脱敏样本的初步内容分析，只用于理解确认，不是训练结果。',
    ],
    confidence: textColumns[0]?.confidence ?? 0.35,
    provenance: {
      source: 'deterministic',
      toolIds: ['theta.dataset.explore'],
      sampleSeed: output.sampleSeed,
      generatedAt: new Date().toISOString(),
    },
  });
};

const CONTENT_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before',
  'being', 'between', 'could', 'data', 'document', 'documents', 'does', 'from',
  'have', 'into', 'more', 'other', 'record', 'records', 'text', 'user', 'users',
  'should', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'through',
  'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your', 'for',
  'in', 'not', 'can', 'will', 'use', 'using', 'ask', 'asks', 'mention', 'mentions',
  '一个', '一些', '以及', '他们', '但是', '你们', '关于', '其中', '可以', '因为',
  '对于', '就是', '已经', '我们', '或者', '没有', '这个', '这些', '进行', '通过',
]);

const buildLocalContentSummary = (
  output: ThetaDatasetExploreOutput,
  textColumn?: string,
): DatasetUnderstandingDraft['contentSummary'] => {
  if (!textColumn) {
    return {
      sampledDocumentCount: 0,
      sampleExcerpts: [],
      candidateTopics: [],
      method: 'local_lexical',
      caveat: '尚未识别正文列，因此无法从原始文本形成候选主题。',
    };
  }
  const sampleExcerpts = output.sampleRows.flatMap((row, sampleIndex) => {
    const value = String(row[textColumn] ?? '').replace(/\s+/gu, ' ').trim();
    if (!value) return [];
    return [{
      sampleIndex,
      column: textColumn,
      text: value.length > 280 ? `${value.slice(0, 277)}…` : value,
    }];
  }).slice(0, 10);
  const documents = sampleExcerpts.map((sample) => ({
    sampleIndex: sample.sampleIndex,
    tokens: contentTokens(sample.text),
  }));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(document.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const candidates = documents.flatMap((document) => {
    const termFrequency = new Map<string, number>();
    for (const token of document.tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }
    const keywords = [...termFrequency.entries()]
      .map(([token, count]) => ({
        token,
        score: count * (Math.log((documents.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 0.35) + Math.min(token.length, 16) * 0.01,
      }))
      .sort((left, right) => right.score - left.score || left.token.localeCompare(right.token))
      .slice(0, 4)
      .map((entry) => entry.token);
    if (keywords.length === 0) return [];
    return [{
      label: keywords.slice(0, 3).join(' / '),
      keywords,
      evidenceSampleIndexes: [document.sampleIndex],
      confidence: Math.min(0.68, 0.38 + keywords.length * 0.06),
      rationale: '由该脱敏原始样本中具有区分度的高权重词形成。',
    }];
  });
  const deduplicated = candidates.filter((candidate, index, all) =>
    all.findIndex((other) => topicSimilarity(candidate.keywords, other.keywords) >= 0.75) === index,
  ).slice(0, 5);
  return {
    sampledDocumentCount: sampleExcerpts.length,
    sampleExcerpts,
    candidateTopics: deduplicated,
    method: 'local_lexical',
    caveat: '候选主题仅基于受控脱敏样本，用于确认数据理解，不代表正式主题模型结果。',
  };
};

const contentTokens = (text: string): string[] => {
  const normalized = text.toLocaleLowerCase();
  const segments = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(normalized)]
      .filter((segment) => segment.isWordLike)
      .map((segment) => segment.segment)
    : normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]+/gu) ?? [];
  return segments
    .map((token) => token.replace(/^[_-]+|[_-]+$/gu, ''))
    .filter((token) => token.length >= 2 && !CONTENT_STOP_WORDS.has(token) && !/^\d+$/u.test(token))
    .slice(0, 120);
};

const topicSimilarity = (left: string[], right: string[]): number => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const overlap = [...leftSet].filter((value) => rightSet.has(value)).length;
  return overlap / Math.max(1, new Set([...leftSet, ...rightSet]).size);
};
