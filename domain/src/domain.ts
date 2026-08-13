import type { SpecRef } from "@hypha/core";
import {
  compileDomainPackToHarnessedSystem,
  resolveWorkflowToolExecutionScope,
  validateDomainPackSpec,
  type DomainCompilationResult,
  type DomainPackSpec,
  type WorkflowStateSpec,
} from "@hypha/domain";
import type { ToolExecutionScope, ToolSpec } from "@hypha/tools";

export const THETA_TOOL_IDS = {
  datasetInspect: "theta.dataset.inspect",
  datasetExplore: "theta.dataset.explore",
  datasetDetectColumns: "theta.dataset.detect_columns",
  datasetUnderstandingLanguage: "theta.dataset.understanding.language",
  modelCatalog: "theta.model.catalog",
  modelRecommend: "theta.model.recommend",
  ragIndex: "theta.rag.index",
  ragStatus: "theta.rag.status",
  ragSearch: "theta.rag.search",
  planPropose: "theta.plan.propose",
  planValidate: "theta.plan.validate",
  planCreate: "theta.plan.create",
  planApprove: "theta.plan.approve",
  trainingDryRun: "theta.training.dry_run",
  trainingStart: "theta.training.start",
  trainingStatus: "theta.training.status",
  trainingCancel: "theta.training.cancel",
  languageGenerate: "theta.language.generate",
  conversationLanguage: "theta.conversation.language",
} as const;

export const THETA_PERMISSION_SCOPES = {
  datasetRead: "theta:dataset:read",
  modelRead: "theta:model:read",
  ragRead: "theta:rag:read",
  ragWrite: "theta:rag:write",
  planRead: "theta:plan:read",
  planWrite: "theta:plan:write",
  planApprove: "theta:plan:approve",
  trainingRead: "theta:training:read",
  trainingWrite: "theta:training:write",
  inferenceUse: "theta:inference:use",
} as const;

export const THETA_DOMAIN_PACK_ID = "domain.theta.training";
export const THETA_DOMAIN_PACK_VERSION = "5.0.0";
export const THETA_WORKFLOW_ID = "workflow.theta.training";
export const THETA_WORKFLOW_VERSION = "5.0.0";
export const THETA_AGENT_REF: SpecRef = {
  id: "agent.theta.cli",
  version: "1.0.0",
};

export const THETA_WORKFLOW_STATES = {
  intake: "Intake",
  awaitResearchClarification: "ResearchClarification",
  inspectDataset: "InspectDataset",
  analyzeDataset: "AnalyzeDataset",
  awaitDatasetUnderstandingConfirmation:
    "AwaitDatasetUnderstandingConfirmation",
  researchIntentInterview: "ResearchIntentInterview",
  awaitResearchIntentConfirmation: "AwaitResearchIntentConfirmation",
  awaitColumnConfirmation: "ColumnConfirmation",
  recommendModel: "RecommendModel",
  validatePlan: "ValidatePlan",
  awaitPlanCreationApproval: "AwaitPlanCreationApproval",
  createPlan: "CreatePlan",
  dryRun: "DryRun",
  awaitTrainingStartApproval: "AwaitTrainingStartApproval",
  verifyDatasetBeforeTraining: "VerifyDatasetBeforeTraining",
  startTraining: "StartTraining",
  monitorTraining: "MonitorTraining",
  evaluate: "Evaluate",
  visualize: "Visualize",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  quarantined: "Quarantined",
} as const;

export const THETA_APPROVAL_KEYS = {
  researchClarification: "theta.research.clarify",
  datasetUnderstanding: "theta.dataset-understanding.confirm",
  researchIntent: "theta.research-intent.confirm",
  researchIntentReview: "theta.research-intent.review",
  columnConfirmation: "theta.columns.confirm",
  planReview: "theta.plan.review",
  trainingReview: "theta.training.review",
} as const;

const toolRef = (id: string, version = "1.0.0"): SpecRef => ({ id, version });

