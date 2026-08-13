import type { JsonSchema } from '@hypha/core';
import type { InferenceToolDescriptor } from '@hypha/inference';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { SQLiteDatasetRegistry } from './support/storage/dataset-registry.js';
import { callThetaTools } from './theta-tools.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaDatasetExploreInput {
  datasetRef: string;
  sheetName?: string;
}

export interface ExploreColumnProfile {
  name: string;
  inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
  missingRatio: number;
  uniqueCount: number;
  uniqueRatio?: number;
  averageLength: number;
  maximumLength: number;
  parseSuccessRatio?: number;
  sampleValues?: string[];
}

export interface ExploreColumnCandidate {
  name: string;
  score: number;
  reason: string;
}

export interface ThetaDatasetExploreOutput {
  datasetRef: string;
  datasetHash: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  encoding?: string;
  delimiter?: string | null;
  sheets?: string[];
  selectedSheet?: string | null;
  rowCount: number;
  columns: string[];
  columnProfiles: ExploreColumnProfile[];
  sampleRows: Array<Record<string, unknown>>;
  sampleSeed: string;
  samplePolicy?: {
    method: 'deterministic_reservoir';
    requestedRows: number;
    returnedRows: number;
    profileRows: number;
    profileTruncated: boolean;
  };
  sampleTruncated: boolean;
  outputTruncated?: boolean;
  redactionSummary: {
    applied: boolean;
    redactedValueCount: number;
    rules: string[];
  };
  candidateRoles: {
    text: ExploreColumnCandidate[];
    time: ExploreColumnCandidate[];
    id: ExploreColumnCandidate[];
    group?: ExploreColumnCandidate[];
    covariate?: ExploreColumnCandidate[];
    evaluation?: ExploreColumnCandidate[];
    metadata: ExploreColumnCandidate[];
    ignored?: ExploreColumnCandidate[];
  };
  languageDistribution: Array<{ language: string; ratio: number }>;
  duplicateRatio: number;
  timeCoverage: { start: string | null; end: string | null };
  inferredDomain: {
    label: string;
    confidence: number;
    evidence: string[];
  };
  qualityWarnings: string[];
}

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['datasetRef'],
  properties: {
    datasetRef: { type: 'string', minLength: 1 },
    sheetName: { type: 'string', minLength: 1, maxLength: 256 },
  },
  additionalProperties: false,
};

export const thetaDatasetExploreInferenceTool: InferenceToolDescriptor = {
  id: THETA_TOOL_IDS.datasetExplore,
  name: 'theta_dataset_explore',
  description:
    'Read one registered dataset and return its schema, profiles, and at most ten deterministic random rows after local redaction.',
  inputSchema: inputSchema as Record<string, unknown>,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: [
    'datasetRef',
    'datasetHash',
    'fileName',
    'format',
    'sizeBytes',
    'encoding',
    'delimiter',
    'sheets',
    'selectedSheet',
    'rowCount',
    'columns',
    'columnProfiles',
    'sampleRows',
    'sampleSeed',
    'samplePolicy',
    'sampleTruncated',
    'outputTruncated',
    'redactionSummary',
    'candidateRoles',
    'languageDistribution',
    'duplicateRatio',
    'timeCoverage',
    'inferredDomain',
    'qualityWarnings',
  ],
  properties: {
    datasetRef: { type: 'string' },
    datasetHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    fileName: { type: 'string' },
    format: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    encoding: { type: 'string' },
    delimiter: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    sheets: { type: 'array', items: { type: 'string' } },
    selectedSheet: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    rowCount: { type: 'integer', minimum: 0 },
    columns: { type: 'array', items: { type: 'string' } },
    columnProfiles: { type: 'array', items: { type: 'object', additionalProperties: true } },
    sampleRows: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: true } },
    sampleSeed: { type: 'string' },
    samplePolicy: { type: 'object', additionalProperties: true },
    sampleTruncated: { type: 'boolean' },
    outputTruncated: { type: 'boolean' },
    redactionSummary: { type: 'object', additionalProperties: true },
    candidateRoles: { type: 'object', additionalProperties: true },
    languageDistribution: { type: 'array', items: { type: 'object', additionalProperties: true } },
    duplicateRatio: { type: 'number', minimum: 0, maximum: 1 },
    timeCoverage: { type: 'object', additionalProperties: true },
    inferredDomain: { type: 'object', additionalProperties: true },
    qualityWarnings: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const thetaDatasetExploreToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetExplore,
  version: '2.0.0',
  displayName: 'Explore Dataset',
  description:
    'Return deterministic, bounded and locally redacted dataset facts for an opaque dataset reference.',
  tags: ['theta', 'dataset', 'understanding'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead],
  timeoutPolicy: { timeoutMs: 45_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: false },
  source: 'local',
};

export const thetaDatasetExploreHandler: ToolHandler<
  unknown,
  ThetaDatasetExploreOutput
> = async (rawInput, context: ToolCallContext) => {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new Error('Dataset explore input must be an object.');
  }
  const input = rawInput as ThetaDatasetExploreInput;
  const userId = context.userId ?? context.principal?.userId ?? 'local_user';
  const workspaceId =
    context.workspaceId ?? context.principal?.workspaceId ?? 'local_workspace';
  const runtimeDb = context.metadata?.thetaRuntimeDb;
  const registry = new SQLiteDatasetRegistry(
    typeof runtimeDb === 'string' && runtimeDb.trim()
      ? runtimeDb
      : undefined,
  );
  try {
    const record = registry.require(input.datasetRef, { userId, workspaceId });
    const response = await callThetaTools(
      'dataset.explore',
      {
        filePath: record.managedPath,
        datasetRef: record.datasetRef,
        datasetHash: record.sha256,
        fileName: record.displayName,
        sizeBytes: record.sizeBytes,
        sheetName: input.sheetName,
      },
      { runId: context.runId, stepId: context.stepId },
    );
    if (response.status !== 'ok') {
      throw new Error(response.error?.message ?? 'dataset.explore THETA tools command failed.');
    }
    return response.data as ThetaDatasetExploreOutput;
  } finally {
    registry.close();
  }
};
