import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { callThetaBridge } from './bridge.js';
import {
  thetaDatasetColumnCandidateSchema,
  thetaDatasetFileInputSchema,
  type ThetaDatasetColumnCandidate,
  type ThetaDatasetFileInput,
} from './dataset-inspect-tool.js';
import { resolveDatasetFile } from './dataset-path-policy.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaDatasetDetectColumnsOutput {
  filePath: string;
  rowCount: number;
  columns: string[];
  textColumns: ThetaDatasetColumnCandidate[];
  timeColumns: ThetaDatasetColumnCandidate[];
  metadataColumns: ThetaDatasetColumnCandidate[];
  recommendedTextColumn: string | null;
  warnings: string[];
}

const thetaDatasetDetectColumnsOutputSchema: JsonSchema = {
  type: 'object',
  required: [
    'filePath',
    'rowCount',
    'columns',
    'textColumns',
    'timeColumns',
    'metadataColumns',
    'recommendedTextColumn',
    'warnings',
  ],
  properties: {
    filePath: { type: 'string' },
    rowCount: { type: 'integer', minimum: 0 },
    columns: { type: 'array', items: { type: 'string' } },
    textColumns: { type: 'array', items: thetaDatasetColumnCandidateSchema },
    timeColumns: { type: 'array', items: thetaDatasetColumnCandidateSchema },
    metadataColumns: { type: 'array', items: thetaDatasetColumnCandidateSchema },
    recommendedTextColumn: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const thetaDatasetDetectColumnsToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetDetectColumns,
  version: '1.0.0',
  displayName: 'Detect Dataset Columns',
  description: 'Detect text, time, and metadata column candidates for an allowed local dataset.',
  tags: ['theta', 'dataset'],
  inputSchema: thetaDatasetFileInputSchema,
  outputSchema: thetaDatasetDetectColumnsOutputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead],
  timeoutPolicy: {
    timeoutMs: 30000,
    onTimeout: 'fail',
  },
  retryPolicy: {
    maxAttempts: 1,
  },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: false,
  },
  source: 'local',
};

const normalizeDatasetInput = (input: unknown): ThetaDatasetFileInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('Dataset input must be an object.');
  }
  return input as ThetaDatasetFileInput;
};

const ensureDatasetDetectColumnsOutput = (data: unknown): ThetaDatasetDetectColumnsOutput => {
  if (!data || typeof data !== 'object') {
    throw new Error('dataset.detect_columns bridge returned a non-object payload.');
  }
  return data as ThetaDatasetDetectColumnsOutput;
};

export const thetaDatasetDetectColumnsHandler: ToolHandler<
  unknown,
  ThetaDatasetDetectColumnsOutput
> = async (input: unknown, context: ToolCallContext) => {
  const normalized = normalizeDatasetInput(input);
  const resolved = await resolveDatasetFile(normalized.filePath);
  const response = await callThetaBridge(
    'dataset.detect_columns',
    {
      filePath: resolved.filePath,
      ...(normalized.sampleSize === undefined ? {} : { sampleSize: normalized.sampleSize }),
    },
    {
      runId: context.runId,
      stepId: context.stepId,
    }
  );

  if (response.status !== 'ok') {
    throw new Error(response.error?.message ?? 'dataset.detect_columns bridge command failed.');
  }

  return ensureDatasetDetectColumnsOutput(response.data);
};