const state = (
  id: string,
  goal: string,
  options: Partial<WorkflowStateSpec> = {},
): WorkflowStateSpec => ({
  id,
  goal,
  ...options,
});

const readonlyPolicy = {
  id: "policy.theta.readonly",
  version: "1.0.0",
  defaultEffect: "deny" as const,
  rules: [
    {
      id: "policy.theta.readonly.allow",
      version: "1.0.0",
      effect: "allow" as const,
      sideEffectLevels: ["none", "read"] as const,
    },
  ],
};

const stateWritePolicy = {
  id: "policy.theta.state-write",
  version: "1.0.0",
  defaultEffect: "deny" as const,
  rules: [
    {
      id: "policy.theta.state-write.allow",
      version: "1.0.0",
      effect: "allow" as const,
      sideEffectLevels: ["write"] as const,
    },
  ],
};

const trainingControlPolicy = {
  id: "policy.theta.training-control",
  version: "1.0.0",
  defaultEffect: "deny" as const,
  rules: [
    {
      id: "policy.theta.training-control.allow",
      version: "1.0.0",
      effect: "allow" as const,
      sideEffectLevels: ["external_effect"] as const,
    },
  ],
};

const languageInferencePolicy = {
  id: "policy.theta.language-inference",
  version: "1.0.0",
  defaultEffect: "deny" as const,
  rules: [
    {
      id: "policy.theta.language-inference.allow",
      version: "1.0.0",
      effect: "allow" as const,
      sideEffectLevels: ["external_effect"] as const,
    },
  ],
};

