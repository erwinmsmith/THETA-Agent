import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import {
  approvalReceiptSchema,
  dryRunCheckSchema,
  expectedArtifactSchema,
  trainingCommandSchema,
  trainingPlanRecordSchema,
  type ApprovalReceipt,
  type DryRunReceipt,
  type TrainingPlanRecord,
} from "../planning/contracts.js";
import { createDryRunReceipt } from "../planning/engine.js";
import { callThetaBridge } from "./bridge.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";
import {
  PLAN_VALIDATOR_VERSION,
  validateCanonicalTrainingPlanV2,
} from "../planning/validator-v2.js";
import type { CapabilityCatalogModel } from "../capabilities/contracts.js";

export interface ThetaTrainingDryRunInput {
  plan: TrainingPlanRecord;
  planReview: ApprovalReceipt;
  datasetPath: string;
}

export type ThetaTrainingCommand = DryRunReceipt["commands"][number];
export type ThetaExpectedArtifact = DryRunReceipt["expectedArtifacts"][number];
export type ThetaTrainingDryRunOutput = DryRunReceipt;

const trainingDryRunInputSchema: JsonSchema = {
  type: "object",
  required: ["plan", "planReview", "datasetPath"],
  properties: {
    plan: { type: "object", additionalProperties: true },
    planReview: { type: "object", additionalProperties: true },
    datasetPath: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const trainingDryRunOutputSchema: JsonSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "dryRunId",
    "dryRunHash",
    "planId",
    "planHash",
    "planReviewApprovalId",
    "passed",
    "checks",
    "commands",
    "expectedArtifacts",
    "notes",
    "checkedAt",
  ],
  properties: {
    schemaVersion: { enum: ["1.0.0", "2.0.0"] },
    dryRunId: { type: "string" },
    dryRunHash: { type: "string" },
    planId: { type: "string" },
    planHash: { type: "string" },
    planReviewApprovalId: { type: "string" },
    passed: { type: "boolean" },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "status", "detail"],
        properties: {
          code: { type: "string" },
          status: { enum: ["pass", "warn", "fail"] },
          detail: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    commands: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    expectedArtifacts: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    notes: { type: "array", items: { type: "string" } },
    checkedAt: { type: "string" },
  },
  additionalProperties: false,
};

export const thetaTrainingDryRunToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingDryRun,
  version: "2.0.0",
  displayName: "Preview Training Run",
  description:
    "Validate execution readiness and derive a receipt bound to the canonical plan and HumanPlanReview.",
  tags: ["theta", "training"],
  inputSchema: trainingDryRunInputSchema,
  outputSchema: trainingDryRunOutputSchema,
  sideEffectLevel: "read",
  permissionScope: [
    THETA_PERMISSION_SCOPES.planRead,
    THETA_PERMISSION_SCOPES.trainingRead,
  ],
  timeoutPolicy: { timeoutMs: 30000, onTimeout: "fail" },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: true,
  },
  source: "local",
};

const normalizeTrainingDryRunInput = (
  input: unknown,
): ThetaTrainingDryRunInput => {
  if (!input || typeof input !== "object") {
    throw new Error("training.dry_run input must be an object.");
  }
  const value = input as ThetaTrainingDryRunInput;
  const plan = trainingPlanRecordSchema.parse(value.plan);
  const planReview = approvalReceiptSchema.parse(value.planReview);
  if (planReview.approvalType !== "human_plan_review") {
    throw new Error("training.dry_run requires a HumanPlanReview receipt.");
  }
  if (
    planReview.planId !== plan.planId ||
    planReview.planHash !== plan.planHash
  ) {
    throw new Error("HumanPlanReview does not bind the canonical plan.");
  }
  if (!value.datasetPath?.trim()) throw new Error("datasetPath is required.");
  return { plan, planReview, datasetPath: value.datasetPath };
};

export const thetaTrainingDryRunHandler: ToolHandler<
  unknown,
  ThetaTrainingDryRunOutput
> = async (input: unknown, context: ToolCallContext) => {
  const value = normalizeTrainingDryRunInput(input);
  const catalogResponse = await callThetaBridge(
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
      catalogResponse.error?.message ?? "model.catalog bridge command failed.",
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
      `Validator V2 rejected training.dry_run: ${validation.errors.join("; ")}`,
    );
  }
  const response = await callThetaBridge(
    "training.dry_run",
    {
      plan: value.plan,
      planReview: value.planReview,
      datasetPath: value.datasetPath,
    },
    { runId: context.runId, stepId: context.stepId },
  );
  if (
    response.status !== "ok" ||
    !response.data ||
    typeof response.data !== "object"
  ) {
    throw new Error(
      response.error?.message ?? "training.dry_run bridge command failed.",
    );
  }
  const data = response.data as Record<string, unknown>;
  return createDryRunReceipt({
    planId: value.plan.planId,
    planHash: value.plan.planHash,
    planReviewApprovalId: value.planReview.approvalId,
    passed: data.passed === true,
    checks: [
      {
        code: "VALIDATOR_V2",
        status: "pass" as const,
        detail: `Canonical plan passed Validator ${PLAN_VALIDATOR_VERSION}.`,
      },
      ...validation.findings
        .filter((finding) => finding.level !== "error")
        .map((finding) => ({
          code: finding.code,
          status: "warn" as const,
          detail: finding.message,
        })),
      ...(Array.isArray(data.checks)
        ? data.checks.map((item) => dryRunCheckSchema.parse(item))
        : []),
    ],
    commands: Array.isArray(data.commands)
      ? data.commands.map((item) => trainingCommandSchema.parse(item))
      : [],
    expectedArtifacts: Array.isArray(data.expectedArtifacts)
      ? data.expectedArtifacts.map((item) => expectedArtifactSchema.parse(item))
      : [],
    notes: Array.isArray(data.notes)
      ? data.notes.filter((item): item is string => typeof item === "string")
      : [],
    checkedAt:
      typeof data.checkedAt === "string"
        ? data.checkedAt
        : new Date().toISOString(),
  });
};
