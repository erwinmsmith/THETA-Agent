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
  const analysisUnit = textColumns[0]
    ? `每一行是一条独立记录，主要分析 ${textColumns[0].column} 列中的文本。`
    : '每一行是一条独立记录；当前没有足够证据确定正文列。';
  return datasetUnderstandingDraftSchema.parse({
    schemaVersion: '2.0.0',
    datasetRef: facts.datasetRef,
    datasetHash: facts.datasetHash,
    domain: output.inferredDomain,
    analysisUnit,
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
