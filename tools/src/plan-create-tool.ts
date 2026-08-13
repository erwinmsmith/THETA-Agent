import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import {
  createTrainingPlanRecordV2,
  type CreateTrainingPlanRecordV2Input,
} from './support/planning/engine.js';
import type { TrainingPlanRecord } from '@theta-agent/domain/planning/contracts.js';
import { validateTrainingPlanV2 } from './support/planning/validator-v2.js';
import type { CapabilityCatalogModel } from '@theta-agent/domain/capabilities/contracts.js';
import { datasetFactsSchema, researchIntentSchema } from '@theta-agent/domain/dataset-understanding/contracts.js';
import { callThetaTools } from './theta-tools.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaPlanCreateInput extends Omit<CreateTrainingPlanRecordV2Input, 'createdAt'> {
  createdAt?: string;
}
export type ThetaPlanCreateOutput = TrainingPlanRecord;

const planCreateInputSchema: JsonSchema = {
  type: 'object',
  required: [
    'validatedPlan', 'facts', 'confirmation', 'intent', 'plannerInput',
    'plannerDecision', 'evidenceBundle', 'validation', 'domainPack',
  ],
  properties: {
    validatedPlan: { type: 'object', additionalProperties: true },
    facts: { type: 'object', additionalProperties: true },
    confirmation: { type: 'object', additionalProperties: true },
    intent: { type: 'object', additionalProperties: true },
    plannerInput: { type: 'object', additionalProperties: true },
    plannerDecision: { type: 'object', additionalProperties: true },
    evidenceBundle: { type: 'object', additionalProperties: true },
    validation: { type: 'object', additionalProperties: true },
    domainPack: {
      type: 'object',
      required: ['id', 'version'],
      properties: { id: { type: 'string' }, version: { type: 'string' } },
      additionalProperties: false,
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

const planCreateOutputSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'planId', 'planHash', 'planVersion', 'status', 'canonicalPlan', 'review', 'createdAt'],
  properties: {
    schemaVersion: { const: '2.0.0' },
    planId: { type: 'string' },
    planHash: { type: 'string' },
    planVersion: { type: 'integer', minimum: 1 },
    status: { enum: ['draft', 'superseded'] },
    canonicalPlan: { type: 'object', additionalProperties: true },
    review: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string' },
  },
  additionalProperties: false,
};

export const thetaPlanCreateToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planCreate,
  version: '3.0.0',
  displayName: 'Create Native Planner V2 Training Plan',
  description: 'Create the canonical plan from DatasetFacts, ResearchIntent and a validated provider Planner V2 decision.',
  tags: ['theta', 'plan', 'planner-v2'],
  inputSchema: planCreateInputSchema,
  outputSchema: planCreateOutputSchema,
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.planWrite],
  humanApprovalPolicy: {
    required: true,
    reason: 'Creating the canonical plan requires the recorded HumanPlanReview decision.',
  },
  idempotencyPolicy: { mode: 'required' },
  timeoutPolicy: { timeoutMs: 30_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: true },
  source: 'local',
};

export const thetaPlanCreateHandler: ToolHandler<unknown, ThetaPlanCreateOutput> = async (
  input,
  context: ToolCallContext,
) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plan.create input must be an object.');
  }
  const value = input as ThetaPlanCreateInput;
  const facts = datasetFactsSchema.parse(value.facts);
  const intent = researchIntentSchema.parse(value.intent);
  const response = await callThetaTools('model.catalog', {}, {
    runId: context.runId,
    stepId: `${context.stepId}.validator-v2.catalog`,
  });
  if (response.status !== 'ok' || !response.data || typeof response.data !== 'object') {
    throw new Error(response.error?.message ?? 'model.catalog THETA tools command failed.');
  }
  const models = Array.isArray((response.data as Record<string, unknown>).models)
    ? (response.data as Record<string, unknown>).models as CapabilityCatalogModel[]
    : [];
  const validated = validateTrainingPlanV2({
    plan: value.validatedPlan,
    models,
    dataProfile: {
      rowCount: facts.rowCount,
      columns: facts.columns.map((column) => column.name),
      columnProfiles: facts.columns,
      languageDistribution: facts.languageDistribution,
      qualityWarnings: facts.qualityWarnings,
    },
    offlineOnly: !intent.constraints.some((item) => /允许联网|network allowed/iu.test(item)),
    device: intent.resourceBudget.device,
  });
  if (!validated.valid) {
    throw new Error(`Validator V2 rejected plan.create: ${validated.errors.join('; ')}`);
  }
  return createTrainingPlanRecordV2({
    ...value,
    validatedPlan: validated.normalizedPlan,
    createdAt: value.createdAt ?? new Date().toISOString(),
  });
};
