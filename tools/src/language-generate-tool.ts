import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import {
  languageRequestSchema,
  languageResultSchema,
  type LanguageRequest,
  type LanguageResult,
} from '@theta-agent/domain/language/contracts.js';
import { ThetaLanguageService } from './support/language/service.js';
import { createMiniMaxProviderFromEnv } from './support/providers/minimax.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export type ThetaLanguageGenerateInput = LanguageRequest;
export type ThetaLanguageGenerateOutput = LanguageResult;

const requestSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'task'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    task: {
      enum: [
        'classify_intent',
        'word_question',
        'explain_recommendation',
      ],
    },
    sourceText: { type: 'string', minLength: 1, maxLength: 1200 },
    field: { type: 'string', minLength: 1, maxLength: 120 },
    reason: { type: 'string', minLength: 1, maxLength: 1200 },
    draftQuestion: { type: 'string', minLength: 1, maxLength: 1200 },
    recommendation: { type: 'object', additionalProperties: true },
    researchBrief: { type: 'object', additionalProperties: true },
    datasetProfile: { type: 'object', additionalProperties: true },
    evidence: {
      type: 'array',
      maxItems: 5,
      items: { type: 'object', additionalProperties: true },
    },
  },
  additionalProperties: false,
};

const resultSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'task', 'source', 'text', 'factsHash'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    task: {
      enum: [
        'classify_intent',
        'word_question',
        'explain_recommendation',
      ],
    },
    source: { enum: ['minimax', 'deterministic'] },
    text: { type: 'string', minLength: 1, maxLength: 1200 },
    intent: {
      enum: [
        'read_status',
        'explain_reason',
        'read_evidence',
        'request_help',
        'unknown',
      ],
    },
    fallbackReason: { type: 'string' },
    factsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  additionalProperties: false,
};

export const thetaLanguageGenerateToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.languageGenerate,
  version: '1.0.0',
  displayName: 'Generate Bounded Language',
  description:
    'Use an optional language provider only for bounded intent, question wording, or deterministic recommendation explanation.',
  tags: ['theta', 'language', 'inference'],
  inputSchema: requestSchema,
  outputSchema: resultSchema,
  sideEffectLevel: 'external_effect',
  permissionScope: [THETA_PERMISSION_SCOPES.inferenceUse],
  humanApprovalPolicy: {
    required: true,
    reason:
      'Sending sanitized context to an external language provider requires explicit confirmation.',
  },
  idempotencyPolicy: {
    mode: 'required',
  },
  timeoutPolicy: {
    timeoutMs: 30_000,
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

export const thetaLanguageGenerateHandler: ToolHandler<
  unknown,
  ThetaLanguageGenerateOutput
> = async (input) => {
  const request = languageRequestSchema.parse(input);
  const provider = createMiniMaxProviderFromEnv();
  return languageResultSchema.parse(
    await new ThetaLanguageService({
      provider,
      modelAlias:
        provider && 'model' in provider ? String(provider.model) : undefined,
    }).generate(request),
  );
};