const workflowStates: WorkflowStateSpec[] = [
  state(
    THETA_WORKFLOW_STATES.intake,
    "Build a strict ResearchBrief and detect blocking information gaps.",
  ),
  state(
    THETA_WORKFLOW_STATES.awaitResearchClarification,
    "Interpret natural answers and wait for blocking research clarification.",
    {
      allowedTools: [THETA_TOOL_IDS.conversationLanguage],
      allowedToolRefs: [toolRef(THETA_TOOL_IDS.conversationLanguage)],
      permissionScopes: [THETA_PERMISSION_SCOPES.inferenceUse],
      humanApprovalPolicyRef: toolRef(languageInferencePolicy.id),
      policyRefs: [languageInferencePolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.inspectDataset,
    "Resolve the registered dataset and collect bounded deterministic facts without persisting raw rows.",
    {
      allowedTools: [
        THETA_TOOL_IDS.datasetInspect,
        THETA_TOOL_IDS.datasetExplore,
        THETA_TOOL_IDS.datasetDetectColumns,
      ],
      allowedToolRefs: [
        toolRef(THETA_TOOL_IDS.datasetInspect),
        toolRef(THETA_TOOL_IDS.datasetExplore, "2.0.0"),
        toolRef(THETA_TOOL_IDS.datasetDetectColumns),
      ],
      permissionScopes: [THETA_PERMISSION_SCOPES.datasetRead],
      policyRefs: [readonlyPolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.analyzeDataset,
    "Build a bounded dataset understanding from governed, redacted dataset views.",
    {
      allowedTools: [
        THETA_TOOL_IDS.datasetExplore,
        THETA_TOOL_IDS.datasetUnderstandingLanguage,
      ],
      allowedToolRefs: [
        toolRef(THETA_TOOL_IDS.datasetExplore, "2.0.0"),
        toolRef(THETA_TOOL_IDS.datasetUnderstandingLanguage, "2.0.0"),
      ],
      permissionScopes: [
        THETA_PERMISSION_SCOPES.datasetRead,
        THETA_PERMISSION_SCOPES.inferenceUse,
      ],
      humanApprovalPolicyRef: toolRef(languageInferencePolicy.id),
      policyRefs: [readonlyPolicy.id, languageInferencePolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.awaitDatasetUnderstandingConfirmation,
    "Require confirmation or correction of the dataset domain, analysis unit and column roles.",
  ),
  state(
    THETA_WORKFLOW_STATES.researchIntentInterview,
    "Resolve only planning-relevant decision gaps without repeating answered questions.",
    {
      allowedTools: [THETA_TOOL_IDS.conversationLanguage],
      allowedToolRefs: [toolRef(THETA_TOOL_IDS.conversationLanguage)],
      permissionScopes: [THETA_PERMISSION_SCOPES.inferenceUse],
      humanApprovalPolicyRef: toolRef(languageInferencePolicy.id),
      policyRefs: [languageInferencePolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
    "Require explicit confirmation of the normalized research intent before planning.",
  ),
  state(
    THETA_WORKFLOW_STATES.awaitColumnConfirmation,
    "Require explicit confirmation of dataset column roles.",
    {
      allowedTools: [
        THETA_TOOL_IDS.datasetInspect,
        THETA_TOOL_IDS.conversationLanguage,
      ],
      allowedToolRefs: [
        toolRef(THETA_TOOL_IDS.datasetInspect),
        toolRef(THETA_TOOL_IDS.conversationLanguage),
      ],
      permissionScopes: [
        THETA_PERMISSION_SCOPES.datasetRead,
        THETA_PERMISSION_SCOPES.inferenceUse,
      ],
      humanApprovalPolicyRef: toolRef(languageInferencePolicy.id),
      policyRefs: [readonlyPolicy.id, languageInferencePolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.recommendModel,
    "Recommend a model from the sanitized profile.",
    {
      allowedTools: [
        THETA_TOOL_IDS.modelCatalog,
        THETA_TOOL_IDS.ragSearch,
        THETA_TOOL_IDS.modelRecommend,
        THETA_TOOL_IDS.planPropose,
      ],
      allowedToolRefs: [
        toolRef(THETA_TOOL_IDS.modelCatalog),
        toolRef(THETA_TOOL_IDS.ragSearch, "1.1.0"),
        toolRef(THETA_TOOL_IDS.modelRecommend, "2.0.0"),
        toolRef(THETA_TOOL_IDS.planPropose, "2.0.0"),
      ],
      permissionScopes: [
        THETA_PERMISSION_SCOPES.modelRead,
        THETA_PERMISSION_SCOPES.datasetRead,
        THETA_PERMISSION_SCOPES.ragRead,
        THETA_PERMISSION_SCOPES.planRead,
        THETA_PERMISSION_SCOPES.inferenceUse,
      ],
      policyRefs: [readonlyPolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.validatePlan,
    "Validate the candidate plan deterministically.",
    {
      allowedTools: [THETA_TOOL_IDS.planValidate],
      allowedToolRefs: [toolRef(THETA_TOOL_IDS.planValidate, "2.0.0")],
      permissionScopes: [
        THETA_PERMISSION_SCOPES.planRead,
        THETA_PERMISSION_SCOPES.modelRead,
      ],
      policyRefs: [readonlyPolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.awaitPlanCreationApproval,
    "HumanPlanReview: confirm the research goal, dataset hash, columns, model, parameters, warnings, and evidence.",
  ),
  state(
    THETA_WORKFLOW_STATES.createPlan,
    "Create the approved canonical training plan.",
    {
      allowedTools: [THETA_TOOL_IDS.planCreate],
      allowedToolRefs: [toolRef(THETA_TOOL_IDS.planCreate, "3.0.0")],
      permissionScopes: [THETA_PERMISSION_SCOPES.planWrite],
      humanApprovalPolicyRef: toolRef(stateWritePolicy.id),
      policyRefs: [stateWritePolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.dryRun,
    "Derive commands and expected artifacts without execution.",
    {
      allowedTools: [THETA_TOOL_IDS.trainingDryRun],
      allowedToolRefs: [toolRef(THETA_TOOL_IDS.trainingDryRun, "2.0.0")],
      permissionScopes: [
        THETA_PERMISSION_SCOPES.planRead,
        THETA_PERMISSION_SCOPES.trainingRead,
      ],
      policyRefs: [readonlyPolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.awaitTrainingStartApproval,
    "HumanTrainingReview: confirm the dry-run command summary, device, working directory, downloads, writes, and plan hash.",
  ),
  state(
    THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining,
    "Recompute the dataset hash before applying the training approval.",
    {
      allowedTools: [THETA_TOOL_IDS.datasetInspect],
      allowedToolRefs: [toolRef(THETA_TOOL_IDS.datasetInspect)],
      permissionScopes: [THETA_PERMISSION_SCOPES.datasetRead],
      policyRefs: [readonlyPolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.startTraining,
    "Start training through the governed THETA tools.",
    {
      allowedTools: [THETA_TOOL_IDS.trainingStart],
      allowedToolRefs: [toolRef(THETA_TOOL_IDS.trainingStart, "3.1.0")],
      permissionScopes: [THETA_PERMISSION_SCOPES.trainingWrite],
      humanApprovalPolicyRef: toolRef(trainingControlPolicy.id),
      policyRefs: [trainingControlPolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.monitorTraining,
    "Read training status until a terminal result.",
    {
      allowedTools: [
        THETA_TOOL_IDS.trainingStatus,
        THETA_TOOL_IDS.trainingCancel,
      ],
      allowedToolRefs: [
        toolRef(THETA_TOOL_IDS.trainingStatus, "2.0.0"),
        toolRef(THETA_TOOL_IDS.trainingCancel, "2.0.0"),
      ],
      permissionScopes: [
        THETA_PERMISSION_SCOPES.trainingRead,
        THETA_PERMISSION_SCOPES.trainingWrite,
      ],
      policyRefs: [readonlyPolicy.id, trainingControlPolicy.id],
    },
  ),
  state(
    THETA_WORKFLOW_STATES.evaluate,
    "Evaluate governed training outputs against the approved research intent and plan.",
  ),
  state(
    THETA_WORKFLOW_STATES.visualize,
    "Bind verified result artifacts and visualization metadata to the current Run.",
  ),
  state(
    THETA_WORKFLOW_STATES.completed,
    "Return the verified training result.",
  ),
  state(THETA_WORKFLOW_STATES.failed, "Record a normalized failure and stop."),
  state(THETA_WORKFLOW_STATES.cancelled, "Record cancellation and stop."),
  state(
    THETA_WORKFLOW_STATES.quarantined,
    "Stop automatic execution when training state cannot be reconciled safely.",
  ),
];

const forwardTransitions = [
  [
    THETA_WORKFLOW_STATES.intake,
    THETA_WORKFLOW_STATES.awaitResearchClarification,
  ],
  [THETA_WORKFLOW_STATES.intake, THETA_WORKFLOW_STATES.inspectDataset],
  [
    THETA_WORKFLOW_STATES.awaitResearchClarification,
    THETA_WORKFLOW_STATES.inspectDataset,
  ],
  [
    THETA_WORKFLOW_STATES.awaitResearchClarification,
    THETA_WORKFLOW_STATES.awaitResearchClarification,
  ],
  [
    THETA_WORKFLOW_STATES.inspectDataset,
    THETA_WORKFLOW_STATES.analyzeDataset,
  ],
  [
    THETA_WORKFLOW_STATES.analyzeDataset,
    THETA_WORKFLOW_STATES.awaitDatasetUnderstandingConfirmation,
  ],
  [
    THETA_WORKFLOW_STATES.awaitDatasetUnderstandingConfirmation,
    THETA_WORKFLOW_STATES.analyzeDataset,
  ],
  [
    THETA_WORKFLOW_STATES.awaitDatasetUnderstandingConfirmation,
    THETA_WORKFLOW_STATES.researchIntentInterview,
  ],
  [
    THETA_WORKFLOW_STATES.researchIntentInterview,
    THETA_WORKFLOW_STATES.researchIntentInterview,
  ],
  [
    THETA_WORKFLOW_STATES.researchIntentInterview,
    THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
  ],
  [
    THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
    THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
  ],
  [
    THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
    THETA_WORKFLOW_STATES.researchIntentInterview,
  ],
  [
    THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
    THETA_WORKFLOW_STATES.recommendModel,
  ],
  [
    THETA_WORKFLOW_STATES.inspectDataset,
    THETA_WORKFLOW_STATES.awaitColumnConfirmation,
  ],
  [
    THETA_WORKFLOW_STATES.inspectDataset,
    THETA_WORKFLOW_STATES.awaitResearchClarification,
  ],
  [
    THETA_WORKFLOW_STATES.awaitColumnConfirmation,
    THETA_WORKFLOW_STATES.inspectDataset,
  ],
  [
    THETA_WORKFLOW_STATES.awaitColumnConfirmation,
    THETA_WORKFLOW_STATES.recommendModel,
  ],
  [THETA_WORKFLOW_STATES.recommendModel, THETA_WORKFLOW_STATES.validatePlan],
  [
    THETA_WORKFLOW_STATES.recommendModel,
    THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
  ],
  [
    THETA_WORKFLOW_STATES.validatePlan,
    THETA_WORKFLOW_STATES.awaitPlanCreationApproval,
  ],
  [
    THETA_WORKFLOW_STATES.awaitPlanCreationApproval,
    THETA_WORKFLOW_STATES.createPlan,
  ],
  [
    THETA_WORKFLOW_STATES.awaitPlanCreationApproval,
    THETA_WORKFLOW_STATES.validatePlan,
  ],
  [
    THETA_WORKFLOW_STATES.awaitPlanCreationApproval,
    THETA_WORKFLOW_STATES.recommendModel,
  ],
  [THETA_WORKFLOW_STATES.createPlan, THETA_WORKFLOW_STATES.dryRun],
  [
    THETA_WORKFLOW_STATES.dryRun,
    THETA_WORKFLOW_STATES.awaitTrainingStartApproval,
  ],
  [
    THETA_WORKFLOW_STATES.awaitTrainingStartApproval,
    THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining,
  ],
  [
    THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining,
    THETA_WORKFLOW_STATES.startTraining,
  ],
  [
    THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining,
    THETA_WORKFLOW_STATES.inspectDataset,
  ],
  [THETA_WORKFLOW_STATES.startTraining, THETA_WORKFLOW_STATES.monitorTraining],
  [THETA_WORKFLOW_STATES.monitorTraining, THETA_WORKFLOW_STATES.evaluate],
  [THETA_WORKFLOW_STATES.evaluate, THETA_WORKFLOW_STATES.visualize],
  [THETA_WORKFLOW_STATES.visualize, THETA_WORKFLOW_STATES.completed],
  [THETA_WORKFLOW_STATES.monitorTraining, THETA_WORKFLOW_STATES.completed],
  [THETA_WORKFLOW_STATES.monitorTraining, THETA_WORKFLOW_STATES.cancelled],
  [THETA_WORKFLOW_STATES.monitorTraining, THETA_WORKFLOW_STATES.quarantined],
] as const;

const failureTransitions = workflowStates
  .map((item) => item.id)
  .filter(
    (id) =>
      ![
        THETA_WORKFLOW_STATES.completed,
        THETA_WORKFLOW_STATES.failed,
        THETA_WORKFLOW_STATES.cancelled,
        THETA_WORKFLOW_STATES.quarantined,
      ].includes(id as never),
  )
  .map((from) => ({ from, to: THETA_WORKFLOW_STATES.failed }));

export const createResearchAgentDomainPack = (
  toolSpecs: readonly ToolSpec[],
): DomainPackSpec => validateDomainPackSpec({
  id: THETA_DOMAIN_PACK_ID,
  version: THETA_DOMAIN_PACK_VERSION,
  name: "Conversational Auto-Research Domain",
  description:
    "A governed conversational research workflow with pluggable execution tools.",
  taskSchemas: [
    {
      id: "task.theta.training",
      version: "1.0.0",
      taskType: "theta.training",
      inputSchema: {
        type: "object",
        required: ["filePath"],
        properties: {
          filePath: { type: "string", minLength: 1 },
          datasetRef: { type: "string", minLength: 1 },
          datasetId: { type: "string" },
          workflowVersion: { enum: ["1.0.0", "2.0.0"] },
          researchGoal: { type: "string" },
          research: {
            type: "object",
            properties: {
              researchQuestion: { type: "string", minLength: 1 },
              researchDomain: { type: "string", minLength: 1 },
              domainConfirmed: { type: "boolean" },
              dataSources: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              collectionMethod: { type: "string", minLength: 1 },
              analysisUnit: { type: "string", minLength: 1 },
              timeRange: {
                type: "object",
                properties: {
                  start: { type: "string", minLength: 1 },
                  end: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
              language: { type: "string", minLength: 1 },
              comparisonGroups: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              topicGranularity: { enum: ["broad", "medium", "fine"] },
              knownBiases: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              sensitiveData: {
                type: "object",
                required: ["status"],
                properties: {
                  status: { enum: ["yes", "no", "unknown"] },
                  categories: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                  },
                },
                additionalProperties: false,
              },
              successCriteria: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              hardwareLimit: {
                type: "object",
                required: ["device"],
                properties: {
                  device: { enum: ["cpu", "gpu", "unknown"] },
                  memoryGb: { type: "number", exclusiveMinimum: 0 },
                },
                additionalProperties: false,
              },
              textFieldIntent: { type: "string", minLength: 1 },
              trendAnalysis: { type: "boolean" },
              offlineOnly: { type: "boolean" },
              requestedEmbedding: {
                enum: ["local", "remote", "none", "unknown"],
              },
              timeLimitHours: { type: "number", exclusiveMinimum: 0 },
              interviewComplete: { type: "boolean" },
              expectedRowCount: { type: "integer", minimum: 0 },
              candidateTimeColumns: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              candidateGroupColumns: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
            },
            additionalProperties: false,
          },
          constraints: { type: "object", additionalProperties: true },
          plan: { type: "object", additionalProperties: true },
          sampleSize: { type: "integer", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
      outputContractRef: "output.theta.training",
      defaultWorkflowRef: THETA_WORKFLOW_ID,
      riskProfile: {
        defaultRiskLevel: "high",
        escalationPolicyRef: trainingControlPolicy.id,
      },
    },
  ],
  outputContracts: [
    {
      id: "output.theta.training",
      version: "1.0.0",
      schema: {
        type: "object",
        required: ["runId", "status", "modelId", "planId", "trainingRunId"],
        properties: {
          runId: { type: "string" },
          status: { type: "string" },
          modelId: { type: "string" },
          planId: { type: "string" },
          trainingRunId: { type: "string" },
          artifacts: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
        additionalProperties: true,
      },
    },
  ],
  sessionProfiles: [
    {
      id: "session.theta.local",
      version: "1.0.0",
      defaultMetadata: { runtimeMode: "single-user", surface: "cli" },
      defaultPolicyRefs: [
        readonlyPolicy.id,
        stateWritePolicy.id,
        trainingControlPolicy.id,
        languageInferencePolicy.id,
      ],
    },
  ],
  workflows: [
    {
      id: THETA_WORKFLOW_ID,
      version: THETA_WORKFLOW_VERSION,
      initialState: THETA_WORKFLOW_STATES.intake,
      terminalStates: [
        THETA_WORKFLOW_STATES.completed,
        THETA_WORKFLOW_STATES.failed,
        THETA_WORKFLOW_STATES.cancelled,
        THETA_WORKFLOW_STATES.quarantined,
      ],
      states: workflowStates,
      transitions: [
        ...forwardTransitions.map(([from, to]) => ({ from, to })),
        ...failureTransitions,
      ],
    },
  ],
  defaultWorkflow: THETA_WORKFLOW_ID,
  allowedSkills: [
    { id: "context-enrichment", version: "1.0.0" },
    { id: "intent-classification", version: "1.0.0" },
    { id: "skill.research-intake", version: "1.0.0" },
    { id: "skill.dataset-understanding", version: "1.0.0" },
    { id: "skill.research-planning", version: "1.0.0" },
    { id: "skill.topic-modeling", version: "1.0.0" },
  ],
  defaultSkills: [
    { id: "context-enrichment", version: "1.0.0" },
    { id: "intent-classification", version: "1.0.0" },
    { id: "skill.research-intake", version: "1.0.0" },
    { id: "skill.dataset-understanding", version: "1.0.0" },
    { id: "skill.research-planning", version: "1.0.0" },
    { id: "skill.topic-modeling", version: "1.0.0" },
  ],
  skillPolicies: [
    {
      id: "skill-policy.research-agent",
      version: "1.0.0",
      skillRef: { id: "skill.research-intake", version: "1.0.0" },
      policyRefs: [readonlyPolicy.id],
      allowedTools: [THETA_TOOL_IDS.conversationLanguage],
      trustLevel: "reviewed",
    },
    {
      id: "skill-policy.dataset-understanding",
      version: "1.0.0",
      skillRef: { id: "skill.dataset-understanding", version: "1.0.0" },
      policyRefs: [readonlyPolicy.id],
      allowedTools: [
        THETA_TOOL_IDS.datasetInspect,
        THETA_TOOL_IDS.datasetExplore,
        THETA_TOOL_IDS.datasetDetectColumns,
      ],
      trustLevel: "reviewed",
    },
    {
      id: "skill-policy.research-planning",
      version: "1.0.0",
      skillRef: { id: "skill.research-planning", version: "1.0.0" },
      policyRefs: [readonlyPolicy.id],
      allowedTools: [
        THETA_TOOL_IDS.modelCatalog,
        THETA_TOOL_IDS.modelRecommend,
        THETA_TOOL_IDS.ragSearch,
        THETA_TOOL_IDS.planPropose,
        THETA_TOOL_IDS.planValidate,
      ],
      trustLevel: "reviewed",
    },
    {
      id: "skill-policy.topic-modeling",
      version: "1.0.0",
      skillRef: { id: "skill.topic-modeling", version: "1.0.0" },
      policyRefs: [readonlyPolicy.id, trainingControlPolicy.id],
      allowedTools: [
        THETA_TOOL_IDS.trainingDryRun,
        THETA_TOOL_IDS.trainingStart,
        THETA_TOOL_IDS.trainingStatus,
        THETA_TOOL_IDS.trainingCancel,
      ],
      trustLevel: "reviewed",
    },
  ],
  tools: [...toolSpecs],
  policies: [
    readonlyPolicy,
    stateWritePolicy,
    trainingControlPolicy,
    languageInferencePolicy,
  ],
  evaluationProfiles: [
    {
      id: "eval.theta.output-contract",
      version: "1.0.0",
      type: "output_contract",
      deterministic: true,
    },
  ],
  regressionCases: [
    {
      id: "regression.theta.training",
      version: "1.0.0",
      fixtureRefs: [{ id: "fixture.theta.training", version: "1.0.0" }],
      requiredChecks: [
        "event_types",
        "state_path",
        "tool_calls",
        "policy_decisions",
        "output_contract",
      ],
    },
  ],
  deploymentProfile: {
    id: "deployment.theta.local",
    version: "1.0.0",
    mode: "local",
    runtimeMode: "single-user",
  },
});

export const compileResearchAgentDomain = (
  toolSpecs: readonly ToolSpec[],
): DomainCompilationResult =>
  compileDomainPackToHarnessedSystem(createResearchAgentDomainPack(toolSpecs), {
    agentRef: THETA_AGENT_REF,
    taskSchemaId: "task.theta.training",
    workflowId: THETA_WORKFLOW_ID,
    sessionProfileId: "session.theta.local",
    evaluationRefs: ["eval.theta.output-contract"],
    metadata: { owner: "theta-agent" },
  });

export const compileThetaTrainingDomain = compileResearchAgentDomain;

export const resolveThetaStateToolScope = (
  compilation: DomainCompilationResult,
  stateId: string,
): ToolExecutionScope =>
  resolveWorkflowToolExecutionScope(
    compilation.bindings.workflowStates,
    stateId,
  );
