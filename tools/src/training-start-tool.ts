import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import {
  approvalReceiptSchema,
  dryRunReceiptSchema,
  trainingPlanRecordSchema,
  type ApprovalReceipt,
  type DryRunReceipt,
  type TrainingPlanRecord,
} from "@theta-agent/domain/planning/contracts.js";
import { assertApprovalChain } from "./support/planning/engine.js";
import {
  trainingReceiptSchema,
  type TrainingReceipt,
} from "@theta-agent/domain/training/contracts.js";
import { callThetaTools } from "./theta-tools.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";
import { validateCanonicalTrainingPlanV2 } from "./support/planning/validator-v2.js";
import type { CapabilityCatalogModel } from "@theta-agent/domain/capabilities/contracts.js";

export interface ThetaTrainingStartInput {
  plan: TrainingPlanRecord;
  planReview: ApprovalReceipt;
  dryRun: DryRunReceipt;
  trainingReview: ApprovalReceipt;
  idempotencyKey: string;
  retryOfTrainingRunId?: string;
  retryReason?: string;
}

export type ThetaTrainingStartOutput = TrainingReceipt;

const trainingStartInputSchema: JsonSchema = {
  type: "object",
  required: [
    "plan",
    "planReview",
    "dryRun",
    "trainingReview",
    "idempotencyKey",
  ],
  properties: {
    plan: { type: "object", additionalProperties: true },
    planReview: { type: "object", additionalProperties: true },
    dryRun: { type: "object", additionalProperties: true },
    trainingReview: { type: "object", additionalProperties: true },
    idempotencyKey: { type: "string", minLength: 1 },
    retryOfTrainingRunId: { type: "string", minLength: 1 },
    retryReason: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const trainingStartOutputSchema: JsonSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "trainingRunId",
    "attempt",
    "retryOfTrainingRunId",
    "idempotencyKey",
    "planId",
    "planHash",
    "planReviewApprovalId",
    "trainingReviewApprovalId",
    "dryRunHash",
    "status",
    "progress",
    "processStarted",
    "pid",
    "runnerPid",
    "activePid",
    "currentStep",
    "currentPhase",
    "phaseContext",
    "phaseUpdatedAt",
    "logPath",
    "pythonExecutable",
    "pythonVersion",
    "pythonEnvironment",
    "commands",
    "analysisBindings",
    "expectedArtifacts",
    "resultArtifacts",
    "errorMessage",
    "failure",
    "quarantineReason",
    "cancellation",
    "startedAt",
    "finishedAt",
    "createdAt",
    "updatedAt",
    "message",
  ],
  properties: {
    trainingRunId: { type: "string" },
    schemaVersion: { const: "1.0.0" },
    attempt: { type: "integer", minimum: 1 },
    retryOfTrainingRunId: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    idempotencyKey: { type: "string" },
    planId: { type: "string" },
    planHash: { type: "string" },
    planReviewApprovalId: { type: "string" },
    trainingReviewApprovalId: { type: "string" },
    dryRunHash: { type: "string" },
    status: { type: "string" },
    executionStatus: {
      enum: [
        "queued",
        "running",
        "cancel_requested",
        "completed",
        "failed",
        "cancelled",
        "quarantined",
      ],
    },
    quality: {
      anyOf: [
        {
          type: "object",
          required: ["status", "checks", "assessedAt"],
          properties: {
            modelId: { type: "string", minLength: 1 },
            profileVersion: { type: "string", minLength: 1 },
            status: { enum: ["passed", "warning", "failed"] },
            checks: {
              type: "array",
              items: {
                type: "object",
                required: ["code", "status", "detail"],
                properties: {
                  code: { type: "string", minLength: 1 },
                  status: { enum: ["pass", "warn", "fail"] },
                  detail: { type: "string", minLength: 1 },
                  value: { type: "number" },
                },
                additionalProperties: false,
              },
            },
            assessedAt: { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
        { type: "object", maxProperties: 0, additionalProperties: false },
      ],
    },
    progress: { type: "number" },
    processStarted: { type: "boolean" },
    pid: { anyOf: [{ type: "integer" }, { type: "null" }] },
    runnerPid: { anyOf: [{ type: "integer" }, { type: "null" }] },
    activePid: { anyOf: [{ type: "integer" }, { type: "null" }] },
    currentStep: { type: "string" },
    currentPhase: {
      enum: ["preparing", "preprocessing", "training", "evaluating", "visualizing", "packaging", "completed"],
    },
    phaseContext: { type: "object", additionalProperties: true },
    phaseUpdatedAt: { type: "string", format: "date-time" },
    logPath: { anyOf: [{ type: "string" }, { type: "null" }] },
    pythonExecutable: { type: "string" },
    pythonVersion: { type: "string" },
    pythonEnvironment: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    commands: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    analysisBindings: {
      type: "object",
      additionalProperties: true,
    },
    expectedArtifacts: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    resultArtifacts: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    errorMessage: { anyOf: [{ type: "string" }, { type: "null" }] },
    failure: {
      anyOf: [
        { type: "object", additionalProperties: true },
        { type: "null" },
      ],
    },
    quarantineReason: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    cancellation: {
      anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
    },
    startedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    finishedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    message: { type: "string" },
  },
  additionalProperties: false,
};

export const thetaTrainingStartToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingStart,
  version: "3.1.0",
  displayName: "Start Training",
  description:
    "Start THETA only with a canonical plan, HumanPlanReview, successful dry-run, and distinct HumanTrainingReview.",
  tags: ["theta", "training"],
  inputSchema: trainingStartInputSchema,
  outputSchema: trainingStartOutputSchema,
  sideEffectLevel: "external_effect",
  permissionScope: [THETA_PERMISSION_SCOPES.trainingWrite],
  humanApprovalPolicy: {
    required: true,
    reason:
      "Starting THETA training creates a background process and local model artifacts.",
  },
  idempotencyPolicy: { mode: "required" },
  timeoutPolicy: { timeoutMs: 60000, onTimeout: "fail" },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: true,
  },
  source: "local",
};

const normalizeTrainingStartInput = (
  input: unknown,
): ThetaTrainingStartInput => {
  if (!input || typeof input !== "object") {
    throw new Error("training.start input must be an object.");
  }
  const value = input as ThetaTrainingStartInput;
  const normalized = {
    plan: trainingPlanRecordSchema.parse(value.plan),
    planReview: approvalReceiptSchema.parse(value.planReview),
    dryRun: dryRunReceiptSchema.parse(value.dryRun),
    trainingReview: approvalReceiptSchema.parse(value.trainingReview),
    idempotencyKey: value.idempotencyKey,
    ...(value.retryOfTrainingRunId === undefined
      ? {}
      : { retryOfTrainingRunId: value.retryOfTrainingRunId }),
    ...(value.retryReason === undefined
      ? {}
      : { retryReason: value.retryReason }),
  };
  if (!normalized.idempotencyKey?.trim())
    throw new Error("idempotencyKey is required.");
  assertApprovalChain(normalized);
  return normalized;
};

export const thetaTrainingStartHandler: ToolHandler<
  unknown,
  ThetaTrainingStartOutput
> = async (input: unknown, context: ToolCallContext) => {
  const value = normalizeTrainingStartInput(input);
  const catalogResponse = await callThetaTools(
    "model.catalog",
    {},
    {
      runId: context.runId,
      stepId: `${context.stepId}.validator-v2.catalog`,
    },
  );
  if (
    catalogResponse.status !== "ok" ||
    !catalogResponse.data ||
    typeof catalogResponse.data !== "object"
  ) {
    throw new Error(
      catalogResponse.error?.message ?? "model.catalog THETA tools command failed.",
    );
  }
  const models = Array.isArray(
    (catalogResponse.data as Record<string, unknown>).models,
  )
    ? ((catalogResponse.data as Record<string, unknown>)
        .models as CapabilityCatalogModel[])
    : [];
  const validation = validateCanonicalTrainingPlanV2(
    value.plan as unknown as Record<string, unknown>,
    models,
  );
  if (!validation.valid) {
    throw new Error(
      `Validator V2 rejected training.start: ${validation.errors.join("; ")}`,
    );
  }
  const response = await callThetaTools("training.start", value, {
    runId: context.runId,
    stepId: context.stepId,
  });
  if (
    response.status !== "ok" ||
    !response.data ||
    typeof response.data !== "object"
  ) {
    throw new Error(
      response.error?.message ?? "training.start THETA tools command failed.",
    );
  }
  return trainingReceiptSchema.parse(response.data);
};
