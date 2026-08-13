import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import {
  naturalLanguageRequestSchema,
  naturalLanguageResultSchema,
  type NaturalLanguageRequest,
  type NaturalLanguageResult,
} from '@theta-agent/domain/conversation/natural-contracts.js';
import { ThetaNaturalLanguageService } from './support/language/natural-service.js';
import { createInferenceProviderFromEnv } from './support/providers/registry.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export type ThetaConversationLanguageInput = NaturalLanguageRequest;
export type ThetaConversationLanguageOutput = NaturalLanguageResult;

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'task'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    task: {
      enum: [
        'interpret_research_answer',
        'generate_grilling_question',
        'interpret_column_confirmation',
        'classify_conversation_intent',
        'propose_readonly_tool',
        'compose_grounded_response',
      ],
    },
    gapId: { type: 'string' },
    field: { type: 'string' },
    question: { type: 'string' },
    answer: { type: 'string' },
    currentBrief: { type: 'object', additionalProperties: true },
    nextGapCandidates: { type: 'array', items: { type: 'object' } },
    recentMessages: { type: 'array', items: { type: 'object' } },
    reason: { type: 'string' },
    draftQuestion: { type: 'string' },
    attempt: { type: 'integer', minimum: 1, maximum: 8 },
    datasetSha256: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    candidates: { type: 'object', additionalProperties: true },
    text: { type: 'string' },
    currentState: { type: 'string' },
    pendingActionRef: { type: 'string' },
    allowedToolIds: { type: 'array', items: { type: 'string' } },
    userText: { type: 'string' },
    toolId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    facts: { type: 'object', additionalProperties: true },
    evidence: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'source', 'factsHash', 'telemetry', 'output'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    source: { enum: ['provider', 'deterministic'] },
    fallbackReason: { type: 'string' },
    factsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    telemetry: { type: 'object', additionalProperties: true },
    output: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const thetaConversationLanguageToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.conversationLanguage,
  version: '1.0.0',
  displayName: 'Interpret Governed Conversation Turn',
  description:
    'Interpret research answers, word follow-up questions, confirm columns, classify intents, or propose one read-only tool from an explicit allowlist.',
  tags: ['theta', 'conversation', 'language', 'inference'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'external_effect',
  permissionScope: [THETA_PERMISSION_SCOPES.inferenceUse],
  humanApprovalPolicy: {
    required: true,
    reason:
      'A session consent is required before sanitized conversation context is sent to the selected provider.',
  },
  idempotencyPolicy: { mode: 'required' },
  timeoutPolicy: { timeoutMs: 75_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: true,
  },
  source: 'local',
};

export const thetaConversationLanguageHandler: ToolHandler<
  unknown,
  ThetaConversationLanguageOutput
> = async (input) => {
  const request = naturalLanguageRequestSchema.parse(input);
  const provider = createInferenceProviderFromEnv();
  return naturalLanguageResultSchema.parse(
    await new ThetaNaturalLanguageService({
      provider,
      modelAlias: provider?.model,
    }).generate(request),
  );
};
