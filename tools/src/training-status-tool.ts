import type { JsonSchema } from "@codesoul-co/hypha-core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@codesoul-co/hypha-tools";
import {
  trainingStatusOutputSchema as trainingStatusContractSchema,
  type TrainingStatusOutput,
} from "@theta-agent/domain/training/contracts.js";
import { callThetaTools } from "./theta-tools.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaTrainingStatusInput {
  trainingRunId: string;
  logLimit?: number;
  reassessQuality?: boolean;
}

export type ThetaTrainingStatusOutput = TrainingStatusOutput;

const trainingStatusInputSchema: JsonSchema = {
  type: "object",
  required: ["trainingRunId"],
  properties: {
    trainingRunId: { type: "string", minLength: 1 },
    logLimit: { type: "integer", minimum: 1, maximum: 500 },
    reassessQuality: { type: "boolean" },
  },
  additionalProperties: false,
};

const trainingStatusOutputSchema: JsonSchema = {
  type: "object",
  required: ["trainingRunId", "found", "status", "logs", "events"],
  properties: {
    trainingRunId: { type: "string" },
    found: { type: "boolean" },
    status: { type: "string" },
    reassessed: { type: "boolean" },
    reassessmentReceipt: { type: "object", additionalProperties: true },
    logs: { type: "array", items: { type: "string" } },
    receipt: { type: "object", additionalProperties: true },
    events: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  additionalProperties: false,
};

export const thetaTrainingStatusToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingStatus,
  version: "2.0.0",
  displayName: "Get Training Status",
  description:
    "Read THETA training progress, logs, artifacts, and lifecycle events through Hypha governance.",
  tags: ["theta", "training"],
  inputSchema: trainingStatusInputSchema,
  outputSchema: trainingStatusOutputSchema,
  sideEffectLevel: "read",
  permissionScope: [THETA_PERMISSION_SCOPES.trainingRead],
  timeoutPolicy: {
    timeoutMs: 30000,
    onTimeout: "fail",
  },
  retryPolicy: {
    maxAttempts: 1,
  },
  auditPolicy: {
    enabled: true,
    includeInput: true,
    includeOutput: false,
  },
  source: "local",
};

const normalizeTrainingStatusInput = (
  input: unknown,
): ThetaTrainingStatusInput => {
  if (!input || typeof input !== "object") {
    throw new Error("training.status input must be an object.");
  }
  return input as ThetaTrainingStatusInput;
};

const ensureTrainingStatusOutput = (
  data: unknown,
): ThetaTrainingStatusOutput => {
  if (!data || typeof data !== "object") {
    throw new Error("training.status THETA tools returned a non-object payload.");
  }
  return trainingStatusContractSchema.parse(data);
};

export const thetaTrainingStatusHandler: ToolHandler<
  unknown,
  ThetaTrainingStatusOutput
> = async (input: unknown, context: ToolCallContext) => {
  const response = await callThetaTools(
    "training.status",
    normalizeTrainingStatusInput(input),
    {
      runId: context.runId,
      stepId: context.stepId,
    },
  );

  if (response.status !== "ok") {
    throw new Error(
      response.error?.message ?? "training.status THETA tools command failed.",
    );
  }

  return ensureTrainingStatusOutput(response.data);
};
