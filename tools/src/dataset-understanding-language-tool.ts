import { createHash } from 'node:crypto';
import type { JsonSchema } from '@hypha/core';
import type { PromptMessage } from '@hypha/inference';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { z } from 'zod';
import {
  datasetFactsSchema,
  type DatasetFacts,
} from '@theta-agent/domain/dataset-understanding/contracts.js';
import { createInferenceProviderFromEnv } from './support/providers/registry.js';
import {
  thetaDatasetExploreInferenceTool,
  type ThetaDatasetExploreOutput,
} from './dataset-explore-tool.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const observationSchema = z.object({
  callId: z.string().min(1),
  output: z.record(z.string(), z.unknown()),
});

const requestSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  datasetRef: z.string().min(1),
  facts: datasetFactsSchema.optional(),
  observation: observationSchema.optional(),
  allowRemoteSamples: z.boolean(),
  validationErrors: z.array(z.string()).max(20).default([]),
});

const decisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool_call'),
    callId: z.string().min(1),
    toolId: z.literal(THETA_TOOL_IDS.datasetExplore),
    arguments: z.object({
      datasetRef: z.string().min(1),
      sheetName: z.string().min(1).max(256).optional(),
    }).strict(),
  }),
  z.object({
    kind: z.literal('final'),
    understanding: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('fallback') }),
]);

export type DatasetUnderstandingLanguageRequest = z.infer<typeof requestSchema>;
export type DatasetUnderstandingLanguageDecision = z.infer<typeof decisionSchema>;

export interface DatasetUnderstandingLanguageResult {
  schemaVersion: '2.0.0';
  source: 'provider' | 'deterministic';
  contextHash: string;
  decision: DatasetUnderstandingLanguageDecision;
  fallbackReason?:
    | 'provider_not_configured'
    | 'provider_error'
    | 'invalid_output'
    | 'consent_required';
  telemetry: Record<string, unknown>;
}

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'datasetRef', 'allowRemoteSamples', 'validationErrors'],
  properties: {
    schemaVersion: { const: '2.0.0' },
    datasetRef: { type: 'string', minLength: 1 },
    facts: { type: 'object', additionalProperties: true },
    observation: { type: 'object', additionalProperties: true },
    allowRemoteSamples: { type: 'boolean' },
    validationErrors: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'source', 'contextHash', 'decision', 'telemetry'],
  properties: {
    schemaVersion: { const: '2.0.0' },
    source: { enum: ['provider', 'deterministic'] },
    contextHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    decision: { type: 'object', additionalProperties: true },
    fallbackReason: { type: 'string' },
    telemetry: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const thetaDatasetUnderstandingLanguageToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetUnderstandingLanguage,
  version: '2.0.0',
  displayName: 'Understand Dataset Through Tool Calling',
  description:
    'Let the selected provider call the governed dataset explorer and form a validated dataset understanding.',
  tags: ['theta', 'dataset', 'understanding', 'language', 'inference'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'external_effect',
  permissionScope: [
    THETA_PERMISSION_SCOPES.datasetRead,
    THETA_PERMISSION_SCOPES.inferenceUse,
  ],
  humanApprovalPolicy: {
    required: true,
    reason: 'Sending at most ten locally redacted rows to an external provider requires consent.',
  },
  idempotencyPolicy: { mode: 'required' },
  timeoutPolicy: { timeoutMs: 180_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: false },
  source: 'local',
};

export const thetaDatasetUnderstandingLanguageHandler: ToolHandler<
  unknown,
  DatasetUnderstandingLanguageResult
> = async (input) => {
  const request = requestSchema.parse(input);
  const contextHash = hashContext(request.datasetRef, request.facts);
  if (!request.allowRemoteSamples) {
    return fallback(contextHash, 'consent_required');
  }
  const provider = createInferenceProviderFromEnv({
    timeoutMs: boundedTimeout(
      process.env.THETA_LLM_UNDERSTANDING_TIMEOUT_MS ??
        process.env.MINIMAX_UNDERSTANDING_TIMEOUT_MS,
      120_000,
    ),
  });
  if (!provider) return fallback(contextHash, 'provider_not_configured');
  try {
    const hasObservation = request.observation !== undefined;
    const response = await provider.infer({
      runId: `theta-understanding-${contextHash.slice(0, 16)}`,
      stepId: hasObservation ? 'understanding-final' : 'understanding-tool-call',
      modelAlias: provider.model,
      input: { messages: promptMessages(request) },
      ...(hasObservation ? {} : { tools: [thetaDatasetExploreInferenceTool] }),
      options: {
        temperature: hasObservation ? 0.1 : 0,
        maxTokens: 1400,
        extra: {
          toolChoice: hasObservation ? 'none' : 'auto',
          ...(hasObservation ? { jsonObject: true } : {}),
        },
      },
      trace: false,
      metadata: {
        purpose: 'dataset_understanding',
        datasetRef: request.datasetRef,
        remoteSamplesAllowed: true,
        sampleLimit: 10,
      },
    });
    const decision = hasObservation
      ? decisionSchema.parse(response.output)
      : parseToolCall(response.output, request.datasetRef);
    if (hasObservation && decision.kind !== 'final') {
      throw new Error('The selected provider must return a final understanding after the tool result.');
    }
    return {
      schemaVersion: '2.0.0',
      source: 'provider',
      contextHash,
      decision,
      telemetry: {
        provider: provider.id,
        model: provider.model,
        remoteSamplesAllowed: true,
        toolResultSupplied: hasObservation,
      },
    };
  } catch (error) {
    return fallback(
      contextHash,
      error instanceof z.ZodError ? 'invalid_output' : 'provider_error',
    );
  }
};

const promptMessages = (
  request: DatasetUnderstandingLanguageRequest,
): PromptMessage[] => {
  const messages: PromptMessage[] = [
    {
      role: 'system',
      content: [
        'You are the THETA dataset-understanding agent.',
        'Before making any dataset claim, call theta_dataset_explore exactly as provided.',
        'Use only its returned columns, profiles, and redacted sampleRows.',
        'Never invent columns or evidence and never request paths, shell, network, writes, planning, approval, or training.',
        'After receiving the tool result, return exactly one JSON object and no prose:',
        '{"kind":"final","understanding":{domain,analysisUnit,evidenceReferences,textColumns,timeColumns,idColumns,metadataColumns,groupColumns,covariateColumns,evaluationColumns,ignoredColumns,qualityWarnings,assumptions,confidence}}.',
        'domain must be {"label":string,"confidence":0..1,"evidence":string[]}. Every column-role item must be {"column":an exact supplied column name,"confidence":0..1,"reason":string}.',
        'Sample evidence uses zero-based sampleIndex into sampleRows.',
        request.validationErrors.length > 0
          ? `Repair these validation errors: ${request.validationErrors.join(' | ')}`
          : '',
      ].filter(Boolean).join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        datasetRef: request.datasetRef,
        ...(request.facts ? { facts: safeFacts(request.facts) } : {}),
      }),
    },
  ];
  if (request.observation) {
    messages.push(
      {
        role: 'assistant',
        content: '',
        metadata: {
          toolCalls: [{
            id: request.observation.callId,
            name: thetaDatasetExploreInferenceTool.name,
            arguments: { datasetRef: request.datasetRef },
          }],
        },
      },
      {
        role: 'tool',
        name: thetaDatasetExploreInferenceTool.name,
        content: JSON.stringify(request.observation.output),
        metadata: { toolCallId: request.observation.callId },
      },
    );
  }
  return messages;
};

