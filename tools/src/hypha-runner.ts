import { createHash } from "node:crypto";
import {
  InMemoryEventStore,
  type PolicyEngine,
  type TraceRecorder,
} from "@codesoul-co/hypha-core";
import {
  GovernedToolRunner,
  type ToolCallContext,
  type ToolCallResult,
} from "@codesoul-co/hypha-tools";
import { createThetaHyphaToolRegistry } from "./registry/tool-registry.js";
import type { ThetaDatasetDetectColumnsOutput } from "./dataset-detect-columns-tool.js";
import type {
  ThetaDatasetFileInput,
  ThetaDatasetInspectOutput,
} from "./dataset-inspect-tool.js";
import type {
  ThetaDatasetExploreInput,
  ThetaDatasetExploreOutput,
} from './dataset-explore-tool.js';
import type {
  ThetaModelCatalogInput,
  ThetaModelCatalogOutput,
} from "./model-catalog-tool.js";
import type {
  ThetaModelRecommendInput,
  ThetaModelRecommendOutput,
} from "./model-recommend-tool.js";
import type { ThetaRagIndexOutput } from "./rag-index-tool.js";
import type {
  ThetaRagSearchInput,
  ThetaRagSearchOutput,
} from "./rag-search-tool.js";
import type { ThetaRagStatusOutput } from "./rag-status-tool.js";
import type {
  ThetaPlanApproveInput,
  ThetaPlanApproveOutput,
} from "./plan-approve-tool.js";
import type {
  ThetaPlanCreateInput,
  ThetaPlanCreateOutput,
} from "./plan-create-tool.js";
import type {
  ThetaPlanValidateInput,
  ThetaPlanValidateOutput,
} from "./plan-validate-tool.js";
import type {
  ThetaPlanProposeInput,
  ThetaPlanProposeOutput,
} from "./plan-propose-tool.js";
import type {
  ThetaTrainingDryRunInput,
  ThetaTrainingDryRunOutput,
} from "./training-dry-run-tool.js";
import type {
  ThetaTrainingCancelInput,
  ThetaTrainingCancelOutput,
} from "./training-cancel-tool.js";
import type {
  ThetaTrainingStartInput,
  ThetaTrainingStartOutput,
} from "./training-start-tool.js";
import type {
  ThetaTrainingStatusInput,
  ThetaTrainingStatusOutput,
} from "./training-status-tool.js";
import type {
  ThetaLanguageGenerateInput,
  ThetaLanguageGenerateOutput,
} from "./language-generate-tool.js";
import type {
  ThetaConversationLanguageInput,
  ThetaConversationLanguageOutput,
} from "./conversation-language-tool.js";
import { sanitizeNaturalLanguageRequest } from "./support/language/natural-service.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaHyphaRunnerOptions {
  userId?: string;
  workspaceId?: string;
  permissionScopes?: string[];
  idempotencyKey?: string;
  invocationId?: string;
}

export interface ThetaHyphaRuntime {
  runner: GovernedToolRunner;
  trace: InMemoryEventStore;
}

const thetaTrainingControlToolIds = new Set<string>([
  THETA_TOOL_IDS.trainingStart,
  THETA_TOOL_IDS.trainingCancel,
]);

const thetaApprovedExternalToolIds = new Set<string>([
  ...thetaTrainingControlToolIds,
  THETA_TOOL_IDS.languageGenerate,
  THETA_TOOL_IDS.conversationLanguage,
  THETA_TOOL_IDS.datasetUnderstandingLanguage,
]);

export const thetaCliPolicyEngine: PolicyEngine = {
  async evaluate(context) {
    if (
      (context.sideEffectLevel === "external_effect" ||
        context.sideEffectLevel === "irreversible") &&
      context.capabilityId &&
      thetaApprovedExternalToolIds.has(context.capabilityId)
    ) {
      return {
        allowed: true,
        requiresHumanReview: true,
        policyId: "theta-cli-external-effects",
        ruleId: "allow-approved-external-effect",
        reason:
          "THETA external effects require explicit human approval.",
      };
    }

    if (
      context.sideEffectLevel === "external_effect" ||
      context.sideEffectLevel === "irreversible"
    ) {
      return {
        allowed: false,
        policyId: "theta-cli-external-effects",
        ruleId: "deny-unlisted-external-effects",
        reason: `Capability ${
          context.capabilityId ?? "unknown"
        } is not an approved THETA external effect.`,
      };
    }

    return {
      allowed: true,
      policyId: "theta-cli-external-effects",
      ruleId: "allow-local-capability",
    };
  },
};

