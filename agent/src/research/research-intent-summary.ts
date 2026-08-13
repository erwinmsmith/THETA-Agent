import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  DatasetConfirmation,
  ResearchIntent,
} from '@theta-agent/domain/dataset-understanding/contracts.js';

export const researchIntentSummarySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  researchQuestion: z.string().min(1),
  comparison: z.object({
    enabled: z.boolean(),
    dimensions: z.array(z.string()),
    purpose: z.enum(['unknown', 'display', 'model']),
  }),
  temporal: z.object({
    enabled: z.boolean(),
    columns: z.array(z.string()),
    purpose: z.enum(['unknown', 'display_trend', 'topic_evolution']),
  }),
  topicGranularity: z.enum(['coarse', 'medium', 'fine']),
  successCriteria: z.array(z.string()),
  deliverables: z.array(z.string()),
  constraints: z.array(z.string()),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
});

export type ResearchIntentSummary = z.infer<typeof researchIntentSummarySchema>;

export const buildResearchIntentSummary = (
  intent: ResearchIntent,
  confirmation: DatasetConfirmation,
  generatedAt: string,
): ResearchIntentSummary => researchIntentSummarySchema.parse({
  schemaVersion: '1.0.0',
  researchQuestion: intent.researchQuestion,
  comparison: {
    enabled: intent.comparisonDimensions.length > 0,
    dimensions: intent.comparisonDimensions,
    purpose: intent.comparisonPurpose,
  },
  temporal: {
    enabled: intent.temporalAnalysis,
    columns: confirmation.timeColumns,
    purpose: intent.temporalPurpose,
  },
  topicGranularity: intent.topicGranularity,
  successCriteria: intent.successCriteria,
  deliverables: intent.deliverables,
  constraints: intent.constraints,
  intentHash: researchIntentHash(intent),
  generatedAt,
});

export const researchIntentHash = (intent: ResearchIntent): string =>
  createHash('sha256').update(JSON.stringify(intent)).digest('hex');
