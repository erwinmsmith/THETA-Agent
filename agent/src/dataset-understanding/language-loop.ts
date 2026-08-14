import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import {
  datasetUnderstandingDraftSchema,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
} from '@theta-agent/domain/dataset-understanding/contracts.js';
import { buildDatasetFacts, buildDeterministicUnderstanding } from './service.js';
import { validateDatasetUnderstanding } from './validator.js';
import {
  datasetUnderstandingToolOutput,
  type DatasetUnderstandingLanguageRequest,
  type DatasetUnderstandingLanguageResult,
} from '@theta-agent/tools/dataset-understanding-language-tool.js';
import type { ThetaDatasetExploreOutput } from '@theta-agent/tools/dataset-explore-tool.js';

export const MAX_DATASET_EXPLORATION_CALLS = 1;

export interface DatasetUnderstandingLanguageLoopOptions {
  generate: (
    request: DatasetUnderstandingLanguageRequest,
  ) => Promise<DatasetUnderstandingLanguageResult>;
  explore: (input: { datasetRef: string; sheetName?: string }) => Promise<ThetaDatasetExploreOutput>;
  allowRemoteSamples?: boolean;
}

export interface DatasetUnderstandingLanguageLoopResult {
  facts: DatasetFacts;
  draft: DatasetUnderstandingDraft;
  source: 'provider' | 'deterministic';
  explorationCalls: number;
  sampleReceipt?: {
    payloadHash: string;
    rowCount: number;
    redactedValueCount: number;
    redactionRules: string[];
  };
  fallbackReason?:
    | 'provider_not_configured'
    | 'provider_error'
    | 'tool_error'
    | 'dataset_changed'
    | 'invalid_output'
    | 'tool_budget_exhausted'
    | 'illegal_tool_request'
    | 'consent_required';
}

export class DatasetUnderstandingLanguageLoop {
  constructor(private readonly options: DatasetUnderstandingLanguageLoopOptions) {}

  async understand(datasetRef: string): Promise<DatasetUnderstandingLanguageLoopResult> {
    const consent = this.options.allowRemoteSamples === true;
    let first: DatasetUnderstandingLanguageResult;
    try {
      first = await this.options.generate({
        schemaVersion: '2.0.0',
        datasetRef,
        allowRemoteSamples: consent,
        validationErrors: [],
      });
    } catch {
      return this.fallback(datasetRef, 'provider_error');
    }
    if (first.source !== 'provider' || first.decision.kind === 'fallback') {
      return this.fallback(datasetRef, first.fallbackReason ?? 'provider_not_configured');
    }
    if (first.decision.kind !== 'tool_call') {
      return this.fallback(datasetRef, 'illegal_tool_request');
    }
    if (!consent || first.decision.arguments.datasetRef !== datasetRef) {
      return this.fallback(datasetRef, consent ? 'illegal_tool_request' : 'consent_required');
    }
    let output: ThetaDatasetExploreOutput;
    try {
      output = await this.options.explore(first.decision.arguments);
    } catch {
      return this.fallback(datasetRef, 'tool_error');
    }
    const facts = buildDatasetFacts(output);
    const observation = {
      callId: first.decision.callId,
      output: datasetUnderstandingToolOutput(output),
    };
    const sampleReceipt = buildSampleReceipt(output);
    let validationErrors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const turn = await this.options.generate({
          schemaVersion: '2.0.0',
          datasetRef,
          facts,
          observation,
          allowRemoteSamples: true,
          validationErrors,
        });
        if (turn.source !== 'provider' || turn.decision.kind !== 'final') {
          return this.deterministic(
            facts,
            output,
            turn.fallbackReason ?? 'invalid_output',
            1,
            sampleReceipt,
          );
        }
        const normalized = normalizeLanguageUnderstanding(
          turn.decision.understanding,
          facts,
          output,
        );
        const draft = datasetUnderstandingDraftSchema.parse({
          ...normalized,
          schemaVersion: '2.0.0',
          datasetRef: facts.datasetRef,
          datasetHash: facts.datasetHash,
          provenance: {
            source: 'provider',
            toolIds: ['theta.dataset.understanding.language', 'theta.dataset.explore'],
            sampleSeed: output.sampleSeed,
            generatedAt: new Date().toISOString(),
          },
        });
        const receipt = validateDatasetUnderstanding(draft, facts);
        if (receipt.valid) {
          return {
            facts,
            draft,
            source: 'provider',
            explorationCalls: 1,
            sampleReceipt,
          };
        }
        validationErrors = receipt.errors;
      } catch (error) {
        validationErrors = error instanceof ZodError
          ? error.issues.map((issue) => issue.message)
          : [error instanceof Error ? error.message : String(error)];
      }
    }
    return this.deterministic(facts, output, 'invalid_output', 1, sampleReceipt);
  }

  private async fallback(
    datasetRef: string,
    reason: NonNullable<DatasetUnderstandingLanguageLoopResult['fallbackReason']>,
  ): Promise<DatasetUnderstandingLanguageLoopResult> {
    try {
      const output = await this.options.explore({ datasetRef });
      return this.deterministic(buildDatasetFacts(output), output, reason, 1);
    } catch {
      throw new Error(`Dataset exploration failed after ${reason}.`);
    }
  }

  private deterministic(
    facts: DatasetFacts,
    output: ThetaDatasetExploreOutput,
    fallbackReason: NonNullable<DatasetUnderstandingLanguageLoopResult['fallbackReason']>,
    explorationCalls: number,
    sampleReceipt?: DatasetUnderstandingLanguageLoopResult['sampleReceipt'],
  ): DatasetUnderstandingLanguageLoopResult {
    return {
      facts,
      draft: buildDeterministicUnderstanding(facts, output),
      source: 'deterministic',
      explorationCalls,
      fallbackReason,
      ...(sampleReceipt ? { sampleReceipt } : {}),
    };
  }
}