export const createThetaGovernedToolRunner = (
  trace: TraceRecorder,
): GovernedToolRunner =>
  new GovernedToolRunner(
    createThetaHyphaToolRegistry(),
    trace,
    thetaCliPolicyEngine,
  );

export const createThetaHyphaRuntime = (): ThetaHyphaRuntime => {
  const trace = new InMemoryEventStore();
  const runner = createThetaGovernedToolRunner(trace);
  return { runner, trace };
};

export const createThetaToolCallContext = (
  runId: string,
  stepId: string,
  options: ThetaHyphaRunnerOptions = {},
): ToolCallContext => ({
  runId,
  stepId,
  invocationId: options.invocationId,
  idempotencyKey: options.idempotencyKey,
  userId: options.userId ?? "local_user",
  workspaceId: options.workspaceId ?? "local_workspace",
  principal: {
    id: options.userId ?? "local_user",
    type: "user",
    userId: options.userId ?? "local_user",
    workspaceId: options.workspaceId ?? "local_workspace",
    permissionScopes: options.permissionScopes ?? [
      THETA_PERMISSION_SCOPES.modelRead,
    ],
  },
  metadata: {
    source: "theta-agent",
  },
});

export const runThetaDatasetInspect = async (
  input: ThetaDatasetFileInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaDatasetInspectOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.datasetInspect,
    input,
    context: createThetaToolCallContext(
      "theta-dataset-inspect",
      "dataset_inspect",
      {
        ...options,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.datasetRead,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaDatasetInspectOutput>>;
};

export const runThetaDatasetExplore = async (
  input: ThetaDatasetExploreInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaDatasetExploreOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.datasetExplore,
    input,
    context: createThetaToolCallContext(
      'theta-dataset-explore',
      'dataset_explore',
      {
        ...options,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.datasetRead,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaDatasetExploreOutput>>;
};

export const runThetaDatasetDetectColumns = async (
  input: ThetaDatasetFileInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaDatasetDetectColumnsOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.datasetDetectColumns,
    input,
    context: createThetaToolCallContext(
      "theta-dataset-detect-columns",
      "dataset_detect_columns",
      {
        ...options,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.datasetRead,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaDatasetDetectColumnsOutput>>;
};

export const runThetaModelCatalog = async (
  input: ThetaModelCatalogInput = {},
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaModelCatalogOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.modelCatalog,
    input,
    context: createThetaToolCallContext(
      "theta-model-catalog-smoke",
      "model_catalog",
      options,
    ),
  }) as Promise<ToolCallResult<ThetaModelCatalogOutput>>;
};

export const runThetaModelRecommend = async (
  input: ThetaModelRecommendInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaModelRecommendOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.modelRecommend,
    input,
    context: createThetaToolCallContext(
      "theta-model-recommend-smoke",
      "model_recommend",
      {
        ...options,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.modelRead,
          THETA_PERMISSION_SCOPES.datasetRead,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaModelRecommendOutput>>;
};

export const runThetaRagSearch = async (
  input: ThetaRagSearchInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaRagSearchOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.ragSearch,
    input,
    context: createThetaToolCallContext("theta-rag-search", "rag_search", {
      ...options,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.ragRead,
      ],
    }),
  }) as Promise<ToolCallResult<ThetaRagSearchOutput>>;
};

export const runThetaRagBuild = async (
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaRagIndexOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.ragIndex,
    input: {},
    context: createThetaToolCallContext("theta-rag-build", "rag_build", {
      ...options,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.ragWrite,
      ],
    }),
  }) as Promise<ToolCallResult<ThetaRagIndexOutput>>;
};

export const runThetaRagStatus = async (
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaRagStatusOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.ragStatus,
    input: {},
    context: createThetaToolCallContext("theta-rag-status", "rag_status", {
      ...options,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.ragRead,
      ],
    }),
  }) as Promise<ToolCallResult<ThetaRagStatusOutput>>;
};

