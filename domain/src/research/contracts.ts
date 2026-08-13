import { z } from 'zod';

export const RESEARCH_CONTRACT_VERSION = '1.0.0';

const optionalText = z.string().trim().min(1).optional();

export const researchBriefSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_CONTRACT_VERSION),
    researchQuestion: optionalText,
    researchDomain: optionalText,
    domainConfirmed: z.boolean().optional(),
    dataSources: z.array(z.string().trim().min(1)).default([]),
    collectionMethod: optionalText,
    analysisUnit: optionalText,
    timeRange: z
      .object({
        start: optionalText,
        end: optionalText,
      })
      .strict()
      .optional(),
    language: optionalText,
    comparisonGroups: z.array(z.string().trim().min(1)).default([]),
    comparisonIntent: z.enum(['unknown', 'none', 'groups']).optional(),
    topicGranularity: z.enum(['broad', 'medium', 'fine']).optional(),
    knownBiases: z.array(z.string().trim().min(1)).default([]),
    sensitiveData: z
      .object({
        status: z.enum(['yes', 'no', 'unknown']),
        categories: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .default({ status: 'unknown', categories: [] }),
    successCriteria: z.array(z.string().trim().min(1)).default([]),
    hardwareLimit: z
      .object({
        device: z.enum(['cpu', 'gpu', 'unknown']),
        memoryGb: z.number().positive().optional(),
      })
      .strict()
      .default({ device: 'unknown' }),
    textFieldIntent: optionalText,
    trendAnalysis: z.boolean().default(false),
    offlineOnly: z.boolean().default(true),
    requestedEmbedding: z
      .enum(['local', 'remote', 'none', 'unknown'])
      .default('unknown'),
    timeLimitHours: z.number().positive().optional(),
    expectedRowCount: z.number().int().nonnegative().optional(),
    candidateTimeColumns: z.array(z.string().trim().min(1)).default([]),
    candidateGroupColumns: z.array(z.string().trim().min(1)).default([]),
    interviewComplete: z.boolean().optional(),
    unknownFields: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const researchBriefPatchSchema = researchBriefSchema
  .omit({ schemaVersion: true, unknownFields: true })
  .partial()
  .strict();

export const informationGapSchema = z
  .object({
    id: z.string().min(1),
    field: z.string().min(1),
    severity: z.enum(['blocking', 'optional']),
    question: z.string().min(1),
    reason: z.string().min(1),
    informationGain: z.number().min(0).max(100),
  })
  .strict();

export const researchConflictSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(['blocking', 'warning']),
    fields: z.array(z.string().min(1)).min(1),
    message: z.string().min(1),
    resolution: z.string().min(1),
  })
  .strict();

export const plannedQuestionSchema = z
  .object({
    gapId: z.string().min(1),
    field: z.string().min(1),
    question: z.string().min(1),
    severity: z.enum(['blocking', 'optional']),
    score: z.number(),
  })
  .strict();

const columnCandidateSchema = z
  .object({
    name: z.string().min(1),
    score: z.number().min(0).max(1),
    reason: z.string(),
  })
  .strict();

export const datasetProfileSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_CONTRACT_VERSION),
    datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileName: z.string().min(1),
    fileSizeBytes: z.number().int().nonnegative(),
    format: z.string().min(1),
    encoding: z.string().min(1),
    rowCount: z.number().int().nonnegative(),
    sampledRowCount: z.number().int().nonnegative().default(0),
    profileScope: z.enum(['full', 'sample']).default('sample'),
    estimationWarnings: z.array(z.string().min(1)).default([]),
    columnCount: z.number().int().nonnegative(),
    columns: z.array(z.string()),
    columnProfiles: z
      .array(
        z
          .object({
            name: z.string().min(1),
            inferredType: z.enum(['empty', 'number', 'datetime', 'text', 'string']),
            nonEmptySampleCount: z.number().int().nonnegative(),
            uniqueSampleCount: z.number().int().nonnegative(),
            avgLength: z.number().nonnegative(),
            maxLength: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
    missingRatio: z.number().min(0).max(1),
    duplicateRatio: z.number().min(0).max(1).nullable(),
    textLengthDistribution: z
      .object({
        average: z.number().nonnegative(),
        maximum: z.number().int().nonnegative(),
      })
      .strict(),
    languageDistribution: z
      .array(
        z
          .object({
            language: z.string().min(1),
            ratio: z.number().min(0).max(1),
          })
          .strict(),
      )
      .default([]),
    timeCoverage: z
      .object({
        start: z.string().nullable(),
        end: z.string().nullable(),
      })
      .strict(),
    columnCandidates: z
      .object({
        text: z.array(columnCandidateSchema),
        time: z.array(columnCandidateSchema),
        metadata: z.array(columnCandidateSchema),
      })
      .strict(),
    sensitiveRiskCodes: z.array(z.string().min(1)),
    inferredDomain: z
      .object({
        label: z.string().trim().min(1),
        confidence: z.number().min(0).max(1),
        evidence: z.array(z.string().trim().min(1)).max(8).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const columnConfirmationDraftSchema = z
  .object({
    textColumns: z.array(z.string().min(1)).min(1),
    timeColumn: z.string().min(1).nullable().default(null),
    idColumn: z.string().min(1).nullable().default(null),
    // covariateColumns are the only columns passed into models such as STM.
    // metadataColumns are descriptive only; grouping columns are post-hoc
    // presentation fields; evaluation labels are held out from training.
    covariateColumns: z.array(z.string().min(1)).optional(),
    metadataColumns: z.array(z.string().min(1)).default([]),
    groupingColumns: z.array(z.string().min(1)).optional(),
    evaluationLabelColumns: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const columnConfirmationSchema = columnConfirmationDraftSchema
  .extend({
    schemaVersion: z.literal(RESEARCH_CONTRACT_VERSION),
    datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedBy: z.string().min(1),
    confirmedAt: z.string().datetime(),
  })
  .strict();

export type ResearchBrief = z.infer<typeof researchBriefSchema>;
export type ResearchBriefPatch = z.infer<typeof researchBriefPatchSchema>;
export type InformationGap = z.infer<typeof informationGapSchema>;
export type ResearchConflict = z.infer<typeof researchConflictSchema>;
export type PlannedQuestion = z.infer<typeof plannedQuestionSchema>;
export type DatasetProfile = z.infer<typeof datasetProfileSchema>;
export type ColumnConfirmationDraft = z.infer<
  typeof columnConfirmationDraftSchema
>;
export type ColumnConfirmation = z.infer<typeof columnConfirmationSchema>;
