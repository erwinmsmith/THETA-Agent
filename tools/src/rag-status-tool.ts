import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import {
  getKnowledgeIndexStatus,
  type KnowledgeIndexStatus,
} from './support/rag/service.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export type ThetaRagStatusOutput = KnowledgeIndexStatus;

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
    'totalObjects',
    'objectTypes',
  ],
  properties: {
    schemaVersion: { const: '1.1.0' },
    status: { enum: ['ready', 'not_built'] },
    database: { type: 'string' },
    manifest: { type: 'string' },
    totalSources: { type: 'integer', minimum: 0 },
    totalChunks: { type: 'integer', minimum: 0 },
    totalObjects: { type: 'integer', minimum: 0 },
    objectTypes: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
  },
  additionalProperties: false,
};

export const thetaRagStatusToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.ragStatus,
  version: '1.0.0',
  displayName: 'Get THETA Evidence Index Status',
  description:
    'Read local evidence-index readiness and counts through Hypha governance.',
  tags: ['theta', 'rag', 'evidence'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.ragRead],
  timeoutPolicy: { timeoutMs: 5000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: true,
    includeOutput: true,
  },
  source: 'local',
};

export const thetaRagStatusHandler: ToolHandler<
  unknown,
  ThetaRagStatusOutput
> = async () => getKnowledgeIndexStatus();