const parseToolCall = (
  value: unknown,
  datasetRef: string,
): DatasetUnderstandingLanguageDecision => {
  const root = record(value);
  if (root.kind !== 'tool_calls' || !Array.isArray(root.toolCalls)) {
    throw new Error('The selected provider did not call theta.dataset.explore.');
  }
  const raw = record(root.toolCalls[0]);
  if (raw.name !== thetaDatasetExploreInferenceTool.name) {
    throw new Error('The selected provider requested a tool outside the dataset-understanding allowlist.');
  }
  const args = record(raw.arguments);
  if (args.datasetRef !== datasetRef) {
    throw new Error('The selected provider requested a different dataset reference.');
  }
  return decisionSchema.parse({
    kind: 'tool_call',
    callId: String(raw.id ?? 'dataset-explore-call'),
    toolId: THETA_TOOL_IDS.datasetExplore,
    arguments: args,
  });
};

const safeFacts = (facts: DatasetFacts): DatasetFacts => ({
  ...facts,
  fileName: 'registered-dataset',
  columns: facts.columns.map((column) => ({ ...column, sampleValues: [] })),
});

const fallback = (
  contextHash: string,
  fallbackReason: NonNullable<DatasetUnderstandingLanguageResult['fallbackReason']>,
): DatasetUnderstandingLanguageResult => ({
  schemaVersion: '2.0.0',
  source: 'deterministic',
  contextHash,
  decision: { kind: 'fallback' },
  fallbackReason,
  telemetry: { remoteProviderCalled: !['provider_not_configured', 'consent_required'].includes(fallbackReason) },
});

const hashContext = (datasetRef: string, facts?: DatasetFacts): string =>
  createHash('sha256').update(JSON.stringify(facts ?? { datasetRef })).digest('hex');

const boundedTimeout = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 180_000 ? parsed : fallback;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const datasetUnderstandingToolOutput = (
  output: ThetaDatasetExploreOutput,
): Record<string, unknown> => ({
  datasetRef: output.datasetRef,
  datasetHash: output.datasetHash,
  format: output.format,
  rowCount: output.rowCount,
  columns: output.columns,
  columnProfiles: output.columnProfiles.slice(0, 80).map((profile) => ({
    ...profile,
    sampleValues: [],
  })),
  sampleRows: output.sampleRows.slice(0, 10),
  candidateRoles: output.candidateRoles,
  languageDistribution: output.languageDistribution,
  timeCoverage: output.timeCoverage,
  inferredDomain: output.inferredDomain,
  qualityWarnings: output.qualityWarnings.slice(0, 20),
  redactionSummary: output.redactionSummary,
  samplePolicy: output.samplePolicy,
});
