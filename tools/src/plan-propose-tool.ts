import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { evidenceBundleSchema, type EvidenceBundle } from './support/rag/evidence-bundle.js';
import { NativePlannerV2Service } from './support/planner/native-service.js';
import {
  plannerDecisionV2Schema,
  plannerInputV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
} from '@theta-agent/domain/planner/v2-contracts.js';
import { createMiniMaxProviderFromEnv } from './support/providers/minimax.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaPlanProposeInput {
  plannerInput: PlannerInputV2;
  evidenceBundle: EvidenceBundle;
}
export type ThetaPlanProposeOutput = PlannerDecisionV2;

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['plannerInput', 'evidenceBundle'],
  properties: {
    plannerInput: { type: 'object', additionalProperties: true },
    evidenceBundle: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: [
    'schemaVersion', 'inputHash', 'modelId', 'baselineModelId', 'rationale',
    'parameters', 'evidenceRefs', 'experiment', 'preprocessing', 'evaluation',
    'visualizations', 'warnings', 'assumptions',
  ],
  properties: {
    schemaVersion: { const: '2.0.0' },
    inputHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    modelId: { type: 'string' },
    baselineModelId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    rationale: { type: 'string' },
    parameters: { type: 'object', additionalProperties: true },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
    evidenceSelectionReceipts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    experiment: { type: 'object', additionalProperties: true },
    preprocessing: { type: 'array', items: { type: 'string' } },
    evaluation: { type: 'array', items: { type: 'string' } },
    visualizations: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const thetaPlanProposeToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planPropose,
  version: '2.0.0',
  displayName: 'Create Native Planner V2 Decision',
  description: 'Let MiniMax create a complete plan directly from confirmed data, research intent, candidates, and RAG evidence.',
  tags: ['theta', 'plan', 'planner-v2', 'minimax'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'read',
  permissionScope: [
    THETA_PERMISSION_SCOPES.planRead,
    THETA_PERMISSION_SCOPES.ragRead,
    THETA_PERMISSION_SCOPES.inferenceUse,
  ],
  timeoutPolicy: { timeoutMs: 180_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: true },
  source: 'local',
};

export const thetaPlanProposeHandler: ToolHandler<unknown, ThetaPlanProposeOutput> = async (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plan.propose input must be an object.');
  }
  const value = input as Record<string, unknown>;
  const plannerInput = plannerInputV2Schema.parse(value.plannerInput);
  const evidenceBundle = evidenceBundleSchema.parse(value.evidenceBundle);
  const provider = createMiniMaxProviderFromEnv({ timeoutMs: plannerTimeoutMs() });
  if (!provider) throw new Error('MiniMax is required by the native Planner V2.');
  return plannerDecisionV2Schema.parse(
    await new NativePlannerV2Service(provider).propose(plannerInput, evidenceBundle),
  );
};

const plannerTimeoutMs = (): number => {
  const configured = Number(process.env.MINIMAX_PLANNER_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 180_000
    ? configured
    : 150_000;
};
