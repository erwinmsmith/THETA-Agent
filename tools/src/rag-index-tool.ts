import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import {
  buildKnowledgeIndex,
  type KnowledgeIndexBuildResult,
} from './support/rag/service.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export type ThetaRagIndexOutput = KnowledgeIndexBuildResult;

const inputSchema: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'status',
    'database',
    'manifest',
    'totalSources',
    'totalChunks',
    'indexedSources',
    'unchangedSources',
    'indexedChunks',
    'indexedObjects',
    'totalObjects',
    'objectTypes',
  ],
  properties: {
    schemaVersion: { const: '1.1.0' },
    status: { const: 'ready' },
    database: { type: 'string' },
    manifest: { type: 'string' },
    totalSources: { type: 'integer', minimum: 0 },
    totalChunks: { type: 'integer', minimum: 0 },
    indexedSources: { type: 'integer', minimum: 0 },
    unchangedSources: { type: 'integer', minimum: 0 },
    indexedChunks: { type: 'integer', minimum: 0 },
    indexedObjects: { type: 'integer', minimum: 0 },
    totalObjects: { type: 'integer', minimum: 0 },
    objectTypes: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
  },
  additionalProperties: false,
};

export const thetaRagIndexToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.ragIndex,
  version: '1.0.0',
  displayName: 'Build THETA Evidence Index',
  description:
    'Build the allowlisted local FTS5 evidence index through Hypha governance.',
  tags: ['theta', 'rag', 'evidence'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.ragWrite],
  timeoutPolicy: { timeoutMs: 30000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: true,
    includeOutput: true,
  },
  source: 'local',
};

export const thetaRagIndexHandler: ToolHandler<
  unknown,
  ThetaRagIndexOutput
> = async () => buildKnowledgeIndex();
