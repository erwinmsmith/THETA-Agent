import { z } from "zod";

export const KNOWLEDGE_SCHEMA_VERSION = "1.1.0";

export const authoritySchema = z.enum(["L1", "L2", "L3", "L4"]);
export const knowledgeObjectTypeSchema = z.enum([
  "source",
  "model",
  "parameter",
  "rule",
  "recipe",
  "evaluation_metric",
  "failure_mode",
  "implementation_capability",
  "project_constraint",
  "conflict_group",
]);
export const thetaSupportStatusSchema = z.enum([
  "supported",
  "conditional",
  "unsupported",
  "unknown",
]);
export const evidenceConfidenceSchema = z.enum(["low", "medium", "high"]);

export const knowledgeSourceSchema = z
  .object({
    sourceId: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(["code", "config", "documentation"]),
    authority: authoritySchema,
    parser: z.enum(["text", "yaml", "markdown"]),
    sourceCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
  })
  .strict();

export const knowledgeObjectSetSchema = z
  .object({
    path: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
  })
  .strict();

export const structuredSourceSchema = z
  .object({
    sourceId: z.string().min(1),
    title: z.string().min(1),
    locator: z.string().min(1),
    authority: authoritySchema,
  })
  .strict();

export const knowledgeManifestSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    sources: z.array(knowledgeSourceSchema),
    structuredSources: z.array(structuredSourceSchema).min(1),
    objectSets: z.array(knowledgeObjectSetSchema).min(1),
  })
  .strict();

/** Canonical, reviewable YAML representation. Field names intentionally match
 * the research design instead of leaking SQLite/TypeScript conventions. */
export const knowledgeObjectSchema = z
  .object({
    object_id: z.string().min(1).max(160),
    object_type: knowledgeObjectTypeSchema,
    title: z.string().min(1).max(240),
    model_ids: z.array(z.string().min(1)).default([]),
    parameter_ids: z.array(z.string().min(1)).default([]),
    scenario_tags: z.array(z.string().min(1)).default([]),
    language: z.enum(["zh-CN", "en", "bilingual"]),
    aliases_zh: z.array(z.string().min(1)).default([]),
    aliases_en: z.array(z.string().min(1)).default([]),
    authority_level: authoritySchema,
    evidence_type: z.enum([
      "implementation",
      "catalog",
      "documentation",
      "paper",
      "project_policy",
      "heuristic",
    ]),
    source_id: z.string().min(1),
    source_year: z.number().int().min(1900).max(2200).nullable(),
    source_locator: z.string().min(1),
    claim_scope: z.string().min(1),
    implementation_name: z.string().min(1).nullable(),
    implementation_version: z.string().min(1).nullable(),
    theta_support_status: thetaSupportStatusSchema,
    confidence: evidenceConfidenceSchema,
    conflict_group_id: z.string().min(1).nullable(),
    content_markdown: z.string().min(1).max(12000),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
    updated_at: z.string().datetime(),
  })
  .strict();

export const knowledgeObjectFileSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    objects: z.array(knowledgeObjectSchema).min(1),
  })
  .strict();

export const retrievalRouteSchema = z
  .object({
    route: z.enum(["exact", "fts_raw", "fts_tokens", "fts_grams"]),
    queryType: z.enum([
      "model_selection",
      "hyperparameter",
      "preprocessing",
      "evaluation",
      "resource_and_environment",
      "failure_diagnosis",
    ]),
    rank: z.number().int().positive(),
    contribution: z.number().nonnegative(),
  })
  .strict();

export const evidenceRefSchema = z
  .object({
    evidenceId: z.string().min(1),
    sourceId: z.string().min(1),
    authority: authoritySchema,
    relativePath: z.string().min(1),
    symbol: z.string().nullable(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    sourceCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    excerpt: z.string().min(1).max(1200),
    finalScore: z.number().min(0).max(100),
    objectId: z.string().min(1).optional(),
    objectType: knowledgeObjectTypeSchema.optional(),
    title: z.string().min(1).optional(),
    modelIds: z.array(z.string()).optional(),
    parameterIds: z.array(z.string()).optional(),
    scenarioTags: z.array(z.string()).optional(),
    sourceYear: z.number().int().nullable().optional(),
    sourceLocator: z.string().optional(),
    claimScope: z.string().optional(),
    implementationName: z.string().nullable().optional(),
    implementationVersion: z.string().nullable().optional(),
    thetaSupportStatus: thetaSupportStatusSchema.optional(),
    confidence: evidenceConfidenceSchema.optional(),
    conflictGroupId: z.string().nullable().optional(),
    retrievalRoutes: z.array(retrievalRouteSchema).optional(),
    matchedQueries: z.array(z.string()).optional(),
  })
  .strict();

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;
export type KnowledgeObject = z.infer<typeof knowledgeObjectSchema>;
export type KnowledgeObjectType = z.infer<typeof knowledgeObjectTypeSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type RetrievalRoute = z.infer<typeof retrievalRouteSchema>;