export const runThetaPlanValidate = async (
  input: ThetaPlanValidateInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaPlanValidateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.planValidate,
    input,
    context: createThetaToolCallContext(
      "theta-plan-validate-smoke",
      "plan_validate",
      {
        ...options,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.planRead,
          THETA_PERMISSION_SCOPES.modelRead,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaPlanValidateOutput>>;
};

export const requestThetaPlanCreate = async (
  input: ThetaPlanCreateInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaPlanCreateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.planCreate,
    input,
    context: createThetaToolCallContext(
      "theta-plan-create-approval-smoke",
      "plan_create",
      {
        ...options,
        idempotencyKey:
          options.idempotencyKey ?? "theta-plan-create-approval-smoke",
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.planWrite,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaPlanCreateOutput>>;
};

export const runApprovedThetaPlanCreate = async (
  input: ThetaPlanCreateInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaPlanCreateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const invocationId =
    options.invocationId ?? "theta-plan-create-approved-smoke";
  const context = createThetaToolCallContext(
    "theta-plan-create-approved-smoke",
    "plan_create",
    {
      ...options,
      invocationId,
      idempotencyKey:
        options.idempotencyKey ?? "theta-plan-create-approved-smoke",
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.planWrite,
      ],
    },
  );
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.planCreate,
    input,
    context,
  });

  if (requested.status !== "human_review_required") {
    return requested as ToolCallResult<ThetaPlanCreateOutput>;
  }

  return runner.approveAndResume(
    invocationId,
    options.userId ?? "local_user",
  ) as Promise<ToolCallResult<ThetaPlanCreateOutput>>;
};

export const requestThetaPlanApprove = async (
  input: ThetaPlanApproveInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaPlanApproveOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.planApprove,
    input,
    context: createThetaToolCallContext(
      "theta-plan-approve-request",
      "plan_approve",
      {
        ...options,
        idempotencyKey: options.idempotencyKey ?? "theta-plan-approve-request",
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.planApprove,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaPlanApproveOutput>>;
};

export const runApprovedThetaPlanApprove = async (
  input: ThetaPlanApproveInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaPlanApproveOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const invocationId = options.invocationId ?? "theta-plan-approve-approved";
  const context = createThetaToolCallContext(
    "theta-plan-approve-approved",
    "plan_approve",
    {
      ...options,
      invocationId,
      idempotencyKey: options.idempotencyKey ?? "theta-plan-approve-approved",
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.planApprove,
      ],
    },
  );
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.planApprove,
    input,
    context,
  });

  if (requested.status !== "human_review_required") {
    return requested as ToolCallResult<ThetaPlanApproveOutput>;
  }

  return runner.approveAndResume(
    invocationId,
    options.userId ?? "local_user",
  ) as Promise<ToolCallResult<ThetaPlanApproveOutput>>;
};

