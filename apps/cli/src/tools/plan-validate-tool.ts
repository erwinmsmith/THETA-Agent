import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import { callThetaTools } from "./theta-tools.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";
import {
  PLAN_VALIDATOR_VERSION,
  validateTrainingPlanV2,
  type ValidatorFinding,
} from "../planning/validator-v2.js";
import type { CapabilityCatalogModel } from "../capabilities/contracts.js";

export interface ThetaTrainingPlan {
  datasetId: string;
  modelId: string;
  mode: "zero_shot" | "supervised" | "unsupervised";
  topicCountMode?: "fixed" | "auto" | "target_reduction";
  numTopics?: number | null;
  maxTopics?: number | null;
  [key: string]: unknown;
}

export interface ThetaPlanValidateInput {
  plan: ThetaTrainingPlan;
  dataProfile?: Record<string, unknown>;
}

export interface ThetaPlanValidateOutput {
  valid: boolean;
  errors: string[];
  blockingWarnings: string[];
  warnings: string[];
  findings: ValidatorFinding[];
  validatorVersion: typeof PLAN_VALIDATOR_VERSION;
  normalizedPlan: Record<string, unknown>;
  catalogSource: string;
}

const trainingPlanSchema: JsonSchema = {
  type: "object",
  required: ["datasetId", "modelId", "mode"],
  properties: {
    datasetId: { type: "string" },
    modelId: { type: "string" },
    modelSize: { type: "string" },
    mode: { enum: ["zero_shot", "supervised", "unsupervised"] },
    topicCountMode: { enum: ["fixed", "auto", "target_reduction"] },
    numTopics: { anyOf: [{ type: "number" }, { type: "null" }] },
    maxTopics: { anyOf: [{ type: "number" }, { type: "null" }] },
    batchSize: { type: "number" },
    epochs: { type: "number" },
    learningRate: { type: "number" },
    textColumn: { type: "string" },
    timeColumn: { anyOf: [{ type: "string" }, { type: "null" }] },
    idColumn: { anyOf: [{ type: "string" }, { type: "null" }] },
    covariateColumns: { type: "array", items: { type: "string" } },
    metadataColumns: { type: "array", items: { type: "string" } },
    nNeighbors: { type: "integer" },
    nComponents: { type: "integer" },
    minClusterSize: { type: "integer" },
    minSamples: { anyOf: [{ type: "integer" }, { type: "null" }] },
    topNWords: { type: "integer" },
    randomState: { type: "integer" },
    experimentProtocol: {
      type: "object",
      required: [
        "mode",
        "primarySeeds",
        "baselineModelId",
        "baselineSeeds",
        "rationale",
        "evidenceRefs",
        "confidence",
      ],
      properties: {
        mode: { enum: ["quick", "comparative", "stability"] },
        primarySeeds: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: { type: "integer", minimum: 0, maximum: 2147483647 },
        },
        baselineModelId: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        baselineSeeds: {
          type: "array",
          maxItems: 3,
          uniqueItems: true,
          items: { type: "integer", minimum: 0, maximum: 2147483647 },
        },
        rationale: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        confidence: { enum: ["low", "medium", "high"] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: true,
};

const planValidateInputSchema: JsonSchema = {
  type: "object",
  required: ["plan"],
  properties: {
    plan: trainingPlanSchema,
    dataProfile: {
      type: "object",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
};

const planValidateOutputSchema: JsonSchema = {
  type: "object",
  required: [
    "validatorVersion",
    "valid",
    "errors",
    "blockingWarnings",
    "warnings",
    "findings",
    "normalizedPlan",
    "catalogSource",
  ],
  properties: {
    validatorVersion: { const: "2.0.0" },
    valid: { type: "boolean" },
    errors: { type: "array", items: { type: "string" } },
    blockingWarnings: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    normalizedPlan: {
      type: "object",
      additionalProperties: true,
    },
    catalogSource: { type: "string" },
  },
  additionalProperties: false,
};

export const thetaPlanValidateToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planValidate,
  version: "2.0.0",
  displayName: "Validate Training Plan",
  description:
    "Validate a THETA training plan against model catalog and runtime constraints through Hypha governance.",
  tags: ["theta", "plan"],
  inputSchema: planValidateInputSchema,
  outputSchema: planValidateOutputSchema,
  sideEffectLevel: "read",
  permissionScope: [
    THETA_PERMISSION_SCOPES.planRead,
    THETA_PERMISSION_SCOPES.modelRead,
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

const normalizePlanValidateInput = (input: unknown): ThetaPlanValidateInput => {
  if (!input || typeof input !== "object" || !("plan" in input)) {
    throw new Error("plan.validate input must include plan.");
  }
  return input as ThetaPlanValidateInput;
};

export const thetaPlanValidateHandler: ToolHandler<
  unknown,
  ThetaPlanValidateOutput
> = async (input: unknown, context: ToolCallContext) => {
  const normalized = normalizePlanValidateInput(input);
  const response = await callThetaTools(
    "model.catalog",
    {},
    {
      runId: context.runId,
      stepId: `${context.stepId}.catalog`,
    },
  );

  if (
    response.status !== "ok" ||
    !response.data ||
    typeof response.data !== "object"
  ) {
    throw new Error(
      response.error?.message ?? "model.catalog THETA tools command failed.",
    );
  }
  const models = Array.isArray(
    (response.data as Record<string, unknown>).models,
  )
    ? ((response.data as Record<string, unknown>)
        .models as CapabilityCatalogModel[])
    : [];
  return validateTrainingPlanV2({
    plan: normalized.plan,
    models,
    dataProfile: normalized.dataProfile,
  });
};
