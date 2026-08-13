import { z } from 'zod';

export const thetaWebRunActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({
    action: z.literal('message'),
    text: z.string().trim().min(1).max(4000),
    useMiniMax: z.boolean().default(true),
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
  z.object({ action: z.literal('poll') }).strict(),
  z.object({ action: z.literal('retry') }).strict(),
]);

export const thetaWebCreateRunSchema = z.object({
  datasetRef: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional(),
  researchGoal: z.string().trim().min(4).max(2000).optional(),
  useMiniMax: z.boolean().default(true),
  allowRemoteSamples: z.boolean().default(false),
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

export type ThetaWebRunAction = z.infer<typeof thetaWebRunActionSchema>;
export type ThetaWebCreateRun = z.infer<typeof thetaWebCreateRunSchema>;
export type ThetaResultAnalysisRequest = z.infer<typeof thetaResultAnalysisRequestSchema>;

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
