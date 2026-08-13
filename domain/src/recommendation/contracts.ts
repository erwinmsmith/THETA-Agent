import { z } from "zod";
import { evidenceRefSchema } from "../rag/contracts.js";

export const RECOMMENDATION_VERSION = "1.0.0";

export const topicRecommendationSchema = z
  .object({
    range: z.tuple([
      z.number().int().min(2).max(200),
      z.number().int().min(2).max(200),
    ]),
    firstRun: z.number().int().min(2).max(200),
    alternatives: z.array(z.number().int().min(2).max(200)).min(1),
  })
  .strict()
  .refine((value) => value.range[0] <= value.range[1], {
    message: "Topic range must be ordered.",
  });

export const parameterRecommendationSchema = z
  .object({
    name: z.string().min(1),
    recommended: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    range: z
      .tuple([
        z.union([z.string(), z.number()]),
        z.union([z.string(), z.number()]),
      ])
      .nullable(),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    reasonCodes: z.array(z.string().min(1)).min(1),
    evidenceRefs: z.array(z.string().min(1)),
    confidence: z.enum(["low", "medium", "high"]),
    effectIfHigher: z.string().min(1),
    effectIfLower: z.string().min(1),
  })
  .strict();

export const resourceEstimateSchema = z
  .object({
    cpu: z.enum(["low", "medium", "high"]),
    gpu: z.enum(["none", "optional", "required"]),
    memory: z.enum(["low", "medium", "high"]),
    disk: z.enum(["low", "medium", "high"]),
    relativeRuntime: z.enum(["short", "medium", "long"]),
    network: z.enum(["none", "optional", "required"]),
  })
  .strict();

export const modelCapabilityAssessmentSchema = z
  .object({
    temporalTopics: z.boolean(),
    metadataEffects: z.boolean(),
    shortTextOptimized: z.boolean(),
    offlineExecution: z.boolean(),
    cpuExecution: z.boolean(),
    nativeOutputs: z.array(z.string().min(1)),
    unmetResearchRequirements: z.array(z.string().min(1)),
  })
  .strict()
  .default({
    temporalTopics: false,
    metadataEffects: false,
    shortTextOptimized: false,
    offlineExecution: true,
    cpuExecution: true,
    nativeOutputs: ['static_topics'],
    unmetResearchRequirements: [],
  });

export const modelRecommendationSchema = z
  .object({
    rank: z.number().int().positive(),
    modelId: z.string().min(1),
    modelName: z.string().min(1),
    maturity: z.enum(["production", "experimental", "incomplete", "unavailable"]).default("production"),
    score: z.number().int().min(0).max(100),
    confidence: z.enum(["low", "medium", "high"]),
    reasonCodes: z.array(z.string().min(1)).min(1),
    warnings: z.array(z.string().min(1)),
    requirements: z.array(z.string().min(1)),
    topicRecommendation: topicRecommendationSchema,
    parameters: z.array(parameterRecommendationSchema),
    resourceEstimate: resourceEstimateSchema,
    evidenceRefs: z.array(evidenceRefSchema),
    capabilityAssessment: modelCapabilityAssessmentSchema,
    recommendedPlanPatch: z
      .object({
        modelId: z.string().min(1),
        mode: z.enum(["zero_shot", "supervised", "unsupervised"]),
        topicCountMode: z
          .enum(["fixed", "auto", "target_reduction"])
          .default("fixed"),
        numTopics: z.number().int().min(2).max(200).nullable().optional(),
        maxTopics: z.number().int().min(2).max(1000).nullable().optional(),
        batchSize: z.number().int().positive().optional(),
        epochs: z.number().int().positive().optional(),
        nNeighbors: z.number().int().min(2).max(100).optional(),
        nComponents: z.number().int().min(2).max(50).optional(),
        minClusterSize: z.number().int().min(2).max(100).optional(),
        minSamples: z.number().int().positive().nullable().optional(),
        topNWords: z.number().int().min(1).max(30).optional(),
        randomState: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();

export const skippedModelSchema = z
  .object({
    modelId: z.string().min(1),
    reasonCodes: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const recommendationResultSchema = z
  .object({
    schemaVersion: z.literal(RECOMMENDATION_VERSION),
    deterministic: z.literal(true),
    recommendationVersion: z.literal(RECOMMENDATION_VERSION),
    catalogSource: z.string().min(1),
    dataProfileSummary: z
      .object({
        rowCount: z.number().int().nonnegative(),
        textColumnCount: z.number().int().nonnegative(),
        timeColumnCount: z.number().int().nonnegative(),
        metadataColumnCount: z.number().int().nonnegative(),
        averageTextLength: z.number().nonnegative(),
      })
      .strict(),
    recommendations: z.array(modelRecommendationSchema),
    skipped: z.array(skippedModelSchema),
    warnings: z.array(z.string().min(1)),
    constraintsApplied: z
      .object({
        preferredModelIds: z.array(z.string()),
        forbiddenModelIds: z.array(z.string()),
        unavailableRequirements: z.array(z.string()),
        mode: z.string().nullable(),
        maxTopics: z.number().int().nullable(),
      })
      .strict(),
    researchRequirements: z
      .object({
        required: z.array(z.string().min(1)),
        preferred: z.array(z.string().min(1)),
        reasons: z.record(z.string().min(1)),
      })
      .strict()
      .default({ required: [], preferred: [], reasons: {} }),
    degradation: z
      .object({
        required: z.boolean(),
        unmetRequirements: z.array(z.string().min(1)),
        message: z.string().min(1).nullable(),
      })
      .strict()
      .default({
        required: false,
        unmetRequirements: [],
        message: null,
      }),
    noEvidence: z.boolean(),
  })
  .strict();

export type TopicRecommendation = z.infer<typeof topicRecommendationSchema>;
export type ParameterRecommendation = z.infer<
  typeof parameterRecommendationSchema
>;
export type ResourceEstimate = z.infer<typeof resourceEstimateSchema>;
export type ModelRecommendation = z.infer<typeof modelRecommendationSchema>;
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;
