import { z } from 'zod';

export const datasetColumnFactSchema = z.object({
  name: z.string().min(1),
  inferredType: z.enum(['empty', 'number', 'datetime', 'text', 'string']),
  missingRatio: z.number().min(0).max(1),
  uniqueCount: z.number().int().nonnegative(),
  uniqueRatio: z.number().min(0).max(1).default(0),
  averageLength: z.number().nonnegative(),
  maximumLength: z.number().nonnegative().default(0),
  parseSuccessRatio: z.number().min(0).max(1).default(0),
  sampleValues: z.array(z.string()).max(5).default([]),
});

export const datasetFactsSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  datasetRef: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  fileName: z.string().min(1),
  format: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  encoding: z.string().default('unknown'),
  delimiter: z.string().nullable().default(null),
  sheets: z.array(z.string()).default([]),
  selectedSheet: z.string().nullable().default(null),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(datasetColumnFactSchema),
  languageDistribution: z.array(
    z.object({
      language: z.string().min(1),
      ratio: z.number().min(0).max(1),
    }),
  ),
  duplicateRatio: z.number().min(0).max(1),
  timeCoverage: z.object({
    start: z.string().nullable(),
    end: z.string().nullable(),
  }),
  samplePolicy: z.object({
    method: z.literal('deterministic_reservoir'),
    requestedRows: z.number().int().positive(),
    returnedRows: z.number().int().nonnegative(),
    profileRows: z.number().int().nonnegative(),
    profileTruncated: z.boolean(),
  }).default({
    method: 'deterministic_reservoir',
    requestedRows: 10,
    returnedRows: 0,
    profileRows: 0,
    profileTruncated: false,
  }),
  redactionApplied: z.boolean().default(false),
  sensitiveDataRisk: z.enum([
    'none_detected',
    'redacted',
    'requires_confirmation',
  ]).default('none_detected'),
  qualityWarnings: z.array(z.string()).default([]),
  generatedAt: z.string().datetime(),
});

export const datasetColumnRoleSchema = z.object({
  column: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const datasetEvidenceReferenceSchema = z.object({
  kind: z.enum(['column_profile', 'sample_row']),
  column: z.string().min(1).optional(),
  sampleIndex: z.number().int().nonnegative().optional(),
  claim: z.string().min(1),
});

const roleColumnsSchema = {
  textColumns: z.array(datasetColumnRoleSchema),
  timeColumns: z.array(datasetColumnRoleSchema),
  idColumns: z.array(datasetColumnRoleSchema),
  metadataColumns: z.array(datasetColumnRoleSchema),
  groupColumns: z.array(datasetColumnRoleSchema).default([]),
  covariateColumns: z.array(datasetColumnRoleSchema).default([]),
  evaluationColumns: z.array(datasetColumnRoleSchema).default([]),
  ignoredColumns: z.array(datasetColumnRoleSchema).default([]),
};

export const datasetUnderstandingDraftSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  datasetRef: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  domain: z.object({
    label: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().min(1)).max(8),
  }),
  analysisUnit: z.string().min(1),
  evidenceReferences: z.array(datasetEvidenceReferenceSchema).max(24).default([]),
  ...roleColumnsSchema,
  qualityWarnings: z.array(z.string()),
  assumptions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  provenance: z.object({
    source: z.preprocess(
      (value) => value === 'minimax' ? 'provider' : value,
      z.enum(['deterministic', 'provider', 'user', 'hybrid']),
    ),
    toolIds: z.array(z.string()),
    sampleSeed: z.string().min(1),
    generatedAt: z.string().datetime(),
  }),
});

const confirmedRoleColumnsSchema = {
  textColumns: z.array(z.string().min(1)).min(1),
  timeColumns: z.array(z.string().min(1)),
  idColumns: z.array(z.string().min(1)),
  metadataColumns: z.array(z.string().min(1)),
  groupColumns: z.array(z.string().min(1)).optional(),
  covariateColumns: z.array(z.string().min(1)).optional(),
  evaluationColumns: z.array(z.string().min(1)).optional(),
  ignoredColumns: z.array(z.string().min(1)).optional(),
};

export const datasetConfirmationDraftSchema = z.object({
  status: z.enum(['confirmed', 'corrected']),
  domainLabel: z.string().min(1),
  analysisUnit: z.string().min(1),
  ...confirmedRoleColumnsSchema,
});

export const datasetConfirmationSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  datasetRef: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['confirmed', 'corrected']),
  domainLabel: z.string().min(1),
  analysisUnit: z.string().min(1),
  ...confirmedRoleColumnsSchema,
  confirmedBy: z.string().min(1),
  confirmedAt: z.string().datetime(),
});

export const researchIntentSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  researchQuestion: z.string().min(1),
  comparisonDimensions: z.array(z.string().min(1)),
  comparisonPurpose: z.enum(['unknown', 'display', 'model']).default('unknown'),
  temporalAnalysis: z.boolean(),
  temporalPurpose: z.enum(['unknown', 'display_trend', 'topic_evolution']).default('unknown'),
  topicGranularity: z.enum(['coarse', 'medium', 'fine']),
  successCriteria: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  deliverables: z.array(z.string().min(1)).default([]),
  focusAreas: z.array(z.string().min(1)).default([]),
  resourceBudget: z.object({
    device: z.enum(['cpu', 'gpu', 'unknown']).default('unknown'),
    memoryGb: z.number().positive().optional(),
    maxExperiments: z.number().int().min(1).max(20).default(3),
  }).default({ device: 'unknown', maxExperiments: 3 }),
  unknowns: z.array(z.string().min(1)),
});

export type DatasetFacts = z.infer<typeof datasetFactsSchema>;
export type DatasetUnderstandingDraft = z.infer<
  typeof datasetUnderstandingDraftSchema
>;
export type DatasetConfirmationDraft = z.infer<
  typeof datasetConfirmationDraftSchema
>;
export type DatasetConfirmation = z.infer<typeof datasetConfirmationSchema>;
export type ResearchIntent = z.infer<typeof researchIntentSchema>;
