import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import {
  columnConfirmationSchema,
  researchBriefSchema,
} from "../agent/research-contracts.js";
import {
  recommendModels,
  type CatalogModel,
} from "../recommendation/engine.js";
import {
  recommendationResultSchema,
  type RecommendationResult,
} from "../recommendation/contracts.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import type { ModelCapabilityCard } from "../capabilities/contracts.js";
import type { ModelCapabilities } from "../recommendation/model-capabilities.js";
import { evidenceRefSchema, type EvidenceRef } from "../rag/contracts.js";
import { callThetaTools } from "./theta-tools.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaModelRecommendInput {
  dataProfile: Record<string, unknown>;
  researchGoal?: string;
  researchBrief?: Record<string, unknown>;
  columnConfirmation?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  evidence?: EvidenceRef[];
}

export type ThetaModelRecommendOutput = RecommendationResult;

const dataProfileSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Normalized dataset profile produced by theta.dataset.inspect or dataset.detect_columns.",
};

const modelRecommendInputSchema: JsonSchema = {
  type: "object",
  required: ["dataProfile"],
  properties: {
    dataProfile: dataProfileSchema,
    researchGoal: { type: "string" },
    researchBrief: { type: "object", additionalProperties: true },
    columnConfirmation: { type: "object", additionalProperties: true },
    constraints: {
      type: "object",
      additionalProperties: true,
    },
    evidence: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  additionalProperties: false,
};

const modelRecommendOutputSchema: JsonSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "deterministic",
    "recommendationVersion",
    "catalogSource",
    "dataProfileSummary",
    "recommendations",
    "skipped",
    "warnings",
    "constraintsApplied",
    "researchRequirements",
    "degradation",
    "noEvidence",
  ],
  properties: {
    schemaVersion: { const: "1.0.0" },
    deterministic: { const: true },
    recommendationVersion: { const: "1.0.0" },
    catalogSource: { type: "string" },
    dataProfileSummary: {
      type: "object",
      additionalProperties: true,
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        required: [
          "rank",
          "modelId",
          "modelName",
          "score",
          "reasonCodes",
          "warnings",
          "requirements",
        ],
        properties: {
          rank: { type: "integer" },
          modelId: { type: "string" },
          modelName: { type: "string" },
          score: { type: "integer" },
          reasonCodes: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          requirements: { type: "array", items: { type: "string" } },
          recommendedPlanPatch: {
            type: "object",
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    constraintsApplied: {
      type: "object",
      additionalProperties: true,
    },
    researchRequirements: {
      type: "object",
      additionalProperties: true,
    },
    degradation: {
      type: "object",
      additionalProperties: true,
    },
    noEvidence: { type: "boolean" },
  },
  additionalProperties: false,
};

export const thetaModelRecommendToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.modelRecommend,
  version: "2.0.0",
  displayName: "Recommend Model",
  description:
    "Apply deterministic TypeScript hard constraints, parameter ranges, resource estimates, and evidence.",
  tags: ["theta", "model", "evidence"],
  inputSchema: modelRecommendInputSchema,
  outputSchema: modelRecommendOutputSchema,
  sideEffectLevel: "read",
  permissionScope: [
    THETA_PERMISSION_SCOPES.modelRead,
    THETA_PERMISSION_SCOPES.datasetRead,
  ],
  timeoutPolicy: {
    timeoutMs: 30000,
    onTimeout: "fail",
  },
  retryPolicy: {
    maxAttempts: 1,
  },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: true,
  },
  source: "local",
};

const normalizeModelRecommendInput = (
  input: unknown,
): ThetaModelRecommendInput => {
  if (!input || typeof input !== "object" || !("dataProfile" in input)) {
    throw new Error("model.recommend input must include dataProfile.");
  }
  return input as ThetaModelRecommendInput;
};

export const thetaModelRecommendHandler: ToolHandler<
  unknown,
  ThetaModelRecommendOutput
> = async (input: unknown, context: ToolCallContext) => {
  const normalized = normalizeModelRecommendInput(input);
  const response = await callThetaTools(
    "model.catalog",
    {},
    {
      runId: context.runId,
      stepId: `${context.stepId}.catalog`,
    },
  );

  if (response.status !== "ok" || !isRecord(response.data)) {
    throw new Error(
      response.error?.message ?? "model.catalog THETA tools command failed.",
    );
  }
  const models = Array.isArray(response.data.models)
    ? response.data.models.filter(isCatalogModel)
    : [];
  if (models.length === 0) {
    throw new Error("model.catalog returned no valid models.");
  }
  const registry = new CapabilityRegistry();
  const capabilityAudit = registry.auditCatalog(models);
  if (capabilityAudit.status !== "pass") {
    const failures = capabilityAudit.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.code}:${issue.modelId ?? "registry"}`)
      .join(", ");
    throw new Error(
      `Capability Registry audit failed; model recommendation is fail-closed: ${failures}.`,
    );
  }
  const governedModels = models.map((model) => ({
    ...model,
    plannerEligible: registry.plannerEligibleModelIds().includes(model.id),
    maturity: registry.get(model.id)?.maturity ?? (model.experimental ? "experimental" : "production"),
    experimental:
      registry.get(model.id)?.maturity === "experimental" || model.experimental === true,
  }));
  const capabilityOverrides = Object.fromEntries(
    registry.cards.map((card) => [
      card.modelId,
      recommendationCapabilities(card),
    ]),
  );

  return recommendationResultSchema.parse(
    recommendModels({
      catalogSource: "theta-model-catalog",
      models: governedModels,
      dataProfile: normalized.dataProfile,
      ...(normalized.researchGoal
        ? { researchGoal: normalized.researchGoal }
        : {}),
      ...(normalized.constraints
        ? { constraints: normalized.constraints }
        : {}),
      ...(normalized.researchBrief
        ? { researchBrief: researchBriefSchema.parse(normalized.researchBrief) }
        : {}),
      ...(normalized.columnConfirmation
        ? {
            columnConfirmation: columnConfirmationSchema.parse(
              normalized.columnConfirmation,
            ),
          }
        : {}),
      evidence: (normalized.evidence ?? []).map((item) =>
        evidenceRefSchema.parse(item),
      ),
      capabilityOverrides,
    }),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isCatalogModel = (value: unknown): value is CatalogModel => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    Array.isArray(value.requires) &&
    value.requires.every((item) => typeof item === "string") &&
    isRecord(value.params)
  );
};

const recommendationCapabilities = (
  card: ModelCapabilityCard,
): ModelCapabilities => ({
  temporalTopics: card.capabilities.temporalTopics,
  metadataEffects: card.capabilities.metadataEffects,
  shortTextOptimized: card.capabilities.shortTextOptimized,
  // "conditional" means the audited implementation has a local fallback.
  // Keep it eligible for offline planning; limitations remain visible during
  // plan review and the dry run verifies that the local path is available.
  offlineExecution: card.capabilities.offlineExecution !== "unsupported",
  cpuExecution: card.capabilities.cpuExecution !== "unsupported",
  nativeOutputs: [...card.capabilities.nativeOutputs],
});