const buildSampleReceipt = (
  output: ThetaDatasetExploreOutput,
): NonNullable<DatasetUnderstandingLanguageLoopResult['sampleReceipt']> => {
  const toolPayload = datasetUnderstandingToolOutput(output);
  return {
    payloadHash: createHash('sha256').update(JSON.stringify(toolPayload)).digest('hex'),
    rowCount: output.sampleRows.length,
    redactedValueCount: output.redactionSummary.redactedValueCount,
    redactionRules: output.redactionSummary.rules,
  };
};

const normalizeLanguageUnderstanding = (
  value: Record<string, unknown>,
  facts: DatasetFacts,
  output: ThetaDatasetExploreOutput,
): Record<string, unknown> => {
  const fallback = buildDeterministicUnderstanding(facts, output);
  const available = new Set(facts.columns.map((column) => column.name));
  const rawDomain = record(value.domain);
  const domainLabel = firstText(rawDomain.label, value.domain, fallback.domain.label);
  const role = (field: keyof Pick<DatasetUnderstandingDraft,
    'textColumns' | 'timeColumns' | 'idColumns' | 'metadataColumns' |
    'groupColumns' | 'covariateColumns' | 'evaluationColumns' | 'ignoredColumns'>) => {
    const normalized = normalizeRoleEntries(value[field], available, String(field));
    return normalized.length > 0 || field !== 'textColumns'
      ? normalized
      : fallback[field];
  };
  const evidenceReferences = Array.isArray(value.evidenceReferences)
    ? value.evidenceReferences.flatMap((entry) => {
        const item = record(entry);
        const kind = item.kind === 'sample_row' ? 'sample_row' : 'column_profile';
        const column = typeof item.column === 'string' && available.has(item.column)
          ? item.column
          : undefined;
        const sampleIndex = Number.isInteger(item.sampleIndex) && Number(item.sampleIndex) >= 0 &&
          Number(item.sampleIndex) < output.sampleRows.length
          ? Number(item.sampleIndex)
          : undefined;
        const claim = firstText(item.claim);
        if (!claim || (kind === 'column_profile' && !column) || (kind === 'sample_row' && sampleIndex === undefined)) {
          return [];
        }
        return [{ kind, ...(column ? { column } : {}), ...(sampleIndex !== undefined ? { sampleIndex } : {}), claim }];
      }).slice(0, 24)
    : fallback.evidenceReferences;
  const rawContentSummary = record(value.contentSummary);
  const providerSummary = firstText(rawContentSummary.summary);
  const providerKeywords = stringArray(rawContentSummary.contentKeywords).slice(0, 16);
  return {
    domain: {
      label: domainLabel,
      confidence: boundedConfidence(rawDomain.confidence, fallback.domain.confidence),
      evidence: stringArray(rawDomain.evidence).slice(0, 8),
    },
    analysisUnit: firstText(value.analysisUnit, fallback.analysisUnit),
    contentSummary: {
      ...fallback.contentSummary,
      summary: providerSummary || fallback.contentSummary.summary,
      contentKeywords: providerKeywords.length > 0
        ? providerKeywords
        : fallback.contentSummary.contentKeywords,
      method: providerSummary ? 'hybrid' : fallback.contentSummary.method,
      caveat: firstText(rawContentSummary.caveat, fallback.contentSummary.caveat),
    },
    evidenceReferences,
    textColumns: role('textColumns'),
    timeColumns: role('timeColumns'),
    idColumns: role('idColumns'),
    metadataColumns: role('metadataColumns'),
    groupColumns: role('groupColumns'),
    covariateColumns: role('covariateColumns'),
    evaluationColumns: role('evaluationColumns'),
    ignoredColumns: role('ignoredColumns'),
    qualityWarnings: stringArray(value.qualityWarnings),
    assumptions: stringArray(value.assumptions),
    confidence: boundedConfidence(value.confidence, fallback.confidence),
  };
};

const normalizeRoleEntries = (
  value: unknown,
  available: Set<string>,
  field: string,
): DatasetUnderstandingDraft['textColumns'] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const item = record(entry);
    const column = firstText(
      typeof entry === 'string' ? entry : undefined,
      item.column,
      item.name,
    );
    if (!column || !available.has(column) || seen.has(column)) return [];
    seen.add(column);
    return [{
      column,
      confidence: boundedConfidence(item.confidence ?? item.score, 0.7),
      reason: firstText(item.reason, `The language model classified ${column} as ${field}.`),
    }];
  });
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const firstText = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const stringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()];
      const entry = record(item);
      const text = firstText(entry.label, entry.name, entry.description, entry.reason, entry.claim);
      return text ? [text] : [];
    })
  : [];

const boundedConfidence = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