export const runThetaTrainingDryRun = async (
  input: ThetaTrainingDryRunInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaTrainingDryRunOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingDryRun,
    input,
    context: createThetaToolCallContext(
      "theta-training-dry-run",
      "training_dry_run",
      {
        ...options,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.planRead,
          THETA_PERMISSION_SCOPES.trainingRead,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaTrainingDryRunOutput>>;
};

export const requestThetaTrainingStart = async (
  input: ThetaTrainingStartInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaTrainingStartOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingStart,
    input,
    context: createThetaToolCallContext(
      "theta-training-start-request",
      "training_start",
      {
        ...options,
        idempotencyKey: options.idempotencyKey ?? input.idempotencyKey,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.trainingWrite,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaTrainingStartOutput>>;
};

export const runApprovedThetaTrainingStart = async (
  input: ThetaTrainingStartInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaTrainingStartOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const invocationId =
    options.invocationId ?? `theta-training-start-${input.idempotencyKey}`;
  const context = createThetaToolCallContext(
    "theta-training-start-approved",
    "training_start",
    {
      ...options,
      invocationId,
      idempotencyKey: options.idempotencyKey ?? input.idempotencyKey,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.trainingWrite,
      ],
    },
  );
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.trainingStart,
    input,
    context,
  });

  if (requested.status !== "human_review_required") {
    return requested as ToolCallResult<ThetaTrainingStartOutput>;
  }

  return runner.approveAndResume(
    invocationId,
    options.userId ?? "local_user",
  ) as Promise<ToolCallResult<ThetaTrainingStartOutput>>;
};

export const runThetaTrainingStatus = async (
  input: ThetaTrainingStatusInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaTrainingStatusOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingStatus,
    input,
    context: createThetaToolCallContext(
      "theta-training-status",
      "training_status",
      {
        ...options,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.trainingRead,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaTrainingStatusOutput>>;
};

export const requestThetaTrainingCancel = async (
  input: ThetaTrainingCancelInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaTrainingCancelOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingCancel,
    input,
    context: createThetaToolCallContext(
      "theta-training-cancel-request",
      "training_cancel",
      {
        ...options,
        idempotencyKey:
          options.idempotencyKey ??
          `theta-training-cancel-${input.trainingRunId}`,
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.trainingWrite,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaTrainingCancelOutput>>;
};

export const runApprovedThetaTrainingCancel = async (
  input: ThetaTrainingCancelInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaTrainingCancelOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const defaultKey = `theta-training-cancel-${input.trainingRunId}`;
  const invocationId = options.invocationId ?? defaultKey;
  const context = createThetaToolCallContext(
    "theta-training-cancel-approved",
    "training_cancel",
    {
      ...options,
      invocationId,
      idempotencyKey: options.idempotencyKey ?? defaultKey,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.trainingWrite,
      ],
    },
  );
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.trainingCancel,
    input,
    context,
  });

  if (requested.status !== "human_review_required") {
    return requested as ToolCallResult<ThetaTrainingCancelOutput>;
  }

  return runner.approveAndResume(
    invocationId,
    options.userId ?? "local_user",
  ) as Promise<ToolCallResult<ThetaTrainingCancelOutput>>;
};

export const requestThetaLanguageGenerate = async (
  input: ThetaLanguageGenerateInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaLanguageGenerateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.languageGenerate,
    input,
    context: createThetaToolCallContext(
      "theta-language-generate-request",
      "language_generate",
      {
        ...options,
        idempotencyKey:
          options.idempotencyKey ?? "theta-language-generate-request",
        permissionScopes: options.permissionScopes ?? [
          THETA_PERMISSION_SCOPES.inferenceUse,
        ],
      },
    ),
  }) as Promise<ToolCallResult<ThetaLanguageGenerateOutput>>;
};

export const runApprovedThetaLanguageGenerate = async (
  input: ThetaLanguageGenerateInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaLanguageGenerateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const invocationId =
    options.invocationId ?? "theta-language-generate-approved";
  const context = createThetaToolCallContext(
    "theta-language-generate-approved",
    "language_generate",
    {
      ...options,
      invocationId,
      idempotencyKey:
        options.idempotencyKey ?? "theta-language-generate-approved",
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.inferenceUse,
      ],
    },
  );
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.languageGenerate,
    input,
    context,
  });
  if (requested.status !== "human_review_required") {
    return requested as ToolCallResult<ThetaLanguageGenerateOutput>;
  }
  return runner.approveAndResume(
    invocationId,
    options.userId ?? "local_user",
  ) as Promise<ToolCallResult<ThetaLanguageGenerateOutput>>;
};

export const runThetaPlanPropose = async (
  input: ThetaPlanProposeInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaPlanProposeOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.planPropose,
    input,
    context: createThetaToolCallContext("theta-plan-propose", "plan_propose", {
      ...options,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.planRead,
        THETA_PERMISSION_SCOPES.ragRead,
        THETA_PERMISSION_SCOPES.inferenceUse,
      ],
    }),
  }) as Promise<ToolCallResult<ThetaPlanProposeOutput>>;
};

export const runApprovedThetaConversationLanguage = async (
  input: ThetaConversationLanguageInput,
  options: ThetaHyphaRunnerOptions = {},
): Promise<ToolCallResult<ThetaConversationLanguageOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const sanitizedInput = sanitizeNaturalLanguageRequest(input);
  const digest = createHash("sha256")
    .update(JSON.stringify(sanitizedInput))
    .digest("hex")
    .slice(0, 20);
  const invocationId =
    options.invocationId ?? `theta-conversation-language-${digest}`;
  const context = createThetaToolCallContext(
    "theta-conversation-language",
    sanitizedInput.task,
    {
      ...options,
      invocationId,
      idempotencyKey:
        options.idempotencyKey ?? `theta-conversation-language-${digest}`,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.inferenceUse,
      ],
    },
  );
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.conversationLanguage,
    input: sanitizedInput,
    context,
  });
  if (requested.status !== "human_review_required") {
    return requested as ToolCallResult<ThetaConversationLanguageOutput>;
  }
  return runner.approveAndResume(
    invocationId,
    options.userId ?? "local_user",
  ) as Promise<ToolCallResult<ThetaConversationLanguageOutput>>;
};
