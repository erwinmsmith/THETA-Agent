import { z } from 'zod';

export const thetaWebRunActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({
    action: z.literal('message'),
    text: z.string().trim().min(1).max(4000),
    useLanguageProvider: z.boolean().optional(),
    /** @deprecated Use useLanguageProvider. */
    useMiniMax: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal('columns'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({
    action: z.literal('confirmDataset'),
    status: z.enum(['confirmed', 'corrected']),
    domainLabel: z.string().trim().min(1).max(200),
    analysisUnit: z.string().trim().min(1).max(500),
    textColumns: z.array(z.string().trim().min(1)).min(1).max(12),
    timeColumns: z.array(z.string().trim().min(1)).max(12).default([]),
    idColumns: z.array(z.string().trim().min(1)).max(12).default([]),
    metadataColumns: z.array(z.string().trim().min(1)).max(24).default([]),
    groupColumns: z.array(z.string().trim().min(1)).max(24).default([]),
    covariateColumns: z.array(z.string().trim().min(1)).max(24).default([]),
    evaluationColumns: z.array(z.string().trim().min(1)).max(24).default([]),
    ignoredColumns: z.array(z.string().trim().min(1)).max(24).default([]),
  }).strict(),
  z.object({
    action: z.literal('decisionAnswer'),
    text: z.string().trim().min(1).max(4000),
  }).strict(),
  z.object({ action: z.literal('confirmIntent') }).strict(),
  z.object({
    action: z.literal('correctDataset'),
    text: z.string().trim().min(1).max(4000),
  }).strict(),
  z.object({ action: z.literal('finishInterview') }).strict(),
  z.object({ action: z.literal('adjustPlan'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal('approvePlan'), acceptDegradation: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('startTraining') }).strict(),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().min(1).max(1000),
  }).strict(),
  z.object({ action: z.literal('poll') }).strict(),
  z.object({ action: z.literal('retry') }).strict(),
]);

export const thetaWebCreateRunSchema = z.object({
  datasetRef: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional(),
  researchGoal: z.string().trim().min(4).max(2000).optional(),
  useLanguageProvider: z.boolean().optional(),
  /** @deprecated Use useLanguageProvider. */
  useMiniMax: z.boolean().optional(),
  allowRemoteSamples: z.boolean().default(false),
  sourceSessionId: z.string().trim().min(8).max(200).optional(),
}).strict().refine(
  (input) => Boolean(input.datasetRef || input.filePath),
  { message: 'datasetRef 或 filePath 至少提供一项。' },
);

const thetaResultAnalysisSelectionSchema = z.object({
  topicIds: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  metricKeys: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  visualizationIds: z.array(z.string().trim().min(1).max(160)).max(12).default([]),
  includeGoalAssessment: z.boolean().default(false),
  includeWarnings: z.boolean().default(false),
}).strict();

export const thetaResultAnalysisRequestSchema = z.object({
  question: z.string().trim().min(2).max(2000),
  selection: thetaResultAnalysisSelectionSchema,
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(3000),
  }).strict()).max(8).default([]),
}).strict();

export const thetaWebPostMessageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  useLanguageProvider: z.boolean().optional(),
  /** @deprecated Use useLanguageProvider. */
  useMiniMax: z.boolean().optional(),
  attachments: z.array(z.object({
    kind: z.enum(['visualization', 'topic', 'metric', 'table']),
    id: z.string().trim().min(1).max(240),
    label: z.string().trim().min(1).max(240),
  }).strict()).max(12).default([]),
}).strict();

export const thetaWebRenameRunSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
}).strict();

export const thetaWebInferenceSelectionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('use'), providerId: z.string().trim().min(1), model: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('reset') }).strict(),
]);

const thetaWebLlmSettingsSchema = z.object({
  providerId: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  baseUrl: z.string().trim().url().max(500).optional(),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  clearApiKey: z.boolean().optional(),
  reasoningMode: z.enum(['auto', 'chat', 'reasoning']).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  reasoningBudgetTokens: z.number().int().min(256).max(131_072).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(131_072).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  streaming: z.boolean().optional(),
  typewriter: z.boolean().optional(),
  typewriterSpeedMs: z.number().int().min(0).max(100).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
}).strict();

const thetaWebEmbeddingSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  providerId: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().max(200).optional(),
  baseUrl: z.string().trim().url().max(500).optional(),
  dimensions: z.number().int().min(1).max(65_536).nullable().optional(),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  clearApiKey: z.boolean().optional(),
}).strict();

export const thetaWebInferenceSettingsSchema = z.object({
  llm: thetaWebLlmSettingsSchema.optional(),
  embedding: thetaWebEmbeddingSettingsSchema.optional(),
}).strict().refine(
  (input) => input.llm !== undefined || input.embedding !== undefined,
  { message: 'At least one inference settings section is required.' },
);

