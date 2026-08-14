import type { JsonSchema } from '@codesoul-co/hypha-core';
import type { ToolHandler, ToolSpec } from '@codesoul-co/hypha-tools';
import { evidenceBundleSchema, type EvidenceBundle } from './support/rag/evidence-bundle.js';
import { NativePlannerV2Service } from './support/planner/native-service.js';
import { buildDeterministicPlannerDecisionV2 } from './support/planner/deterministic-v2.js';
import {
  plannerDecisionV2Schema,
  plannerInputV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
} from '@theta-agent/domain/planner/v2-contracts.js';
import { createInferenceProviderFromEnv } from './support/providers/registry.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaPlanProposeInput {
  plannerInput: PlannerInputV2;
  evidenceBundle: EvidenceBundle;
  /** false selects the offline deterministic planner. */
  enabled?: boolean;
}
export type ThetaPlanProposeOutput = PlannerDecisionV2;

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['plannerInput', 'evidenceBundle'],
  properties: {
    plannerInput: { type: 'object', additionalProperties: true },
    evidenceBundle: { type: 'object', additionalProperties: true },
    enabled: { type: 'boolean' },
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
  description: 'Let the selected inference provider create a complete plan from confirmed data, research intent, candidates, and RAG evidence.',
  tags: ['theta', 'plan', 'planner-v2', 'inference'],
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
  if (value.enabled === false) {
    return buildDeterministicPlannerDecisionV2(plannerInput, evidenceBundle);
  }
  // Reasoning-style models may leave `content` empty on long planning
  // prompts; THETA_LLM_PLANNER_MODEL pins the planner to a chat-style model.
  const plannerModel = process.env.THETA_LLM_PLANNER_MODEL?.trim();
  const provider = createInferenceProviderFromEnv({
    timeoutMs: plannerTimeoutMs(),
    ...(plannerModel ? { model: plannerModel } : {}),
  });
  if (!provider) {
    throw new Error('A configured inference provider is required by Planner V2.');
  }
  return plannerDecisionV2Schema.parse(
    await new NativePlannerV2Service(provider).propose(plannerInput, evidenceBundle),
  );
};

const plannerTimeoutMs = (): number => {
  const configured = Number(
    process.env.THETA_LLM_PLANNER_TIMEOUT_MS ??
      process.env.MINIMAX_PLANNER_TIMEOUT_MS,
  );
  return Number.isInteger(configured) && configured >= 1 && configured <= 180_000
    ? configured
    : 150_000;
};
