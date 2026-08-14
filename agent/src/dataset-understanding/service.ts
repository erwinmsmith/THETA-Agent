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
      ...contentSummary.sampleExcerpts.slice(0, 5).map((sample) => ({
        kind: 'sample_row' as const,
        sampleIndex: sample.sampleIndex,
        claim: '已读取该脱敏原始文本，用于形成数据内容的基本理解。',
      })),
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
      '内容摘要来自本地脱敏样本，只用于确认数据与项目理解，不是主题发现或训练结果。',
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
  'several',
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
      summary: '尚未识别正文列，因此还不能形成数据内容的基本理解。',
      contentKeywords: [],
      method: 'local_lexical',
      caveat: '这是对受控样本和项目输入的基本理解，不是主题发现或正式研究结论。',
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
  const tokenFrequency = new Map<string, number>();
  for (const sample of sampleExcerpts) {
    for (const token of contentTokens(sample.text)) {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    }
  }
  const contentKeywords = [...tokenFrequency.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([token]) => token);
  return {
    sampledDocumentCount: sampleExcerpts.length,
    sampleExcerpts,
    summary: contentKeywords.length > 0
      ? `这是一组以 ${textColumn} 为正文的独立文本记录。已实际读取 ${sampleExcerpts.length} 条脱敏样本，当前可观察到的内容线索包括 ${contentKeywords.slice(0, 8).join('、')}。`
      : `已实际读取 ${sampleExcerpts.length} 条脱敏正文样本，但可用于概括内容的信息仍然有限。`,
    contentKeywords,
    method: 'local_lexical',
    caveat: '这是对受控样本和项目输入的基本理解，不是主题发现或正式研究结论。',
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