export type ThetaWebRunAction = z.infer<typeof thetaWebRunActionSchema>;
export type ThetaWebCreateRun = z.infer<typeof thetaWebCreateRunSchema>;
export type ThetaResultAnalysisRequest = z.infer<typeof thetaResultAnalysisRequestSchema>;
export type ThetaWebPostMessage = z.infer<typeof thetaWebPostMessageSchema>;
export type ThetaWebInferenceSelection = z.infer<typeof thetaWebInferenceSelectionSchema>;
export type ThetaWebInferenceSettings = z.infer<typeof thetaWebInferenceSettingsSchema>;
export type ThetaWebRenameRun = z.infer<typeof thetaWebRenameRunSchema>;

export const thetaWebApiEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type ThetaWebApiEnvelope = z.infer<typeof thetaWebApiEnvelopeSchema>;

export interface ThetaWebApiHealth {
  service: 'theta-agent-api';
  version: 'v2';
  status: 'ready' | 'degraded' | 'blocked';
  checkedAt: string;
  checks: Array<{
    id: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
    remediation?: string;
  }>;
}

export interface ThetaWebAgentInteraction {
  source: 'fsm';
  state: string;
  status: string;
  reasoning: {
    goal: string;
    observation: string;
    decision: string;
    nextStates: string[];
    allowedTools: string[];
    policyRefs: string[];
  };
  card?: {
    kind:
      | 'dataset_upload'
      | 'research_question'
      | 'dataset_review'
      | 'column_review'
      | 'research_intent_review'
      | 'plan_review'
      | 'training_review';
    title: string;
    description: string;
    actionRef: string;
    requiresHumanAction: true;
  };
}

export interface ThetaWebRuntimeProfile {
  service: 'theta-agent-runtime';
  version: 'v2';
  compute: {
    backend: 'local';
    defaultDevice: 'cpu' | 'gpu';
    scheduler: { supported: false; enabled: false };
  };
  capabilities: {
    domains: number;
    tools: number;
    skills: number;
  };
  entryInteraction: ThetaWebAgentInteraction;
}

export interface ThetaWebRunSummary {
  runId: string;
  updatedAt: string;
  eventCount: number;
  status: string;
  currentState?: string;
  pendingReason?: string;
  lastEventType?: string;
  lastEventAt?: string;
  recoveryOfRunId?: string;
  successorRunId?: string;
  presentation?: {
    title: string;
    summary: string;
    progress?: { current: number; total: number; label: string; percent?: number };
    nextActions: Array<{
      id: string;
      label: string;
      description: string;
      recommended?: boolean;
      destructive?: boolean;
    }>;
  };
}

export interface ThetaWebTimelineEntry {
  id: string;
  source: 'workflow' | 'tool';
  type: string;
  title: string;
  detail?: string;
  timestamp: string;
}

export interface ThetaWebConversationMessage {
  messageId: string;
  role: 'user' | 'assistant';
  messageKind: string;
  content: string;
  sequenceNumber: number;
  createdAt: string;
}

export interface ThetaWebRunEvent {
  id: string;
  source: 'orchestration' | 'tool';
  type: string;
  title: string;
  detail?: string;
  timestamp: string;
  /** Sanitized and size-capped event payload (tool inputs/outputs, decisions). */
  payload?: unknown;
}

export interface ThetaWebReasoningDecisionGap {
  question: string;
  answers: Array<{ content: string; createdAt: string }>;
  resolved: boolean;
}

export interface ThetaWebReasoningToolCall {
  eventId: string;
  invocationId?: string;
  toolId: string;
  phase: 'requested' | 'started' | 'policy' | 'completed' | 'failed' | 'validated';
  label: string;
  timestamp: string;
  payload: unknown;
}

export interface ThetaWebReasoning {
  runId: string;
  researchIntent?: Record<string, unknown>;
  intentSummary?: Record<string, unknown>;
  currentDecisionGap?: string;
  decisionGaps: ThetaWebReasoningDecisionGap[];
  recommendation?: Record<string, unknown>;
  plan?: {
    state: string;
    presentation?: {
      title: string;
      summary: string;
      progress?: { current: number; total: number; label: string; percent?: number };
      nextActions: Array<{
        id: string;
        label: string;
        description: string;
        recommended?: boolean;
        destructive?: boolean;
      }>;
    };
  };
  toolCalls: ThetaWebReasoningToolCall[];
  reasoningEvents: ThetaWebRunEvent[];
}

export interface ThetaWebStreamEvent {
  kind: 'snapshot' | 'status' | 'events' | 'messages' | 'training' | 'heartbeat';
  sequence: number;
  data: unknown;
}
