import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import { callThetaBridge } from "./bridge.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaModelCatalogInput {
  includeExperimental?: boolean;
}

export interface ThetaModelCatalogOutput {
  source: string;
  runnableSource: string;
  models: Array<{
    id: string;
    name: string;
    type: string;
    requires: string[];
    params: Record<string, unknown>;
    runnable?: boolean;
    experimental?: boolean;
    autoTopics?: boolean;
  }>;
  supportedModelIds: string[];
}

const modelCatalogInputSchema: JsonSchema = {
  type: "object",
  properties: {
    includeExperimental: {
      type: "boolean",
      description:
        "Include experimental THETA model entries when the bridge exposes them.",
    },
  },
  additionalProperties: false,
};

const modelCatalogOutputSchema: JsonSchema = {
  type: "object",
  required: ["source", "runnableSource", "models", "supportedModelIds"],
  properties: {
    source: { type: "string" },
    runnableSource: { type: "string" },
    models: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "type", "requires", "params"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string" },
          requires: { type: "array", items: { type: "string" } },
          params: { type: "object", additionalProperties: true },
          runnable: { type: "boolean" },
          experimental: { type: "boolean" },
          autoTopics: { type: "boolean" },
        },
        additionalProperties: true,
      },
    },
    supportedModelIds: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

export const thetaModelCatalogToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.modelCatalog,
  version: "1.0.0",
  displayName: "List Model Catalog",
  description:
    "Return the normalized THETA model catalog through the governed Hypha tool boundary.",
  tags: ["theta", "model"],
  inputSchema: modelCatalogInputSchema,
  outputSchema: modelCatalogOutputSchema,
  sideEffectLevel: "read",
  permissionScope: [THETA_PERMISSION_SCOPES.modelRead],
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

const ensureModelCatalogOutput = (data: unknown): ThetaModelCatalogOutput => {
  if (!data || typeof data !== "object") {
    throw new Error("model.catalog bridge returned a non-object payload.");
  }
  return data as ThetaModelCatalogOutput;
};

const normalizeModelCatalogInput = (input: unknown): ThetaModelCatalogInput => {
  if (!input || typeof input !== "object") {
    return {};
  }
  return input as ThetaModelCatalogInput;
};

export const thetaModelCatalogHandler: ToolHandler<
  unknown,
  ThetaModelCatalogOutput
> = async (input: unknown, context: ToolCallContext) => {
  const response = await callThetaBridge(
    "model.catalog",
    normalizeModelCatalogInput(input),
    {
      runId: context.runId,
      stepId: context.stepId,
    },
  );

  if (response.status !== "ok") {
    throw new Error(
      response.error?.message ?? "model.catalog bridge command failed.",
    );
  }

  const output = ensureModelCatalogOutput(response.data);
  return {
    ...output,
    source: "theta-model-catalog",
    runnableSource: "theta-run-pipeline",
  };
};
