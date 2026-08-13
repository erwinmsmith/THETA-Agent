import { z } from "zod";

export const CAPABILITY_CARD_SCHEMA_VERSION = "1.0.0" as const;

const scalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const capabilityParameterSchema = z
  .object({
    parameterId: z.string().min(1),
    valueType: z.enum(["integer", "number", "string", "boolean"]),
    defaultValue: scalarSchema,
    catalogName: z.string().min(1).nullable(),
    planField: z.string().min(1).nullable(),
    trainFlag: z.string().regex(/^--[a-z0-9_-]+$/).nullable(),
    exposure: z.enum([
      "agent_compiled",
      "catalog_only",
      "implementation_only",
    ]),
    usedByTraining: z.boolean(),
    minimum: z.number().nullable().optional(),
    maximum: z.number().nullable().optional(),
    choices: z.array(scalarSchema).default([]),
    notes: z.string().min(1),
  })
  .superRefine((parameter, context) => {
    if (
      parameter.exposure === "agent_compiled" &&
      (!parameter.planField || !parameter.trainFlag)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "agent_compiled parameters require both planField and trainFlag.",
      });
    }
    if (
      parameter.minimum !== undefined &&
      parameter.minimum !== null &&
      parameter.maximum !== undefined &&
      parameter.maximum !== null &&
      parameter.minimum > parameter.maximum
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimum must not exceed maximum.",
      });
    }
  });

export const capabilityArtifactSchema = z.object({
  artifactId: z.string().min(1),
  pathPattern: z.string().min(1),
  required: z.boolean(),
  producedBy: z.string().min(1),
  description: z.string().min(1),
});

export const modelCapabilityCardSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_CARD_SCHEMA_VERSION),
    modelId: z.string().regex(/^[a-z0-9_-]+$/),
    displayName: z.string().min(1),
    maturity: z.enum(["production", "experimental", "incomplete", "unavailable"]).default("production"),
    audit: z.object({
      status: z.literal("audited"),
      auditedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      sourceRefs: z.array(z.string().min(1)).min(1),
    }),
    planner: z.object({
      eligible: z.boolean(),
      reason: z.string().min(1),
    }),
    catalog: z.object({
      requires: z.array(z.string().min(1)),
      autoTopics: z.boolean(),
    }),
    implementation: z.object({
      family: z.enum([
        "probabilistic_bow",
        "short_text_probabilistic",
        "dynamic_neural",
        "structural_covariate",
        "embedding_clustering",
        "llm_embedding_neural",
      ]),
      language: z.enum(["python", "python_r_optional"]),
      modulePath: z.string().min(1),
      trainerEntry: z.string().min(1),
      prepareMode: z.enum(["baseline", "dtm", "theta"]),
      runtimePackages: z.array(z.string().min(1)),
      actualInputs: z.array(z.string().min(1)).min(1),
    }),
    capabilities: z.object({
      temporalTopics: z.boolean(),
      metadataEffects: z.boolean(),
      shortTextOptimized: z.boolean(),
      topicCountMode: z.enum(["fixed", "inferred", "fixed_or_reduced"]),
      offlineExecution: z.enum(["supported", "conditional", "unsupported"]),
      cpuExecution: z.enum(["supported", "conditional", "unsupported"]),
      nativeOutputs: z.array(z.string().min(1)).min(1),
    }),
    parameters: z.array(capabilityParameterSchema),
    artifacts: z.array(capabilityArtifactSchema).min(1),
    limitations: z.array(z.string().min(1)),
    unverifiedClaims: z.array(z.string().min(1)),
  })
  .superRefine((card, context) => {
    const parameterIds = new Set<string>();
    for (const [index, parameter] of card.parameters.entries()) {
      if (parameterIds.has(parameter.parameterId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", index, "parameterId"],
          message: `Duplicate parameterId '${parameter.parameterId}'.`,
        });
      }
      parameterIds.add(parameter.parameterId);
    }
    const artifactIds = new Set<string>();
    for (const [index, artifact] of card.artifacts.entries()) {
      if (artifactIds.has(artifact.artifactId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", index, "artifactId"],
          message: `Duplicate artifactId '${artifact.artifactId}'.`,
        });
      }
      artifactIds.add(artifact.artifactId);
    }
  });

export type CapabilityParameter = z.infer<typeof capabilityParameterSchema>;
export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
export type ModelCapabilityCard = z.infer<typeof modelCapabilityCardSchema>;

export interface CapabilityCatalogModel {
  id: string;
  requires: string[];
  params: Record<string, unknown>;
  runnable?: boolean;
  autoTopics?: boolean;
  experimental?: boolean;
}

export interface CapabilityAuditIssue {
  severity: "error" | "warning";
  code: string;
  modelId?: string;
  message: string;
}

export interface CapabilityAuditReport {
  status: "pass" | "fail";
  auditedModelIds: string[];
  plannerEligibleModelIds: string[];
  plannerExcludedModelIds: string[];
  unauditedCatalogModelIds: string[];
  issues: CapabilityAuditIssue[];
}
