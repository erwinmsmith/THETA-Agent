import { z } from 'zod';
import { languageRequestSchema } from '@theta-agent/domain/language/contracts.js';

export const agentInvocationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('doctor'),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('workflow'),
      action: z.enum(['start', 'resume']),
      args: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('status'),
      runId: z.string().min(1),
      runtimeDb: z.string().min(1).optional(),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('audit'),
      runId: z.string().min(1),
      runtimeDb: z.string().min(1).optional(),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['planShow', 'planApprove', 'evidenceShow']),
      runId: z.string().min(1),
      runtimeDb: z.string().min(1).optional(),
      approvedBy: z.string().min(1).optional(),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('trainingStatus'),
      trainingRunId: z.string().min(1),
      logLimit: z.number().int().positive().max(500).optional(),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('trainingCancel'),
      trainingRunId: z.string().min(1),
      reason: z.string().min(1),
      approve: z.boolean(),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['ragBuild', 'ragStatus']),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('languageGenerate'),
      request: languageRequestSchema,
      approve: z.boolean(),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('conversationTurn'),
      action: z.enum(['answer', 'columns']),
      text: z.string().trim().min(1).max(4000),
      runId: z.string().min(1),
      runtimeDb: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      json: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('repl'),
      runId: z.string().min(1).optional(),
      runtimeDb: z.string().min(1).optional(),
    })
    .strict(),
]);

export type AgentInvocation = z.infer<typeof agentInvocationSchema>;

const runReference = {
  runId: z.string().min(1).optional(),
} as const;

export const conversationCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('help'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('start'),
      filePath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('status'),
      ...runReference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('why'),
      ...runReference,
      section: z.enum(['all', 'model', 'parameters', 'protocol', 'evidence']).default('all'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      ...runReference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('plan'),
      ...runReference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('approve'),
      ...runReference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('approvePlan'),
      ...runReference,
      acceptDegradation: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('startTraining'),
      ...runReference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('save'),
      ...runReference,
    })
    .strict(),
  z
    .object({
      kind: z.enum(['answer', 'columns', 'natural']),
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('llm'),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['history', 'brief']),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['next', 'done', 'follow', 'logs', 'results', 'openResults', 'summary', 'runs', 'retry', 'reevaluate']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('details'),
      section: z.string().trim().min(1).max(120).optional(),
      page: z.number().int().positive().default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('adjust'),
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cancel'),
      text: z.string().trim().min(1).max(1000),
      confirm: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('back'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('exit'),
    })
    .strict(),
]);

export type ConversationCommand = z.infer<typeof conversationCommandSchema>;
