import { z } from 'zod';

export const LANGUAGE_CONTRACT_VERSION = '1.0.0';

export const safeIntentSchema = z.enum([
  'read_status',
  'explain_reason',
  'read_evidence',
  'request_help',
  'unknown',
]);

const boundedText = z.string().trim().min(1).max(1200);
const codeList = z.array(z.string().trim().min(1).max(120)).max(20);

export const safeResearchBriefSchema = z
  .object({
    researchQuestion: boundedText.optional(),
    language: z.string().trim().min(1).max(40).optional(),
    topicGranularity: z.enum(['broad', 'medium', 'fine']).optional(),
    trendAnalysis: z.boolean(),
    offlineOnly: z.boolean(),
    requestedEmbedding: z.enum(['local', 'remote', 'none', 'unknown']),
    expectedRowCount: z.number().int().nonnegative().optional(),
    hardware: z
      .object({
        device: z.enum(['cpu', 'gpu', 'unknown']),
        memoryGb: z.number().positive().optional(),
      })
      .strict(),
  })
  .strict();

export const safeDatasetProfileSchema = z
  .object({
    format: z.string().trim().min(1).max(40),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    missingRatio: z.number().min(0).max(1),
    duplicateRatio: z.number().min(0).max(1).nullable(),
    averageTextLength: z.number().nonnegative(),
    maximumTextLength: z.number().int().nonnegative(),
    languageDistribution: z
      .array(
        z
          .object({
            language: z.string().trim().min(1).max(40),
            ratio: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const safeEvidenceExcerptSchema = z
  .object({
    evidenceId: z.string().trim().min(1).max(160),
    authority: z.enum(['L1', 'L2', 'L3', 'L4']),
    excerpt: boundedText,
  })
  .strict();

const classifyIntentRequestSchema = z
  .object({
    schemaVersion: z.literal(LANGUAGE_CONTRACT_VERSION),
    task: z.literal('classify_intent'),
    sourceText: boundedText,
  })
  .strict();

const wordQuestionRequestSchema = z
  .object({
    schemaVersion: z.literal(LANGUAGE_CONTRACT_VERSION),
    task: z.literal('word_question'),
    field: z.string().trim().min(1).max(120),
    reason: boundedText,
    draftQuestion: boundedText,
  })
  .strict();

const explainRecommendationRequestSchema = z
  .object({
    schemaVersion: z.literal(LANGUAGE_CONTRACT_VERSION),
    task: z.literal('explain_recommendation'),
    recommendation: z
      .object({
        modelId: z.string().trim().min(1).max(120),
        score: z.number().int().min(0).max(100),
        confidence: z.enum(['low', 'medium', 'high']),
        reasonCodes: codeList.min(1),
        warnings: codeList,
      })
      .strict(),
    researchBrief: safeResearchBriefSchema.optional(),
    datasetProfile: safeDatasetProfileSchema.optional(),
    evidence: z.array(safeEvidenceExcerptSchema).max(5),
  })
  .strict();

export const languageRequestSchema = z.discriminatedUnion('task', [
  classifyIntentRequestSchema,
  wordQuestionRequestSchema,
  explainRecommendationRequestSchema,
]);

export const languageProviderOutputSchema = z.discriminatedUnion('task', [
  z
    .object({
      task: z.literal('classify_intent'),
      intent: safeIntentSchema,
      text: boundedText,
    })
    .strict(),
  z
    .object({
      task: z.literal('word_question'),
      text: boundedText,
    })
    .strict(),
  z
    .object({
      task: z.literal('explain_recommendation'),
      text: boundedText,
    })
    .strict(),
]);

export const languageFallbackReasonSchema = z.enum([
  'provider_not_configured',
  'network_failure',
  'timeout',
  'provider_error',
  'non_json_response',
  'schema_validation_failed',
  'illegal_intent',
  'output_rejected',
]);

export const languageResultSchema = z
  .object({
    schemaVersion: z.literal(LANGUAGE_CONTRACT_VERSION),
    task: z.enum([
      'classify_intent',
      'word_question',
      'explain_recommendation',
    ]),
    source: z.enum(['minimax', 'deterministic']),
    text: boundedText,
    intent: safeIntentSchema.optional(),
    fallbackReason: languageFallbackReasonSchema.optional(),
    factsHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type SafeIntent = z.infer<typeof safeIntentSchema>;
export type SafeResearchBrief = z.infer<typeof safeResearchBriefSchema>;
export type SafeDatasetProfile = z.infer<typeof safeDatasetProfileSchema>;
export type SafeEvidenceExcerpt = z.infer<typeof safeEvidenceExcerptSchema>;
export type LanguageRequest = z.infer<typeof languageRequestSchema>;
export type LanguageProviderOutput = z.infer<
  typeof languageProviderOutputSchema
>;
export type LanguageFallbackReason = z.infer<
  typeof languageFallbackReasonSchema
>;
export type LanguageResult = z.infer<typeof languageResultSchema>;
