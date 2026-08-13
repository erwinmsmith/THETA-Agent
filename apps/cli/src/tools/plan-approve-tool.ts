import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { callThetaTools } from './theta-tools.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaPlanApproveInput {
  planId: string;
  planHash: string;
  approvedBy: string;
  approvalNote?: string;
}

export interface ThetaPlanApproveOutput {
  approvalId: string;
  planId: string;
  planHash: string;
  approvedBy: string;
  approvedAt: string;
  stateDb: string;
}

const planApproveInputSchema: JsonSchema = {
  type: 'object',
  required: ['planId', 'planHash', 'approvedBy'],
  properties: {
    planId: { type: 'string', minLength: 1 },
    planHash: { type: 'string', minLength: 1 },
    approvedBy: { type: 'string', minLength: 1 },
    approvalNote: { type: 'string' },
  },
  additionalProperties: false,
};

const planApproveOutputSchema: JsonSchema = {
  type: 'object',
  required: ['approvalId', 'planId', 'planHash', 'approvedBy', 'approvedAt', 'stateDb'],
  properties: {
    approvalId: { type: 'string' },
    planId: { type: 'string' },
    planHash: { type: 'string' },
    approvedBy: { type: 'string' },
    approvedAt: { type: 'string' },
    stateDb: { type: 'string' },
  },
  additionalProperties: false,
};

export const thetaPlanApproveToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planApprove,
  version: '1.0.0',
  displayName: 'Approve Training Plan',
  description:
    'Approve a validated THETA training plan after Hypha permission, idempotency, and human-review checks.',
  tags: ['theta', 'plan'],
  inputSchema: planApproveInputSchema,
  outputSchema: planApproveOutputSchema,
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.planApprove],
  humanApprovalPolicy: {
    required: true,
    reason: 'Approving a THETA plan permits downstream training and must be explicitly confirmed.',
  },
  idempotencyPolicy: {
    mode: 'required',
  },
  timeoutPolicy: {
    timeoutMs: 30000,
    onTimeout: 'fail',
  },
  retryPolicy: {
    maxAttempts: 1,
  },
  auditPolicy: {
    enabled: true,
    includeInput: true,
    includeOutput: true,
  },
  source: 'local',
};

const normalizePlanApproveInput = (input: unknown): ThetaPlanApproveInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('plan.approve input must be an object.');
  }
  return input as ThetaPlanApproveInput;
};

const ensurePlanApproveOutput = (data: unknown): ThetaPlanApproveOutput => {
  if (!data || typeof data !== 'object') {
    throw new Error('plan.approve THETA tools returned a non-object payload.');
  }
  return data as ThetaPlanApproveOutput;
};

export const thetaPlanApproveHandler: ToolHandler<unknown, ThetaPlanApproveOutput> = async (
  input: unknown,
  context: ToolCallContext
) => {
  const response = await callThetaTools('plan.approve', normalizePlanApproveInput(input), {
    runId: context.runId,
    stepId: context.stepId,
  });

  if (response.status !== 'ok') {
    throw new Error(response.error?.message ?? 'plan.approve THETA tools command failed.');
  }

  return ensurePlanApproveOutput(response.data);
};
