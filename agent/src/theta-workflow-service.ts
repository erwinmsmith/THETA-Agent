import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createRuntimeOrchestrationProjectionDefinition } from "@hypha/core";
import type {
  EventCreateInput,
  FrameworkEvent,
  PersistedFrameworkEvent,
  RuntimeJsonValue,
  RuntimeOrchestrationProjection,
  RuntimeScope,
} from "@hypha/core";
import type {
  BoundedFSMDriverResult,
  BoundedStateExecutionDecision,
  BoundedStateExecutorInput,
} from "@hypha/harness";
import type { ToolCallResult } from "@hypha/tools";
import { decideResearchGrilling } from "./research/grilling-engine.js";
import {
  RESEARCH_CONTRACT_VERSION,
  columnConfirmationDraftSchema,
  columnConfirmationSchema,
  datasetProfileSchema,
  researchBriefPatchSchema,
  researchBriefSchema,
  type ColumnConfirmationDraft,
  type DatasetProfile,
  type ResearchBrief,
} from "@theta-agent/domain/research/contracts.js";
import {
  ResearchService,
  type ResearchAssessment,
} from "./research/research-service.js";
import {
  applyDecisionGapDefaults,
  applyDecisionGapAnswer,
  createInitialResearchIntent,
  deriveDecisionGaps,
  emptyInterviewMemory,
  interviewMemorySchema,
  isAutonomousDelegationAnswer,
  selectNextDecisionGap,
  type DecisionGap,
  type InterviewMemory,
} from "./research/decision-gap.js";
import { ResearchIntentInterpreter } from './research/research-intent-interpreter.js';
import {
  buildResearchIntentSummary,
  researchIntentSummarySchema,
  type ResearchIntentSummary,
} from './research/research-intent-summary.js';
import {
  datasetConfirmationDraftSchema,
  datasetConfirmationSchema,
  datasetFactsSchema,
  datasetUnderstandingDraftSchema,
  researchIntentSchema,
  type DatasetConfirmationDraft,
  type DatasetConfirmation,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
  type ResearchIntent,
} from "@theta-agent/domain/dataset-understanding/contracts.js";
import {
  buildDatasetFacts,
  buildDeterministicUnderstanding,
} from "./dataset-understanding/service.js";
import {
  DatasetUnderstandingLanguageLoop,
  type DatasetUnderstandingLanguageLoopResult,
} from './dataset-understanding/language-loop.js';
import {
  assertDatasetConfirmation,
  validateDatasetUnderstanding,
} from './dataset-understanding/validator.js';
import {
  approvalReceiptSchema,
  canonicalExperimentProtocolSchema,
  dryRunReceiptSchema,
  trainingPlanRecordSchema,
} from "@theta-agent/domain/planning/contracts.js";
import {
  assertApprovalChain,
  createApprovalReceipt,
} from "@theta-agent/tools/support/planning/engine.js";
import {
  applyUserParameterOverrides,
  applyValidatorParameterCorrections,
  parameterDecisionsFromResolution,
} from "./planning/parameter-decisions.js";
import {
  THETA_APPROVAL_KEYS,
  THETA_DOMAIN_PACK_ID,
  THETA_DOMAIN_PACK_VERSION,
  THETA_WORKFLOW_STATES,
  compileThetaTrainingDomain,
  resolveThetaStateToolScope,
} from "@theta-agent/domain/domain.js";
import {
  JsonlToolTraceRecorder,
  createThetaWorkflowRuntime,
  defaultThetaWorkflowDb,
  thetaToolTraceFile,
} from "./runtime/hypha-runtime.js";
import {
  createThetaGovernedToolRunner,
  createThetaToolCallContext,
} from "@theta-agent/tools/hypha-runner.js";
import { thetaHyphaToolSpecs } from "@theta-agent/tools/registry/tool-registry.js";
import type { ThetaTrainingPlan } from "@theta-agent/tools/plan-validate-tool.js";
import type { ThetaDatasetExploreOutput } from "@theta-agent/tools/dataset-explore-tool.js";
import type { DatasetUnderstandingLanguageResult } from '@theta-agent/tools/dataset-understanding-language-tool.js';
import { THETA_TOOL_IDS } from "@theta-agent/tools/tool-ids.js";
import { SQLiteDatasetRegistry } from "@theta-agent/tools/support/storage/dataset-registry.js";
import { SQLiteV2ResearchStore } from "./storage/v2-research-store.js";
import { recommendationResultSchema } from "@theta-agent/domain/recommendation/contracts.js";
import { planProposalResultSchema } from "@theta-agent/domain/planner/contracts.js";
import { comparePlannerInputSnapshots } from '@theta-agent/tools/support/planner/input-snapshot.js';
import { resolvePlannerProposal } from "./planner/resolver.js";
import {
  buildPlannerInputV2,
} from './planner/v2-runtime.js';
import {
  plannerDecisionV2Schema,
  plannerInputV2Schema,
} from '@theta-agent/domain/planner/v2-contracts.js';
import { presentPlanV2 } from './planner/v2-presenter.js';
import { validatePlannerDecisionV2 } from '@theta-agent/tools/support/planner/v2-validator.js';
import { evidenceRefSchema } from "@theta-agent/domain/rag/contracts.js";
import {
  buildEvidenceBundle,
  planEvidenceQueriesV2,
  planCandidateEvidenceQueries,
  planEvidenceQueries,
  type EvidenceQuery,
  type EvidenceQueryExecution,
  type PlanEvidenceQueryInput,
} from "@theta-agent/tools/support/rag/evidence-bundle.js";
import type { RetrievalTrace } from "@theta-agent/tools/support/rag/fts-index.js";
import {
  deriveWorkflowMetricsV2,
  resolveWorkflowVersion,
  workflowVersionSchema,
  type WorkflowMetricsV2,
  type WorkflowVersion,
} from './acceptance/v2-acceptance.js';

const USER_ID = "local_user";
const WORKSPACE_ID = "local_workspace";
const AGENT_ID = "agent.theta.cli";
const DRIVER_OWNER = "theta-cli-workflow-driver";
// A single RecommendModel state can include multiple local RAG searches plus one
// bounded provider request. Keep its fenced lease/claim longer than the provider
// timeout so a healthy, slow planning turn is not mistaken for a dead worker.
const LEASE_TTL_MS = 10 * 60_000;
// Governed Planner calls can legally run for 180 seconds and may perform a
// repair turn. The claim must outlive the whole bounded state execution.
const STATE_CLAIM_TTL_MS = 10 * 60_000;
const MAX_STEPS = 64;

export interface ThetaWorkflowInput {
  filePath: string;
  datasetRef?: string;
  workflowVersion?: "1.0.0" | "2.0.0";
  datasetId?: string;
  researchGoal?: string;
  research?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  sampleSize?: number;
  plannerMode?: "deterministic" | "minimax";
  allowRemoteSamples?: boolean;
  recoveredResearchIntent?: Record<string, unknown>;
  recoveryOfRunId?: string;
  recoveryReason?: string;
}

export interface ThetaWorkflowRunRequest {
  input: ThetaWorkflowInput;
  runId?: string;
  runtimeDb?: string;
  approvalKeys?: readonly string[];
  approvedBy?: string;
}

export interface ThetaWorkflowResumeRequest {
  runId: string;
  runtimeDb?: string;
  approve?: boolean;
  reject?: boolean;
  approvedBy?: string;
  approvalKeys?: readonly string[];
  researchAnswers?: Record<string, unknown>;
  columnConfirmation?: ColumnConfirmationDraft;
  datasetConfirmation?: DatasetConfirmationDraft;
  decisionAnswer?: string;
  planAdjustment?: Record<string, unknown>;
}

export interface ThetaWorkflowToolRequest {
  toolId: string;
  input: Record<string, unknown>;
  runId: string;
  sessionId: string;
  stateId: string;
  stateAttempt: number;
  approvedBy?: string;
}

export interface ThetaWorkflowToolPort {
  invoke(request: ThetaWorkflowToolRequest): Promise<Record<string, unknown>>;
  listTrace(runId: string): Promise<FrameworkEvent[]>;
}

export interface ThetaWorkflowRunResult {
  runId: string;
  runtimeDb: string;
  disposition: BoundedFSMDriverResult["disposition"];
  status: RuntimeOrchestrationProjection["runStatus"];
  currentState?: string;
  pendingActionRef?: string;
  pendingReason?: string;
  statePath: string[];
  output?: RuntimeJsonValue;
  trainingReceipt?: RuntimeJsonValue;
}

export interface ThetaWorkflowStatus {
  runId: string;
  runtimeDb: string;
  status: RuntimeOrchestrationProjection["runStatus"];
  currentState?: string;
  pendingActionRef?: string;
  pendingReason?: string;
  statePath: string[];
  eventCount: number;
  lastEventType: string;
  lastEventAt: string;
  output?: RuntimeJsonValue;
  trainingReceipt?: RuntimeJsonValue;
  workflowVersion?: WorkflowVersion;
  metrics?: WorkflowMetricsV2;
  researchIntentSummary?: ResearchIntentSummary;
}

export interface ThetaWorkflowEvidence {
  runId: string;
  runtimeDb: string;
  orchestrationEvents: PersistedFrameworkEvent[];
  toolEvents: FrameworkEvent[];
}

export interface ThetaWorkflowConversationContext {
  status: ThetaWorkflowStatus;
  researchBrief?: ResearchBrief;
  researchAssessment?: Record<string, unknown>;
  datasetProfile?: DatasetProfile;
  datasetFacts?: DatasetFacts;
  datasetUnderstanding?: DatasetUnderstandingDraft;
  datasetUnderstandingMeta?: Record<string, unknown>;
  remoteSampleReceipt?: Record<string, unknown>;
  datasetConfirmation?: DatasetConfirmation;
  researchIntent?: ResearchIntent;
  interviewMemory?: InterviewMemory;
  decisionGap?: DecisionGap;
  researchIntentSummary?: ResearchIntentSummary;
}

export interface ThetaWorkflowPlan {
  runId: string;
  runtimeDb: string;
  source: 'canonical_events';
  currentState?: string;
  pendingActionRef?: string;
  pendingReason?: string;
  approvalReady: boolean;
  candidatePlan?: RuntimeJsonValue;
  validatedPlan?: RuntimeJsonValue;
  planRecord?: RuntimeJsonValue;
  planReview?: RuntimeJsonValue;
  recommendation?: RuntimeJsonValue;
  evidenceBundle?: RuntimeJsonValue;
  planProposal?: RuntimeJsonValue;
  plannerResolution?: RuntimeJsonValue;
  validation?: RuntimeJsonValue;
  planAdjustment?: RuntimeJsonValue;
  datasetProfile?: RuntimeJsonValue;
  columnConfirmation?: RuntimeJsonValue;
  dryRun?: RuntimeJsonValue;
  trainingReview?: RuntimeJsonValue;
  trainingReceipt?: RuntimeJsonValue;
  researchBrief?: RuntimeJsonValue;
  datasetFacts?: RuntimeJsonValue;
  datasetUnderstanding?: RuntimeJsonValue;
  datasetConfirmation?: RuntimeJsonValue;
  researchIntent?: RuntimeJsonValue;
  researchIntentSummary?: RuntimeJsonValue;
  plannerInputV2?: RuntimeJsonValue;
  plannerDecisionV2?: RuntimeJsonValue;
  plannerValidationV2?: RuntimeJsonValue;
  plannerPresentationV2?: RuntimeJsonValue;
}

export interface ThetaWorkflowReplay {
  runId: string;
  eventTypes: string[];
  statePath: string[];
  toolCalls: string[];
  policyDecisions: string[];
  output?: RuntimeJsonValue;
  digest: string;
}

export interface ThetaWorkflowServiceOptions {
  toolPort?: ThetaWorkflowToolPort;
  now?: () => string;
}

class GovernedThetaWorkflowToolPort implements ThetaWorkflowToolPort {
  private readonly runner;

  constructor(
    private readonly runtimeDb: string,
    private readonly trace: JsonlToolTraceRecorder,
  ) {
    this.runner = createThetaGovernedToolRunner(trace);
  }

  async invoke(
    request: ThetaWorkflowToolRequest,
  ): Promise<Record<string, unknown>> {
    const compilation = compileThetaTrainingDomain(thetaHyphaToolSpecs);
    const executionScope = resolveThetaStateToolScope(
      compilation,
      request.stateId,
    );
    const binding = compilation.bindings.workflowStates.find(
      (candidate) => candidate.stateId === request.stateId,
    );
    const invocationId = invocationKey(request);
    const context = {
      ...createThetaToolCallContext(request.runId, request.stateId, {
        invocationId,
        idempotencyKey: invocationId,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        permissionScopes: binding?.permissionScopes ?? [],
      }),
      sessionId: request.sessionId,
      agentId: AGENT_ID,
      fsmState: request.stateId,
      executionScope,
      operationId: `theta-workflow:${request.stateId}:${request.stateAttempt}`,
      correlationId: request.runId,
      metadata: {
        source: "theta-agent",
        thetaRuntimeDb: this.runtimeDb,
      },
    };
    let result = await this.runner.run({
      toolId: request.toolId,
      input: request.input,
      context,
    });
    if (result.status === "human_review_required" && request.approvedBy) {
      result = await this.runner.approveAndResume(
        invocationId,
        request.approvedBy,
      );
    }
    return completedOutput(request.toolId, result);
  }

  listTrace(runId: string): Promise<FrameworkEvent[]> {
    return this.trace.list({ runId });
  }
}

export class ThetaWorkflowService {
  private readonly now: () => string;

  constructor(private readonly options: ThetaWorkflowServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  compileSummary(): Record<string, unknown> {
    const compilation = compileThetaTrainingDomain(thetaHyphaToolSpecs);
    return {
      domainPack: `${compilation.domainPack.id}@${compilation.domainPack.version}`,
      workflow: `${compilation.workflowRef.id}@${compilation.workflowRef.version}`,
      processHash: compilation.processHash,
      compilationHash: compilation.audit.compilationHash,
      initialState: compilation.fsmProcess.initialState,
      terminalStates: compilation.fsmProcess.terminalStates,
      stateCount: compilation.fsmProcess.states.length,
      toolRefs: compilation.dependencySnapshot.toolRefs.map((ref) => ref.id),
    };
  }

  async run(request: ThetaWorkflowRunRequest): Promise<ThetaWorkflowRunResult> {
    const runId = request.runId?.trim() || `theta-run-${randomUUID()}`;
    const runtimeDb = path.resolve(
      request.runtimeDb ?? defaultThetaWorkflowDb(),
    );
    const input = await prepareWorkflowInput(request.input, runtimeDb);
    validateInput(input);
    const scope = runtimeScope(runId);
    const runtime = await createThetaWorkflowRuntime({ filename: runtimeDb });
    try {
      await seedRun(runtime.events, scope, input, this.now());
      const result = await this.drive(
        runtime,
        scope,
        this.toolPort(runtimeDb, runId),
        request.approvalKeys ?? [],
        request.approvedBy ?? USER_ID,
      );
      await syncV2ResearchReadModel(
        runtimeDb,
        runId,
        await hydrateVariables(runtime.events, scope),
      );
      return result;
    } finally {
      runtime.close();
    }
  }

  async resume(
    request: ThetaWorkflowResumeRequest,
  ): Promise<ThetaWorkflowRunResult> {
    const runId = required(request.runId, "runId");
    const runtimeDb = path.resolve(
      request.runtimeDb ?? defaultThetaWorkflowDb(),
    );
    const scope = runtimeScope(runId);
    const runtime = await createThetaWorkflowRuntime({ filename: runtimeDb });
    try {
      await runtime.timers.sweep({
        ownerId: `${DRIVER_OWNER}:timer`,
        leaseTtlMs: LEASE_TTL_MS,
        limit: 100,
        firedAt: this.now(),
      });
      const tools = this.toolPort(runtimeDb, runId);
      let result = await this.runDriver(runtime, scope, tools);
      const hasResearchAnswers = request.researchAnswers !== undefined;
      const hasColumnConfirmation = request.columnConfirmation !== undefined;
      const hasDatasetConfirmation = request.datasetConfirmation !== undefined;
      const hasDecisionAnswer = request.decisionAnswer !== undefined;
      const hasPlanAdjustment = request.planAdjustment !== undefined;
      if (
        [
          hasResearchAnswers,
          hasColumnConfirmation,
          hasDatasetConfirmation,
          hasDecisionAnswer,
          hasPlanAdjustment,
        ].filter(Boolean).length > 1
      ) {
        throw new Error(
          "A resume command can submit only one structured response.",
        );
      }
      if (
        hasResearchAnswers ||
        hasColumnConfirmation ||
        hasDatasetConfirmation ||
        hasDecisionAnswer ||
        hasPlanAdjustment
      ) {
        await this.recordStructuredResumeInput(
          runtime,
          scope,
          result.projection,
          request,
        );
      }
      if (
        request.approve &&
        !hasResearchAnswers &&
        !hasColumnConfirmation &&
        !hasDatasetConfirmation &&
        !hasDecisionAnswer &&
        !hasPlanAdjustment &&
        requiresStructuredHumanInput(
          result.projection.pendingWait?.pendingActionRef,
        )
      ) {
        throw new Error(
          "This human wait requires structured input instead of a bare approval.",
        );
      }
      if (
        result.disposition === "waiting" &&
        result.projection.pendingWait?.type === "human" &&
        (request.approve ||
          request.reject ||
          hasResearchAnswers ||
          hasColumnConfirmation ||
          hasDatasetConfirmation ||
          hasDecisionAnswer ||
          hasPlanAdjustment)
      ) {
        await this.resolveHumanWait(
          runtime,
          scope,
          result.projection,
          request.reject ? "rejected" : "approved",
          request.approvedBy ?? USER_ID,
        );
        result = await this.runDriver(runtime, scope, tools);
      }
      result = await this.autoApprove(
        runtime,
        scope,
        tools,
        result,
        new Set(request.approvalKeys ?? []),
        request.approvedBy ?? USER_ID,
      );
      const runResult = toRunResult(
        runId,
        runtimeDb,
        result,
        await terminalOutput(runtime, scope),
      );
      const variables = await hydrateVariables(runtime.events, scope);
      await syncV2ResearchReadModel(runtimeDb, runId, variables);
      const currentEvents = await runtime.events.read({ scope: streamScope(scope) });
      const liveTrainingReceipt =
        result.projection.pendingWait?.type === "timer"
          ? latestTimerReceipt(currentEvents) ?? variables.trainingReceipt
          : variables.trainingReceipt;
      return {
        ...runResult,
        ...(liveTrainingReceipt === undefined
          ? {}
          : {
              trainingReceipt: sanitizeRuntimeValue(
                liveTrainingReceipt,
              ),
            }),
      };
    } finally {
      runtime.close();
    }
  }

  async status(
    runId: string,
    runtimeDb = defaultThetaWorkflowDb(),
  ): Promise<ThetaWorkflowStatus> {
    const resolvedRunId = required(runId, "runId");
    const resolvedDb = path.resolve(runtimeDb);
    const scope = runtimeScope(resolvedRunId);
    const runtime = await createThetaWorkflowRuntime({ filename: resolvedDb });
    try {
      const events = await runtime.events.read({
        scope: streamScope(scope),
      });
      const last = events.at(-1);
      if (!last) {
        throw new Error(`Run not found: ${resolvedRunId}`);
      }
      const projection = (
        await runtime.projections.update(
          createRuntimeOrchestrationProjectionDefinition(resolvedRunId),
          runtime.projectionStore,
          streamScope(scope),
        )
      ).state;
      const variables = await hydrateVariables(runtime.events, scope);
      const storedVersion = workflowVersionSchema.safeParse(
        stringProperty(variables.input, 'workflowVersion'),
      );
      const workflowVersion = resolveWorkflowVersion({
        isNewRun: false,
        ...(storedVersion.success ? { storedVersion: storedVersion.data } : {}),
      });
      const status = toStatusResult(
        resolvedRunId,
        resolvedDb,
        projection,
        events.length,
        last.type,
        last.timestamp,
        await terminalOutput(runtime, scope),
      );
      const liveTrainingReceipt =
        projection.pendingWait?.type === "timer"
          ? latestTimerReceipt(events) ?? variables.trainingReceipt
          : variables.trainingReceipt;
      const intentSummary = researchIntentSummarySchema.safeParse(
        variables.researchIntentSummary,
      );
      return {
        ...status,
        workflowVersion,
        metrics: deriveWorkflowMetricsV2({
          workflowVersion,
          events,
          variables,
        }),
        ...(intentSummary.success
          ? { researchIntentSummary: intentSummary.data }
          : {}),
        ...(liveTrainingReceipt === undefined
          ? {}
          : {
              trainingReceipt: sanitizeRuntimeValue(
                liveTrainingReceipt,
              ),
            }),
      };
    } finally {
      runtime.close();
    }
  }

  async evidence(
    runId: string,
    runtimeDb = defaultThetaWorkflowDb(),
  ): Promise<ThetaWorkflowEvidence> {
    const resolvedRunId = required(runId, "runId");
    const resolvedDb = path.resolve(runtimeDb);
    const runtime = await createThetaWorkflowRuntime({ filename: resolvedDb });
    try {
      const orchestrationEvents = await runtime.events.read({
        scope: streamScope(runtimeScope(resolvedRunId)),
      });
      return {
        runId: resolvedRunId,
        runtimeDb: resolvedDb,
        orchestrationEvents,
        toolEvents: await this.toolPort(resolvedDb, resolvedRunId).listTrace(
          resolvedRunId,
        ),
      };
    } finally {
      runtime.close();
    }
  }

  async conversationContext(
    runId: string,
    runtimeDb = defaultThetaWorkflowDb(),
  ): Promise<ThetaWorkflowConversationContext> {
    const resolvedRunId = required(runId, "runId");
    const resolvedDb = path.resolve(runtimeDb);
    const scope = runtimeScope(resolvedRunId);
    const runtime = await createThetaWorkflowRuntime({ filename: resolvedDb });
    try {
      const events = await runtime.events.read({
        scope: streamScope(scope),
      });
      const last = events.at(-1);
      if (!last) throw new Error(`Run not found: ${resolvedRunId}`);
      const projection = (
        await runtime.projections.update(
          createRuntimeOrchestrationProjectionDefinition(resolvedRunId),
          runtime.projectionStore,
          streamScope(scope),
        )
      ).state;
      const variables = await hydrateVariables(runtime.events, scope);
      return {
        status: toStatusResult(
          resolvedRunId,
          resolvedDb,
          projection,
          events.length,
          last.type,
          last.timestamp,
          await terminalOutput(runtime, scope),
        ),
        ...(isRecord(variables.researchBrief)
          ? {
              researchBrief: researchBriefSchema.parse(
                variables.researchBrief,
              ),
            }
          : {}),
        ...(isRecord(variables.researchAssessment)
          ? {
              researchAssessment: variables.researchAssessment,
            }
          : {}),
        ...(isRecord(variables.datasetProfile)
          ? {
              datasetProfile: datasetProfileSchema.parse(
                variables.datasetProfile,
              ),
            }
          : {}),
        ...(isRecord(variables.datasetFacts)
          ? { datasetFacts: datasetFactsSchema.parse(variables.datasetFacts) }
          : {}),
        ...(isRecord(variables.datasetUnderstanding)
          ? {
              datasetUnderstanding: datasetUnderstandingDraftSchema.parse(
                variables.datasetUnderstanding,
              ),
            }
          : {}),
        ...(isRecord(variables.datasetUnderstandingMeta)
          ? { datasetUnderstandingMeta: variables.datasetUnderstandingMeta }
          : {}),
        ...(isRecord(variables.remoteSampleReceipt)
          ? { remoteSampleReceipt: variables.remoteSampleReceipt }
          : {}),
        ...(isRecord(variables.datasetConfirmation)
          ? {
              datasetConfirmation: datasetConfirmationSchema.parse(
                variables.datasetConfirmation,
              ),
            }
          : {}),
        ...(isRecord(variables.researchIntent)
          ? { researchIntent: researchIntentSchema.parse(variables.researchIntent) }
          : {}),
        ...(isRecord(variables.researchIntentSummary)
          ? {
              researchIntentSummary: researchIntentSummarySchema.parse(
                variables.researchIntentSummary,
              ),
            }
          : {}),
        ...(isRecord(variables.interviewMemory)
          ? {
              interviewMemory: interviewMemorySchema.parse(
                variables.interviewMemory,
              ),
            }
          : {}),
        ...v2DecisionGapContext(variables),
      };
    } finally {
      runtime.close();
    }
  }

  async plan(
    runId: string,
    runtimeDb = defaultThetaWorkflowDb(),
  ): Promise<ThetaWorkflowPlan> {
    const resolvedRunId = required(runId, 'runId');
    const resolvedDb = path.resolve(runtimeDb);
    const scope = runtimeScope(resolvedRunId);
    const runtime = await createThetaWorkflowRuntime({ filename: resolvedDb });
    try {
      const events = await runtime.events.read({
        scope: streamScope(scope),
      });
      if (events.length === 0) {
        throw new Error(`Run not found: ${resolvedRunId}`);
      }
      const projection = (
        await runtime.projections.update(
          createRuntimeOrchestrationProjectionDefinition(resolvedRunId),
          runtime.projectionStore,
          streamScope(scope),
        )
      ).state;
      const variables = await hydrateVariables(runtime.events, scope);
      return {
        runId: resolvedRunId,
        runtimeDb: resolvedDb,
        source: 'canonical_events',
        ...(projection.currentState === undefined
          ? {}
          : { currentState: projection.currentState }),
        ...(projection.pendingWait?.pendingActionRef === undefined
          ? {}
          : {
              pendingActionRef: projection.pendingWait.pendingActionRef,
            }),
        ...(projection.pendingWait?.reason === undefined
          ? {}
          : { pendingReason: projection.pendingWait.reason }),
        approvalReady:
          projection.pendingWait?.pendingActionRef ===
          THETA_APPROVAL_KEYS.planReview,
        ...runtimeVariable(variables, 'candidatePlan'),
        ...runtimeVariable(variables, 'validatedPlan'),
        ...runtimeVariable(variables, 'planRecord'),
        ...runtimeVariable(variables, 'planReview'),
        ...runtimeVariable(variables, 'recommendation'),
        ...runtimeVariable(variables, 'evidenceBundle'),
        ...runtimeVariable(variables, 'planProposal'),
        ...runtimeVariable(variables, 'plannerResolution'),
        ...runtimeVariable(variables, 'validation'),
        ...runtimeVariable(variables, 'planAdjustment'),
        ...runtimeVariable(variables, 'datasetProfile'),
        ...runtimeVariable(variables, 'columnConfirmation'),
        ...runtimeVariable(variables, 'dryRun'),
        ...runtimeVariable(variables, 'trainingReview'),
        ...runtimeVariable(variables, 'trainingReceipt'),
        ...runtimeVariable(variables, 'datasetFacts'),
        ...runtimeVariable(variables, 'datasetUnderstanding'),
        ...runtimeVariable(variables, 'datasetConfirmation'),
        ...runtimeVariable(variables, 'researchIntent'),
        ...runtimeVariable(variables, 'researchIntentSummary'),
        ...runtimeVariable(variables, 'plannerInputV2'),
        ...runtimeVariable(variables, 'plannerDecisionV2'),
        ...runtimeVariable(variables, 'plannerValidationV2'),
        ...runtimeVariable(variables, 'plannerPresentationV2'),
        ...(isRecord(variables.researchBrief)
          ? { researchBrief: variables.researchBrief as RuntimeJsonValue }
          : {}),
      };
    } finally {
      runtime.close();
    }
  }

  async replay(
    runId: string,
    runtimeDb = defaultThetaWorkflowDb(),
  ): Promise<ThetaWorkflowReplay> {
    const evidence = await this.evidence(runId, runtimeDb);
    const statePath = evidence.orchestrationEvents
      .filter((event) => event.type === "fsm.state.entered")
      .map((event) => stringProperty(event.payload, "stateId"))
      .filter((value): value is string => value !== undefined);
    const toolCalls = unique(
      evidence.toolEvents
        .filter((event) => event.type === "tool.call.completed")
        .map((event) => stringProperty(event.payload, "toolId"))
        .filter((value): value is string => value !== undefined),
    );
    const policyDecisions = evidence.toolEvents
      .filter((event) => event.type === "tool.policy.checked")
      .map((event) => {
        const decision = recordProperty(event.payload, "decision");
        return (
          stringValue(decision?.ruleId) ??
          stringProperty(event.payload, "ruleId") ??
          event.id
        );
      });
    const terminal = [...evidence.orchestrationEvents]
      .reverse()
      .find((event) => event.type === "run.completed");
    const output = recordProperty(terminal?.payload, "output") as
      | RuntimeJsonValue
      | undefined;
    const fixture = {
      runId: evidence.runId,
      eventTypes: evidence.orchestrationEvents.map((event) => event.type),
      statePath,
      toolCalls,
      policyDecisions,
      ...(output === undefined ? {} : { output }),
    };
    return {
      ...fixture,
      digest: createHash("sha256").update(canonicalJson(fixture)).digest("hex"),
    };
  }

  private toolPort(runtimeDb: string, runId: string): ThetaWorkflowToolPort {
    return (
      this.options.toolPort ??
      new GovernedThetaWorkflowToolPort(
        runtimeDb,
        new JsonlToolTraceRecorder(thetaToolTraceFile(runtimeDb, runId)),
      )
    );
  }

  private async drive(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    tools: ThetaWorkflowToolPort,
    approvalKeys: readonly string[],
    approvedBy: string,
  ): Promise<ThetaWorkflowRunResult> {
    let result = await this.runDriver(runtime, scope, tools);
    result = await this.autoApprove(
      runtime,
      scope,
      tools,
      result,
      new Set(approvalKeys),
      approvedBy,
    );
    return toRunResult(
      scope.runId,
      runtime.filename,
      result,
      await terminalOutput(runtime, scope),
    );
  }

  private async autoApprove(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    tools: ThetaWorkflowToolPort,
    initial: BoundedFSMDriverResult,
    approvals: ReadonlySet<string>,
    approvedBy: string,
  ): Promise<BoundedFSMDriverResult> {
    let result = initial;
    for (let count = 0; count < 3; count += 1) {
      const pending = result.projection.pendingWait;
      if (
        result.disposition !== "waiting" ||
        pending?.type !== "human" ||
        !pending.pendingActionRef ||
        requiresStructuredHumanInput(pending.pendingActionRef) ||
        !approvals.has(pending.pendingActionRef)
      ) {
        return result;
      }
      await this.resolveHumanWait(
        runtime,
        scope,
        result.projection,
        "approved",
        approvedBy,
      );
      result = await this.runDriver(runtime, scope, tools);
    }
    return result;
  }

  private async resolveHumanWait(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    projection: RuntimeOrchestrationProjection,
    decision: "approved" | "rejected",
    principalId: string,
  ): Promise<void> {
    const pending = projection.pendingWait;
    if (pending?.type !== "human" || !pending.pendingActionRef) {
      throw new Error(
        "THETA workflow is not waiting for a resolvable human action.",
      );
    }
    await runtime.humanWaits.resolve({
      commandId: `theta-human-${pending.waitId}-${decision}`,
      scope,
      ownerId: `${DRIVER_OWNER}:human`,
      leaseTtlMs: LEASE_TTL_MS,
      waitId: pending.waitId,
      pendingActionRef: pending.pendingActionRef,
      principalId,
      decision,
      resolvedAt: this.now(),
      idempotencyKey: `theta-human-${pending.waitId}-${decision}`,
    });
  }

  private async recordStructuredResumeInput(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    projection: RuntimeOrchestrationProjection,
    request: ThetaWorkflowResumeRequest,
  ): Promise<void> {
    const pending = projection.pendingWait;
    if (pending?.type !== "human" || !pending.pendingActionRef) {
      throw new Error(
        "Structured resume input requires a pending human workflow action.",
      );
    }
    const payload: Record<string, unknown> = {
      pendingActionRef: pending.pendingActionRef,
    };
    if (request.researchAnswers !== undefined) {
      if (
        pending.pendingActionRef !== THETA_APPROVAL_KEYS.researchClarification
      ) {
        throw new Error(
          `Research answers cannot resolve ${pending.pendingActionRef}.`,
        );
      }
      payload.researchAnswers = researchBriefPatchSchema.parse(
        request.researchAnswers,
      );
    }
    if (request.columnConfirmation !== undefined) {
      if (pending.pendingActionRef !== THETA_APPROVAL_KEYS.columnConfirmation) {
        throw new Error(
          `Column confirmation cannot resolve ${pending.pendingActionRef}.`,
        );
      }
      const variables = await hydrateVariables(runtime.events, scope);
      const profile = datasetProfileSchema.parse(variables.datasetProfile);
      payload.columnConfirmation = {
        draft: columnConfirmationDraftSchema.parse(request.columnConfirmation),
        datasetSha256: profile.datasetSha256,
      };
    }
    if (request.datasetConfirmation !== undefined) {
      if (
        pending.pendingActionRef !== THETA_APPROVAL_KEYS.datasetUnderstanding
      ) {
        throw new Error(
          `Dataset understanding confirmation cannot resolve ${pending.pendingActionRef}.`,
        );
      }
      const variables = await hydrateVariables(runtime.events, scope);
      const facts = datasetFactsSchema.parse(variables.datasetFacts);
      payload.datasetConfirmation = {
        draft: datasetConfirmationDraftSchema.parse(
          request.datasetConfirmation,
        ),
        datasetHash: facts.datasetHash,
      };
    }
    if (request.decisionAnswer !== undefined) {
      if (
        pending.pendingActionRef !== THETA_APPROVAL_KEYS.researchIntent &&
        pending.pendingActionRef !== THETA_APPROVAL_KEYS.researchIntentReview
      ) {
        throw new Error(
          `Research intent answer cannot resolve ${pending.pendingActionRef}.`,
        );
      }
      const decisionAnswer = request.decisionAnswer.trim();
      if (!decisionAnswer) {
        throw new Error("Research intent answer cannot be empty.");
      }
      payload.decisionAnswer = decisionAnswer;
    }
    if (request.planAdjustment !== undefined) {
      if (pending.pendingActionRef !== THETA_APPROVAL_KEYS.planReview) {
        throw new Error(
          `Plan adjustment cannot resolve ${pending.pendingActionRef}.`,
        );
      }
      payload.planAdjustment = sanitizePlanAdjustment(request.planAdjustment);
    }
    const head = await runtime.events.getStreamHead(streamScope(scope));
    const submissionId = createHash("sha256")
      .update(
        canonicalJson({
          waitId: pending.waitId,
          pendingActionRef: pending.pendingActionRef,
          payload,
        }),
      )
      .digest("hex")
      .slice(0, 24);
    await runtime.events.append({
      scope: streamScope(scope),
      events: [
        {
          id: `${scope.runId}:structured-resume:${submissionId}`,
          type: "reasoning.decision.recorded",
          version: "1.0.0",
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          runId: scope.runId,
          agentId: scope.agentId,
          correlationId: scope.runId,
          timestamp: this.now(),
          payload,
        },
      ],
      expectedLastSequence: head?.lastSequence ?? 0,
      ...(head?.fencingToken === undefined
        ? {}
        : { fencingToken: head.fencingToken }),
      idempotencyKey: `theta-structured-resume:${scope.runId}:${submissionId}`,
    });
  }

  private runDriver(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    tools: ThetaWorkflowToolPort,
  ): Promise<BoundedFSMDriverResult> {
    const compilation = compileThetaTrainingDomain(thetaHyphaToolSpecs);
    const driver = runtime.createDriver((input) =>
      executeThetaState(input, runtime.events, tools, this.now),
    );
    return driver.run({
      scope,
      process: compilation.fsmProcess,
      ownerId: DRIVER_OWNER,
      maxSteps: MAX_STEPS,
      leaseTtlMs: LEASE_TTL_MS,
      stateClaimTtlMs: STATE_CLAIM_TTL_MS,
    });
  }
}

const executeThetaState = async (
  execution: BoundedStateExecutorInput,
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>["events"],
  tools: ThetaWorkflowToolPort,
  now: () => string,
): Promise<BoundedStateExecutionDecision> => {
  const variables = await hydrateVariables(events, execution.scope);
  const researchService = new ResearchService();
  const invoke = (
    toolId: string,
    input: Record<string, unknown>,
    approvedBy?: string,
  ) =>
    tools.invoke({
      toolId,
      input,
      runId: execution.scope.runId,
      sessionId: execution.scope.sessionId,
      stateId: execution.state.id,
      stateAttempt: execution.projection.stateAttempt,
      approvedBy,
    });
  try {
    switch (execution.state.id) {
      case THETA_WORKFLOW_STATES.intake: {
        const input = requireRecord(
          variables.input,
          "workflow input",
        ) as unknown as ThetaWorkflowInput;
        validateInput(input);
        if (input.workflowVersion === "2.0.0") {
          const initialIntent = input.recoveredResearchIntent
            ? researchIntentSchema.parse(input.recoveredResearchIntent)
            : createInitialResearchIntent();
          return transition(THETA_WORKFLOW_STATES.inspectDataset, {
            researchIntent: input.recoveredResearchIntent
              ? initialIntent
              : researchIntentSchema.parse({
                ...initialIntent,
                ...(input.researchGoal?.trim()
                ? {
                    researchQuestion: input.researchGoal.trim(),
                    unknowns: initialIntent.unknowns.filter(
                      (item) => item !== "research_goal",
                    ),
                  }
                  : {}),
              }),
            interviewMemory: emptyInterviewMemory(),
          });
        }
        const assessment = researchService.assess(
          researchService.createBrief(input),
          { currentState: execution.state.id },
        );
        return transition(
          THETA_WORKFLOW_STATES.inspectDataset,
          {
            researchBrief: runtimeRecord({ ...assessment.brief }),
            researchAssessment: sanitizeResearchAssessment(assessment),
          },
        );
      }
      case THETA_WORKFLOW_STATES.awaitResearchClarification: {
        const lastResume = execution.projection.lastResume;
        const resumePayload = lastResume?.payload;
        const resume = isRecord(resumePayload) ? resumePayload : undefined;
        if (
          resume?.pendingActionRef !==
            THETA_APPROVAL_KEYS.researchClarification ||
          !lastResume?.commandId ||
          stringValue(variables.processedResearchResumeCommandId) ===
            lastResume.commandId
        ) {
          const assessment = researchService.assess(
            researchBriefSchema.parse(variables.researchBrief),
            researchPlanningContext(
              variables,
              execution.state.id,
              execution.projection.stateAttempt,
            ),
          );
          return researchClarificationWait(
            assessment,
            execution.projection.stateAttempt,
          );
        }
        if (resume.decision === "rejected") {
          return failed(
            "RUNTIME_CANCELLED",
            "Human rejected the research clarification request.",
            execution.state.id,
          );
        }
        const answers = requireRecord(
          variables.researchAnswers,
          "research clarification answers",
        );
        const assessment = researchService.assess(
          researchService.applyAnswers(
            researchBriefSchema.parse(variables.researchBrief),
            answers,
          ),
          researchPlanningContext(
            variables,
            execution.state.id,
            execution.projection.stateAttempt,
          ),
        );
        if (!assessment.blocking) {
          return transition(THETA_WORKFLOW_STATES.inspectDataset, {
            researchBrief: runtimeRecord({ ...assessment.brief }),
            researchAssessment: sanitizeResearchAssessment(assessment),
            processedResearchResumeCommandId: lastResume.commandId,
          });
        }
        const grilling = decideResearchGrilling(
          assessment,
          execution.projection.stateAttempt,
        );
        if (grilling.kind === "unresolved") {
          return transition(THETA_WORKFLOW_STATES.awaitResearchClarification, {
            researchBrief: runtimeRecord({ ...assessment.brief }),
            researchAssessment: sanitizeResearchAssessment(assessment),
            processedResearchResumeCommandId: lastResume.commandId,
          });
        }
        if (grilling.kind === "ask") {
          return transition(THETA_WORKFLOW_STATES.awaitResearchClarification, {
            researchBrief: runtimeRecord({ ...assessment.brief }),
            researchAssessment: sanitizeResearchAssessment(assessment),
            processedResearchResumeCommandId: lastResume.commandId,
          });
        }
        return transition(THETA_WORKFLOW_STATES.inspectDataset, {
          researchBrief: runtimeRecord({ ...assessment.brief }),
          researchAssessment: sanitizeResearchAssessment(assessment),
          processedResearchResumeCommandId: lastResume.commandId,
        });
      }
      case THETA_WORKFLOW_STATES.inspectDataset: {
        const input = requireRecord(variables.input, "workflow input");
        if (input.workflowVersion === "2.0.0") {
          requiredString(input.datasetRef, "input.datasetRef");
          return transition(THETA_WORKFLOW_STATES.analyzeDataset);
        }
        const toolInput = {
          filePath: requiredString(input.filePath, "input.filePath"),
          sampleSize: numberValue(input.sampleSize) ?? 500,
        };
        const [inspection, columns] = await Promise.all([
          invoke(THETA_TOOL_IDS.datasetInspect, toolInput),
          invoke(THETA_TOOL_IDS.datasetDetectColumns, toolInput),
        ]);
        const datasetProfile = sanitizeDatasetProfile(inspection, columns);
        const currentBrief = researchBriefSchema.parse(variables.researchBrief);
        const primaryTextColumn = datasetProfile.columnCandidates.text[0]?.name;
        const observedBrief = researchService.applyAnswers(
          currentBrief,
          {
            expectedRowCount: datasetProfile.rowCount,
            candidateTimeColumns: datasetProfile.columnCandidates.time.map(
              (candidate) => candidate.name,
            ),
            candidateGroupColumns: datasetProfile.columnCandidates.metadata.map(
              (candidate) => candidate.name,
            ),
            ...(currentBrief.analysisUnit
              ? {}
              : { analysisUnit: '每一行是一条独立文本记录' }),
            ...(currentBrief.textFieldIntent || !primaryTextColumn
              ? {}
              : {
                  textFieldIntent: `分析 ${primaryTextColumn} 列中的主要文本内容`,
                }),
            ...(currentBrief.language || datasetProfile.languageDistribution.length === 0
              ? {}
              : {
                  language: datasetProfile.languageDistribution[0]?.language,
                }),
            ...(currentBrief.researchDomain || !datasetProfile.inferredDomain
              ? {}
              : { researchDomain: datasetProfile.inferredDomain.label }),
          },
        );
        const observedAssessment = researchService.assess(observedBrief, {
          currentState: execution.state.id,
          datasetProfile,
        });
        return transition(
          observedAssessment.blocking
            ? THETA_WORKFLOW_STATES.awaitResearchClarification
            : THETA_WORKFLOW_STATES.awaitColumnConfirmation,
          {
            datasetProfile,
            researchBrief: runtimeRecord({ ...observedAssessment.brief }),
            researchAssessment: sanitizeResearchAssessment(observedAssessment),
          },
        );
      }
      case THETA_WORKFLOW_STATES.analyzeDataset: {
        const input = requireRecord(variables.input, "workflow input");
        const datasetRef = requiredString(input.datasetRef, 'input.datasetRef');
        const allowRemoteSamples = input.allowRemoteSamples === true;
        const exploreDataset = async (arguments_: { datasetRef: string; sheetName?: string }) =>
          (await invoke(
            THETA_TOOL_IDS.datasetExplore,
            arguments_ as unknown as Record<string, unknown>,
          )) as unknown as ThetaDatasetExploreOutput;
        const result = allowRemoteSamples
          ? await new DatasetUnderstandingLanguageLoop({
              allowRemoteSamples: true,
              generate: async (request) =>
                (await invoke(
                  THETA_TOOL_IDS.datasetUnderstandingLanguage,
                  request as unknown as Record<string, unknown>,
                  USER_ID,
                )) as unknown as DatasetUnderstandingLanguageResult,
              explore: exploreDataset,
            }).understand(datasetRef)
          : await deterministicDatasetUnderstanding(datasetRef, exploreDataset);
        const facts = result.facts;
        const understanding = result.draft;
        const understandingMeta: Record<string, unknown> = {
          source: result.source,
          explorationCalls: result.explorationCalls,
          fallbackReason: result.fallbackReason ?? null,
          remoteSamplesAllowed: allowRemoteSamples,
        };
        const previousFacts = datasetFactsSchema.safeParse(variables.datasetFacts);
        const hashChanged = previousFacts.success && previousFacts.data.datasetHash !== facts.datasetHash;
        const validation = validateDatasetUnderstanding(understanding, facts);
        if (!validation.valid) {
          throw new Error(validation.errors.join(' '));
        }
        return transition(
          THETA_WORKFLOW_STATES.awaitDatasetUnderstandingConfirmation,
          {
            datasetFacts: facts,
            datasetUnderstanding: understanding,
            datasetUnderstandingMeta: understandingMeta,
            remoteSampleReceipt: result.sampleReceipt ?? null,
            ...(hashChanged
              ? {
                  datasetConfirmation: null,
                  researchIntent: createInitialResearchIntent(),
                  interviewMemory: emptyInterviewMemory(),
                  datasetInvalidation: {
                    reason: 'dataset_hash_changed',
                    previousDatasetHash: previousFacts.data.datasetHash,
                    detectedDatasetHash: facts.datasetHash,
                  },
                }
              : {}),
          },
        );
      }
      case THETA_WORKFLOW_STATES.awaitDatasetUnderstandingConfirmation: {
        const facts = datasetFactsSchema.parse(variables.datasetFacts);
        const understanding = datasetUnderstandingDraftSchema.parse(
          variables.datasetUnderstanding,
        );
        const lastResume = execution.projection.lastResume;
        const resume = isRecord(lastResume?.payload)
          ? lastResume.payload
          : undefined;
        if (
          resume?.pendingActionRef !==
            THETA_APPROVAL_KEYS.datasetUnderstanding ||
          !lastResume?.commandId ||
          stringValue(variables.processedDatasetConfirmationCommandId) ===
            lastResume.commandId
        ) {
          return datasetUnderstandingWait(understanding);
        }
        if (resume.decision === "rejected") {
          return failed(
            "RUNTIME_CANCELLED",
            "Human rejected the dataset understanding.",
            execution.state.id,
          );
        }
        const submission = requireRecord(
          variables.datasetConfirmationSubmission,
          "dataset understanding confirmation",
        );
        if (
          requiredString(submission.datasetHash, "submitted datasetHash") !==
          facts.datasetHash
        ) {
          return transition(THETA_WORKFLOW_STATES.inspectDataset, {
            datasetUnderstanding: null,
            datasetConfirmation: null,
            processedDatasetConfirmationCommandId: lastResume.commandId,
          });
        }
        const draft = datasetConfirmationDraftSchema.parse(submission.draft);
        assertDatasetConfirmation(draft, facts);
        const confirmation = datasetConfirmationSchema.parse({
          schemaVersion: "2.0.0",
          datasetRef: facts.datasetRef,
          datasetHash: facts.datasetHash,
          ...draft,
          confirmedBy: lastResume.principalId ?? USER_ID,
          confirmedAt: lastResume.resumedAt ?? now(),
        });
        const canonicalUnderstanding = applyDatasetConfirmationToUnderstanding(
          facts,
          understanding,
          confirmation,
          now(),
        );
        return transition(THETA_WORKFLOW_STATES.researchIntentInterview, {
          datasetConfirmation: confirmation,
          datasetUnderstanding: canonicalUnderstanding,
          researchIntent: researchIntentSchema.parse(
            variables.researchIntent ?? createInitialResearchIntent(),
          ),
          interviewMemory: interviewMemorySchema.parse(
            variables.interviewMemory ?? emptyInterviewMemory(),
          ),
          processedDatasetConfirmationCommandId: lastResume.commandId,
        });
      }
      case THETA_WORKFLOW_STATES.researchIntentInterview: {
        const understanding = datasetUnderstandingDraftSchema.parse(
          variables.datasetUnderstanding,
        );
        const confirmation = datasetConfirmationSchema.parse(
          variables.datasetConfirmation,
        );
        const intent = researchIntentSchema.parse(
          variables.researchIntent ?? createInitialResearchIntent(),
        );
        const memory = interviewMemorySchema.parse(
          variables.interviewMemory ?? emptyInterviewMemory(),
        );
        const gaps = deriveDecisionGaps(understanding, confirmation, intent);
        const nextGap = selectNextDecisionGap(gaps, memory);
        if (!nextGap) {
          return transition(
            THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
            {
              researchIntentSummary: buildResearchIntentSummary(
                intent,
                confirmation,
                now(),
              ),
            },
          );
        }
        const lastResume = execution.projection.lastResume;
        const resume = isRecord(lastResume?.payload)
          ? lastResume.payload
          : undefined;
        if (
          resume?.pendingActionRef !== THETA_APPROVAL_KEYS.researchIntent ||
          !lastResume?.commandId ||
          stringValue(variables.processedDecisionAnswerCommandId) ===
            lastResume.commandId
        ) {
          return researchIntentWait(nextGap);
        }
        if (resume.decision === "rejected") {
          return failed(
            "RUNTIME_CANCELLED",
            "Human cancelled the research intent interview.",
            execution.state.id,
          );
        }
        const answer = requiredString(
          variables.decisionAnswer,
          "research intent answer",
        );
        const delegated = isAutonomousDelegationAnswer(answer);
        const turn = delegated
          ? applyDecisionGapDefaults(intent, gaps, memory)
          : await new ResearchIntentInterpreter().interpret({
              current: intent,
              confirmation,
              gaps,
              currentGap: nextGap,
              memory,
              answer,
            });
        return transition(THETA_WORKFLOW_STATES.researchIntentInterview, {
          researchIntent: turn.intent,
          interviewMemory: turn.memory,
          lastDecisionGapTurn: {
            gapId: nextGap.id,
            appliedDefaults: turn.appliedDefaults,
            extractedFields: turn.extractedFields,
            delegated,
          },
          processedDecisionAnswerCommandId: lastResume.commandId,
        });
      }
      case THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation: {
        const understanding = datasetUnderstandingDraftSchema.parse(
          variables.datasetUnderstanding,
        );
        const confirmation = datasetConfirmationSchema.parse(
          variables.datasetConfirmation,
        );
        const intent = researchIntentSchema.parse(variables.researchIntent);
        const summary = buildResearchIntentSummary(intent, confirmation, now());
        const lastResume = execution.projection.lastResume;
        const resume = isRecord(lastResume?.payload)
          ? lastResume.payload
          : undefined;
        if (
          resume?.pendingActionRef !== THETA_APPROVAL_KEYS.researchIntentReview ||
          !lastResume?.commandId ||
          stringValue(variables.processedResearchIntentReviewCommandId) ===
            lastResume.commandId
        ) {
          return researchIntentReviewWait(summary);
        }
        if (resume.decision === 'rejected') {
          return transition(THETA_WORKFLOW_STATES.researchIntentInterview, {
            researchIntent: researchIntentSchema.parse({
              ...intent,
              unknowns: unique([...intent.unknowns, 'research_goal']),
            }),
            interviewMemory: emptyInterviewMemory(),
            processedResearchIntentReviewCommandId: lastResume.commandId,
          });
        }
        if (
          stringValue(variables.decisionAnswerActionRef) ===
            THETA_APPROVAL_KEYS.researchIntentReview
        ) {
          const revisedIntent = await new ResearchIntentInterpreter().revise({
            current: intent,
            confirmation,
            answer: requiredString(
              variables.decisionAnswer,
              'research intent correction',
            ),
          });
          const previousMemory = interviewMemorySchema.parse(
            variables.interviewMemory ?? emptyInterviewMemory(),
          );
          const reopened = new Set(revisedIntent.unknowns);
          const memory = interviewMemorySchema.parse({
            ...previousMemory,
            askedQuestionHashes: [],
            resolvedGapIds: previousMemory.resolvedGapIds.filter(
              (id) => !reopened.has(id),
            ),
            defaultedGapIds: previousMemory.defaultedGapIds.filter(
              (id) => !reopened.has(id),
            ),
          });
          const revisedGaps = deriveDecisionGaps(
            understanding,
            confirmation,
            revisedIntent,
          );
          const nextState = selectNextDecisionGap(revisedGaps, memory)
            ? THETA_WORKFLOW_STATES.researchIntentInterview
            : THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation;
          return transition(nextState, {
            researchIntent: revisedIntent,
            interviewMemory: memory,
            researchIntentSummary: buildResearchIntentSummary(
              revisedIntent,
              confirmation,
              now(),
            ),
            researchIntentConfirmed: null,
            decisionAnswer: null,
            decisionAnswerActionRef: null,
            processedResearchIntentReviewCommandId: lastResume.commandId,
          });
        }
        return transition(THETA_WORKFLOW_STATES.recommendModel, {
          researchIntentSummary: summary,
          researchIntentConfirmed: {
            intentHash: summary.intentHash,
            confirmedBy: lastResume.principalId ?? USER_ID,
            confirmedAt: lastResume.resumedAt ?? now(),
          },
          processedResearchIntentReviewCommandId: lastResume.commandId,
        });
      }
      case THETA_WORKFLOW_STATES.awaitColumnConfirmation: {
        const datasetProfile = datasetProfileSchema.parse(
          variables.datasetProfile,
        );
        const resume = isRecord(execution.projection.lastResume?.payload)
          ? execution.projection.lastResume.payload
          : undefined;
        if (
          resume?.pendingActionRef !== THETA_APPROVAL_KEYS.columnConfirmation
        ) {
          return columnConfirmationWait(datasetProfile);
        }
        if (resume.decision === "rejected") {
          return failed(
            "RUNTIME_CANCELLED",
            "Human rejected the dataset column confirmation.",
            execution.state.id,
          );
        }
        if (!isRecord(variables.columnConfirmation)) {
          return columnConfirmationWait(datasetProfile);
        }
        const submission = variables.columnConfirmation;
        if (
          requiredString(
            submission.datasetSha256,
            "submitted datasetSha256",
          ) !== datasetProfile.datasetSha256
        ) {
          return columnConfirmationWait(datasetProfile);
        }
        const input = requireRecord(variables.input, "workflow input");
        const latestInspection = await invoke(THETA_TOOL_IDS.datasetInspect, {
          filePath: requiredString(input.filePath, "input.filePath"),
          sampleSize: numberValue(input.sampleSize) ?? 500,
        });
        if (
          requiredString(
            latestInspection.datasetSha256,
            "latest datasetSha256",
          ) !== datasetProfile.datasetSha256
        ) {
          return transition(THETA_WORKFLOW_STATES.inspectDataset, {
            datasetInvalidation: {
              reason: "dataset_hash_changed_before_column_confirmation",
              previousDatasetSha256: datasetProfile.datasetSha256,
              detectedDatasetSha256: requiredString(
                latestInspection.datasetSha256,
                "latest datasetSha256",
              ),
            },
            columnConfirmation: null,
          });
        }
        const draft = columnConfirmationDraftSchema.parse(submission.draft);
        validateConfirmedColumns(draft, datasetProfile);
        const confirmation = columnConfirmationSchema.parse({
          ...draft,
          schemaVersion: RESEARCH_CONTRACT_VERSION,
          datasetSha256: datasetProfile.datasetSha256,
          confirmedBy: execution.projection.lastResume?.principalId ?? USER_ID,
          confirmedAt:
            execution.projection.lastResume?.resumedAt ??
            new Date().toISOString(),
        });
        return transition(THETA_WORKFLOW_STATES.recommendModel, {
          columnConfirmation: confirmation,
        });
      }
      case THETA_WORKFLOW_STATES.recommendModel: {
        const nativeInput = requireRecord(variables.input, 'workflow input');
        if (isV2Workflow(nativeInput)) {
          const facts = datasetFactsSchema.parse(variables.datasetFacts);
          const confirmation = datasetConfirmationSchema.parse(variables.datasetConfirmation);
          const intent = researchIntentSchema.parse(variables.researchIntent);
          const summary = buildResearchIntentSummary(intent, confirmation, now());
          const intentConfirmation = isRecord(variables.researchIntentConfirmed)
            ? variables.researchIntentConfirmed
            : undefined;
          if (stringValue(intentConfirmation?.intentHash) !== summary.intentHash) {
            return transition(
              THETA_WORKFLOW_STATES.awaitResearchIntentConfirmation,
              { researchIntentSummary: summary },
            );
          }
          const queries = planEvidenceQueriesV2({ facts, confirmation, intent });
          const [catalog, ...evidenceResults] = await Promise.all([
            invoke(THETA_TOOL_IDS.modelCatalog, { includeExperimental: true }),
            ...queries.map((query) => invoke(THETA_TOOL_IDS.ragSearch, { query: query.query, limit: 8 })),
          ]);
          const evidenceBundle = buildEvidenceBundle(
            evidenceExecutions(queries, evidenceResults),
            20,
          );
          const plannerInputV2 = buildPlannerInputV2({
            facts,
            confirmation,
            intent,
            evidenceRefs: evidenceBundle.evidence.map((item) => item.evidenceId),
            constraints: isRecord(nativeInput.constraints) ? nativeInput.constraints : {},
            userOverrides: isRecord(variables.plannerUserOverrides)
              ? variables.plannerUserOverrides
              : isRecord(nativeInput.plan) ? nativeInput.plan : {},
            catalog: {
              source: stringValue(catalog.source),
              runnableSource: stringValue(catalog.runnableSource),
              models: arrayValue(catalog.models)
                .filter(isRecord)
                .map((model) => ({
                  id: requiredString(model.id, 'catalog model id'),
                  runnable: model.runnable === true,
                })),
            },
          });
          const plannerDecisionV2 = plannerDecisionV2Schema.parse(
            await invoke(THETA_TOOL_IDS.planPropose, {
              plannerInput: plannerInputV2,
              evidenceBundle,
            }),
          );
          const plannerValidationV2 = validatePlannerDecisionV2(
            plannerInputV2,
            plannerDecisionV2,
          );
          if (!plannerValidationV2.valid) {
            return failed(
              'RUNTIME_INTERNAL_ERROR',
              `Planner V2 validation failed: ${plannerValidationV2.errors.join('; ')}`,
              execution.state.id,
            );
          }
          const candidatePlan = plannerDecisionToTrainingPlan(
            facts,
            confirmation,
            plannerDecisionV2,
          );
          return transition(THETA_WORKFLOW_STATES.validatePlan, {
            modelCatalog: sanitizeCatalog(catalog),
            evidenceBundle: evidenceBundle as unknown as RuntimeJsonValue,
            evidence: {
              noEvidence: evidenceBundle.noEvidence,
              refs: evidenceBundle.evidence as unknown as RuntimeJsonValue[],
              retrievalTrace: {
                schemaVersion: evidenceBundle.schemaVersion,
                bundleHash: evidenceBundle.bundleHash,
                queryCount: evidenceBundle.queries.length,
                coverage: evidenceBundle.coverage,
                authorityCounts: evidenceBundle.authorityCounts,
                uncertainties: evidenceBundle.uncertainties,
              } as unknown as RuntimeJsonValue,
            },
            recommendation: {
              schemaVersion: '2.0.0',
              candidates: plannerInputV2.candidates,
            },
            plannerInputV2: plannerInputV2 as unknown as RuntimeJsonValue,
            plannerDecisionV2: plannerDecisionV2 as unknown as RuntimeJsonValue,
            plannerValidationV2: plannerValidationV2 as unknown as RuntimeJsonValue,
            plannerPresentationV2: presentPlanV2(
              plannerInputV2,
              plannerDecisionV2,
              plannerValidationV2,
            ) as unknown as RuntimeJsonValue,
            candidatePlan: candidatePlan as RuntimeJsonValue,
            plannerResolution: {
              source: 'native_planner_v2',
              inputHash: plannerDecisionV2.inputHash,
              acceptedEvidenceRefs: plannerDecisionV2.evidenceRefs,
              parameterDecisions: {},
            },
            planningApprovalsInvalidated: isRecord(variables.planRecord),
            ...planningInvalidationPatch(variables),
          });
        }
        const previousProposal = planProposalResultSchema.safeParse(
          variables.planProposal,
        );
        const hadPreviousPlanningState =
          isRecord(variables.planProposal) ||
          isRecord(variables.planRecord) ||
          isRecord(variables.planReview) ||
          isRecord(variables.dryRun) ||
          isRecord(variables.trainingReview);
        const input = requireRecord(variables.input, "workflow input");
        const datasetProfile = requireRecord(
          variables.datasetProfile,
          "dataset profile",
        );
        const researchBrief = requireRecord(
          variables.researchBrief,
          "research brief",
        );
        const columnConfirmation = requireRecord(
          variables.columnConfirmation,
          "column confirmation",
        );
        const evidenceInput: PlanEvidenceQueryInput = {
          researchBrief,
          datasetProfile,
          columnConfirmation,
          ...(stringValue(input.researchGoal)
            ? { researchGoal: stringValue(input.researchGoal) }
            : {}),
        };
        const baseQueries = planEvidenceQueries(evidenceInput);
        const [catalog, ...baseEvidenceResults] = await Promise.all([
          invoke(THETA_TOOL_IDS.modelCatalog, {}),
          ...baseQueries.map((query) =>
            invoke(THETA_TOOL_IDS.ragSearch, {
              query: query.query,
              limit: 8,
            }),
          ),
        ]);
        const baseExecutions = evidenceExecutions(
          baseQueries,
          baseEvidenceResults,
        );
        const baseBundle = buildEvidenceBundle(baseExecutions, 18);
        const preliminaryRecommendation = await invoke(THETA_TOOL_IDS.modelRecommend, {
          dataProfile: datasetProfile,
          researchBrief,
          columnConfirmation,
          evidence: baseBundle.evidence,
          ...(stringValue(input.researchGoal)
            ? { researchGoal: input.researchGoal }
            : {}),
          ...(isRecord(input.constraints)
            ? { constraints: input.constraints }
            : {}),
        });
        const candidateModelIds = arrayValue(preliminaryRecommendation.recommendations)
          .map((item) => stringValue(requireRecord(item, "recommendation").modelId))
          .filter((item): item is string => Boolean(item));
        const candidateQueries = planCandidateEvidenceQueries(
          evidenceInput,
          candidateModelIds,
        );
        const candidateEvidenceResults = await Promise.all(
          candidateQueries.map((query) =>
            invoke(THETA_TOOL_IDS.ragSearch, {
              query: query.query,
              limit: 8,
            }),
          ),
        );
        const evidenceBundle = buildEvidenceBundle(
          [
            ...baseExecutions,
            ...evidenceExecutions(candidateQueries, candidateEvidenceResults),
          ],
          18,
          candidateModelIds,
        );
        const recommendation = await invoke(THETA_TOOL_IDS.modelRecommend, {
          dataProfile: datasetProfile,
          researchBrief,
          columnConfirmation,
          evidence: evidenceBundle.evidence,
          ...(stringValue(input.researchGoal)
            ? { researchGoal: input.researchGoal }
            : {}),
          ...(isRecord(input.constraints)
            ? { constraints: input.constraints }
            : {}),
        });
        if (arrayValue(recommendation.recommendations).length === 0) {
          return failed(
            "RUNTIME_INVARIANT_FAILED",
            `No compatible model remains after hard constraints: ${stringArray(
              recommendation.warnings,
            ).join(", ")}`,
            execution.state.id,
          );
        }
        const proposal = planProposalResultSchema.parse(
          await invoke(THETA_TOOL_IDS.planPropose, {
            enabled: input.plannerMode === "minimax",
            researchBrief,
            datasetProfile,
            columnConfirmation,
            recommendation,
            evidenceBundle,
          }),
        );
        const plannerInputChange = previousProposal.success
          ? comparePlannerInputSnapshots(
              previousProposal.data.inputSnapshot,
              proposal.inputSnapshot,
            )
          : undefined;
        const resolution = resolvePlannerProposal({
          proposal,
          recommendation: recommendationResultSchema.parse(recommendation),
          workflowInput: input,
          datasetProfile,
          columnConfirmation,
          evidenceBundle,
        });
        return transition(THETA_WORKFLOW_STATES.validatePlan, {
          modelCatalog: sanitizeCatalog(catalog),
          evidence: {
            noEvidence: evidenceBundle.noEvidence,
            refs: evidenceBundle.evidence as unknown as RuntimeJsonValue[],
            retrievalTrace: {
              schemaVersion: evidenceBundle.schemaVersion,
              bundleHash: evidenceBundle.bundleHash,
              queryCount: evidenceBundle.queries.length,
              coverage: evidenceBundle.coverage,
              authorityCounts: evidenceBundle.authorityCounts,
              uncertainties: evidenceBundle.uncertainties,
            } as unknown as RuntimeJsonValue,
          },
          evidenceBundle: evidenceBundle as unknown as RuntimeJsonValue,
          recommendation: sanitizeRecommendation(recommendation),
          planProposal: proposal as unknown as RuntimeJsonValue,
          plannerResolution: resolution as unknown as RuntimeJsonValue,
          candidatePlan: resolution.resolvedPlan as RuntimeJsonValue,
          plannerInputChange: plannerInputChange
            ? (plannerInputChange as unknown as RuntimeJsonValue)
            : null,
          planningApprovalsInvalidated: hadPreviousPlanningState,
          ...planningInvalidationPatch(variables),
        });
      }
      case THETA_WORKFLOW_STATES.validatePlan: {
        const workflowInput = requireRecord(variables.input, 'workflow input');
        if (isV2Workflow(workflowInput)) {
          const facts = datasetFactsSchema.parse(variables.datasetFacts);
          const confirmation = datasetConfirmationSchema.parse(variables.datasetConfirmation);
          const intent = researchIntentSchema.parse(variables.researchIntent);
          const plannerInput = plannerInputV2Schema.parse(variables.plannerInputV2);
          const plannerDecision = plannerDecisionV2Schema.parse(variables.plannerDecisionV2);
          const plannerValidation = validatePlannerDecisionV2(plannerInput, plannerDecision);
          if (!plannerValidation.valid) {
            return failed(
              'RUNTIME_INTERNAL_ERROR',
              `Planner V2 rejected the candidate plan: ${plannerValidation.errors.join('; ')}`,
              execution.state.id,
            );
          }
          const candidate = requireRecord(variables.candidatePlan, 'candidate plan');
          const validation = await invoke(THETA_TOOL_IDS.planValidate, {
            plan: candidate,
            dataProfile: v2DataProfile(facts, confirmation),
          });
          if (validation.valid !== true) {
            return failed(
              'RUNTIME_INVARIANT_FAILED',
              `Candidate plan is invalid: ${stringArray(validation.errors).join('; ')}`,
              execution.state.id,
            );
          }
          const normalizedPlan = requireRecord(validation.normalizedPlan, 'normalized plan');
          return transition(THETA_WORKFLOW_STATES.awaitPlanCreationApproval, {
            validatedPlan: normalizedPlan,
            plannerValidationV2: plannerValidation as unknown as RuntimeJsonValue,
            plannerPresentationV2: presentPlanV2(
              plannerInput,
              plannerDecision,
              plannerValidation,
            ) as unknown as RuntimeJsonValue,
            validation: {
              valid: true,
              validatorVersion: stringValue(validation.validatorVersion) ?? 'unknown',
              blockingWarnings: stringArray(validation.blockingWarnings),
              warnings: stringArray(validation.warnings),
              findings: arrayValue(validation.findings) as RuntimeJsonValue[],
              catalogSource: stringValue(validation.catalogSource) ?? 'unknown',
              plannerValid: true,
              plannerErrors: [],
              plannerWarnings: plannerValidation.warnings,
              researchQuestion: intent.researchQuestion,
            },
          });
        }
        const candidate = requireRecord(
          variables.candidatePlan,
          "candidate plan",
        );
        const validation = await invoke(THETA_TOOL_IDS.planValidate, {
          plan: candidate,
          dataProfile: requireRecord(
            variables.datasetProfile,
            "dataset profile",
          ),
        });
        if (validation.valid !== true) {
          return failed(
            "RUNTIME_INVARIANT_FAILED",
            `Candidate plan is invalid: ${stringArray(validation.errors).join("; ")}`,
            execution.state.id,
          );
        }
        const normalizedPlan = requireRecord(
          validation.normalizedPlan,
          "normalized plan",
        );
        const plannerResolution = requireRecord(
          variables.plannerResolution,
          "planner resolution",
        );
        const parameterDecisions = applyValidatorParameterCorrections(
          parameterDecisionsFromResolution(plannerResolution),
          candidate,
          normalizedPlan,
          now(),
        );
        return transition(THETA_WORKFLOW_STATES.awaitPlanCreationApproval, {
          validatedPlan: normalizedPlan,
          plannerResolution: {
            ...plannerResolution,
            parameterDecisions,
          },
          validation: {
            valid: true,
            validatorVersion:
              stringValue(validation.validatorVersion) ?? "unknown",
            blockingWarnings: stringArray(validation.blockingWarnings),
            warnings: stringArray(validation.warnings),
            findings: arrayValue(validation.findings) as RuntimeJsonValue[],
            catalogSource: stringValue(validation.catalogSource) ?? "unknown",
          },
        });
      }
      case THETA_WORKFLOW_STATES.awaitPlanCreationApproval:
        if (isRecord(variables.planAdjustment)) {
          const adjustmentHash = createHash("sha256")
            .update(canonicalJson(variables.planAdjustment))
            .digest("hex");
          if (
            stringValue(variables.processedPlanAdjustmentHash) !==
            adjustmentHash
          ) {
            const sanitizedAdjustment = sanitizePlanAdjustment(
              variables.planAdjustment,
            );
            if (isV2Workflow(requireRecord(variables.input, 'workflow input'))) {
              if (sanitizedAdjustment.covariateColumns !== undefined) {
                throw new Error('训练协变量属于数据确认，不能在方案调整阶段改写；请先纠正数据理解。');
              }
              if (sanitizedAdjustment.experimentProtocol !== undefined) {
                throw new Error('原生 Planner V2 的实验协议不能直接注入对象，请用自然语言说明需求后重新生成。');
              }
              return transition(THETA_WORKFLOW_STATES.recommendModel, {
                ...planningInvalidationPatch(variables),
                plannerUserOverrides: Object.fromEntries(
                  Object.entries(sanitizedAdjustment).filter(
                    ([key]) => key !== 'acceptDegradation',
                  ),
                ) as RuntimeJsonValue,
                processedPlanAdjustmentHash: adjustmentHash,
                planAdjustmentResumeAt:
                  execution.projection.lastResume?.resumedAt ?? null,
                candidatePlan: null,
                validatedPlan: null,
                plannerDecisionV2: null,
                plannerValidationV2: null,
                plannerPresentationV2: null,
              });
            }
            const currentCandidate = requireRecord(
              variables.candidatePlan,
              "candidate plan",
            );
            const adjustedCandidate = {
              ...currentCandidate,
              ...planFieldsFromAdjustment(sanitizedAdjustment),
            };
            const plannerResolution = requireRecord(
              variables.plannerResolution,
              "planner resolution",
            );
            const parameterDecisions = applyUserParameterOverrides(
              parameterDecisionsFromResolution(plannerResolution),
              sanitizedAdjustment,
              adjustedCandidate,
              execution.projection.lastResume?.resumedAt ?? now(),
            );
            return transition(THETA_WORKFLOW_STATES.validatePlan, {
              candidatePlan: adjustedCandidate,
              plannerResolution: {
                ...plannerResolution,
                parameterDecisions,
              },
              validatedPlan: null,
              processedPlanAdjustmentHash: adjustmentHash,
              planAdjustmentResumeAt:
                execution.projection.lastResume?.resumedAt ?? null,
            });
          }
        }
        if (isV2Workflow(requireRecord(variables.input, 'workflow input'))) {
          const facts = datasetFactsSchema.parse(variables.datasetFacts);
          return approvalDecision(
            execution,
            variables,
            THETA_APPROVAL_KEYS.planReview,
            THETA_WORKFLOW_STATES.createPlan,
            {
              validatedPlan: variables.validatedPlan as RuntimeJsonValue,
              datasetHash: facts.datasetHash,
              datasetConfirmation: variables.datasetConfirmation as RuntimeJsonValue,
              plannerDecision: variables.plannerDecisionV2 as RuntimeJsonValue,
              plannerPresentation: variables.plannerPresentationV2 as RuntimeJsonValue,
            },
            stringValue(variables.planAdjustmentResumeAt),
          );
        }
        return approvalDecision(
          execution,
          variables,
          THETA_APPROVAL_KEYS.planReview,
          THETA_WORKFLOW_STATES.createPlan,
          {
            validatedPlan: variables.validatedPlan as RuntimeJsonValue,
            datasetSha256: datasetProfileSchema.parse(variables.datasetProfile)
              .datasetSha256,
            columnConfirmation:
              variables.columnConfirmation as RuntimeJsonValue,
            recommendation: variables.recommendation as RuntimeJsonValue,
          },
          stringValue(variables.planAdjustmentResumeAt),
        );
      case THETA_WORKFLOW_STATES.createPlan: {
        const approvedBy = approvalActor(
          variables,
          THETA_APPROVAL_KEYS.planReview,
        );
        const workflowInput = requireRecord(variables.input, 'workflow input');
        const created = isV2Workflow(workflowInput)
          ? await invoke(
              THETA_TOOL_IDS.planCreate,
              {
                validatedPlan: requireRecord(variables.validatedPlan, 'validated plan'),
                facts: requireRecord(variables.datasetFacts, 'dataset facts'),
                confirmation: requireRecord(variables.datasetConfirmation, 'dataset confirmation'),
                intent: requireRecord(variables.researchIntent, 'research intent'),
                plannerInput: requireRecord(variables.plannerInputV2, 'Planner V2 input'),
                plannerDecision: requireRecord(variables.plannerDecisionV2, 'Planner V2 decision'),
                evidenceBundle: requireRecord(variables.evidenceBundle, 'evidence bundle'),
                validation: requireRecord(variables.plannerValidationV2, 'Planner V2 validation'),
                domainPack: { id: THETA_DOMAIN_PACK_ID, version: THETA_DOMAIN_PACK_VERSION },
              },
              approvedBy,
            )
          : await invoke(
          THETA_TOOL_IDS.planCreate,
          {
            validatedPlan: requireRecord(
              variables.validatedPlan,
              "validated plan",
            ),
            researchBrief: requireRecord(
              variables.researchBrief,
              "research brief",
            ),
            datasetProfile: requireRecord(
              variables.datasetProfile,
              "dataset profile",
            ),
            columnConfirmation: requireRecord(
              variables.columnConfirmation,
              "column confirmation",
            ),
            recommendation: requireRecord(
              variables.recommendation,
              "recommendation",
            ),
            evidenceBundle: requireRecord(
              variables.evidenceBundle,
              "evidence bundle",
            ),
            planProposal: requireRecord(
              variables.planProposal,
              "plan proposal",
            ),
            plannerResolution: requireRecord(
              variables.plannerResolution,
              "planner resolution",
            ),
            validation: requireRecord(
              variables.validation,
              "validation",
            ),
            domainPack: {
              id: THETA_DOMAIN_PACK_ID,
              version: THETA_DOMAIN_PACK_VERSION,
            },
          },
          approvedBy,
        );
        const planRecord = trainingPlanRecordSchema.parse(created);
        const reviewDecision = approvalDecisionRecord(
          variables,
          THETA_APPROVAL_KEYS.planReview,
        );
        const planReview = createApprovalReceipt({
          approvalType: "human_plan_review",
          plan: planRecord,
          approvedBy,
          approvedAt: reviewDecision.approvedAt,
        });
        return transition(THETA_WORKFLOW_STATES.dryRun, {
          planRecord,
          planReview,
        });
      }
      case THETA_WORKFLOW_STATES.dryRun: {
        const input = requireRecord(variables.input, "workflow input");
        const plan = trainingPlanRecordSchema.parse(variables.planRecord);
        const planReview = approvalReceiptSchema.parse(variables.planReview);
        const preview = await invoke(THETA_TOOL_IDS.trainingDryRun, {
          plan,
          planReview,
          datasetPath: requiredString(input.filePath, "input.filePath"),
        });
        const dryRun = dryRunReceiptSchema.parse(preview);
        if (!dryRun.passed) {
          return failed(
            "RUNTIME_INVARIANT_FAILED",
            `Training dry run failed: ${dryRun.checks
              .filter((check) => check.status === "fail")
              .map((check) => check.code)
              .join(", ")}.`,
            execution.state.id,
          );
        }
        return transition(THETA_WORKFLOW_STATES.awaitTrainingStartApproval, {
          dryRun,
          dryRunSummary: {
            planHash: dryRun.planHash,
            dryRunHash: dryRun.dryRunHash,
            commandCount: dryRun.commands.length,
            commands: dryRun.commands,
            checks: dryRun.checks,
            expectedArtifacts: dryRun.expectedArtifacts.map(sanitizeArtifact),
            notes: dryRun.notes,
          },
        });
      }
      case THETA_WORKFLOW_STATES.awaitTrainingStartApproval:
        return approvalDecision(
          execution,
          variables,
          THETA_APPROVAL_KEYS.trainingReview,
          THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining,
          requireRecord(variables.dryRunSummary, "dry-run summary") as Record<
            string,
            RuntimeJsonValue
          >,
        );
      case THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining: {
        const input = requireRecord(variables.input, "workflow input");
        const profile = datasetProfileSchema.parse(variables.datasetProfile);
        const inspection = await invoke(THETA_TOOL_IDS.datasetInspect, {
          filePath: requiredString(input.filePath, "input.filePath"),
          ...(numberValue(input.sampleSize) === undefined
            ? {}
            : { sampleSize: numberValue(input.sampleSize) }),
        });
        const currentSha256 = requiredString(
          inspection.datasetSha256,
          "training datasetSha256",
        );
        if (currentSha256 !== profile.datasetSha256) {
          return transition(THETA_WORKFLOW_STATES.inspectDataset, {
            datasetInvalidation: {
              reason: "dataset_hash_changed_before_training",
              previousDatasetSha256: profile.datasetSha256,
              detectedDatasetSha256: currentSha256,
              planApprovalInvalidated: true,
              trainingApprovalInvalidated: true,
            },
            columnConfirmation: null,
            planRecord: null,
            planReview: null,
            dryRun: null,
            trainingReview: null,
          });
        }
        const plan = trainingPlanRecordSchema.parse(variables.planRecord);
        const dryRun = dryRunReceiptSchema.parse(variables.dryRun);
        const reviewDecision = approvalDecisionRecord(
          variables,
          THETA_APPROVAL_KEYS.trainingReview,
        );
        const trainingReview = createApprovalReceipt({
          approvalType: "human_training_review",
          plan,
          approvedBy: reviewDecision.approvedBy,
          approvedAt: reviewDecision.approvedAt,
          dryRunHash: dryRun.dryRunHash,
        });
        return transition(THETA_WORKFLOW_STATES.startTraining, {
          trainingReview,
        });
      }
      case THETA_WORKFLOW_STATES.startTraining: {
        const plan = trainingPlanRecordSchema.parse(variables.planRecord);
        const planReview = approvalReceiptSchema.parse(variables.planReview);
        const dryRun = dryRunReceiptSchema.parse(variables.dryRun);
        const trainingReview = approvalReceiptSchema.parse(
          variables.trainingReview,
        );
        assertApprovalChain({ plan, planReview, dryRun, trainingReview });
        const approvedBy = approvalActor(
          variables,
          THETA_APPROVAL_KEYS.trainingReview,
        );
        const started = await invoke(
          THETA_TOOL_IDS.trainingStart,
          {
            plan,
            planReview,
            dryRun,
            trainingReview,
            idempotencyKey: createHash("sha256")
              .update(
                `${execution.scope.userId}:${plan.planId}:${plan.planHash}:training.start`,
              )
              .digest("hex"),
          },
          approvedBy,
        );
        return transition(THETA_WORKFLOW_STATES.monitorTraining, {
          trainingReceipt: sanitizeTrainingReceipt(started),
        });
      }
      case THETA_WORKFLOW_STATES.monitorTraining: {
        const training = requireRecord(
          variables.trainingReceipt,
          "training receipt",
        );
        const status = await invoke(THETA_TOOL_IDS.trainingStatus, {
          trainingRunId: requiredString(
            training.trainingRunId,
            "trainingRunId",
          ),
          logLimit: 1,
        });
        const normalizedStatus = (
          stringValue(status.status) ?? "unknown"
        ).toLowerCase();
        const receipt =
          status.found === false
            ? {
                ...training,
                status: "quarantined",
                quarantineReason:
                  "Training runtime no longer contains the bound training run.",
              }
            : requireRecord(status.receipt, "training status receipt");
        if (["completed", "succeeded", "success"].includes(normalizedStatus)) {
          const plan = requireRecord(variables.planRecord, "plan record");
          const validatedPlan = requireRecord(
            variables.validatedPlan,
            "validated plan",
          );
          return transition(
            THETA_WORKFLOW_STATES.completed,
            {
              trainingReceipt: sanitizeTrainingReceipt(receipt),
            },
            {
              runId: execution.scope.runId,
              status: normalizedStatus,
              modelId: requiredString(validatedPlan.modelId, "modelId"),
              planId: requiredString(plan.planId, "planId"),
              trainingRunId: requiredString(
                status.trainingRunId,
                "trainingRunId",
              ),
              artifacts: arrayValue(receipt.resultArtifacts).map(
                sanitizeArtifact,
              ),
            },
          );
        }
        if (["failed", "error"].includes(normalizedStatus)) {
          return transition(THETA_WORKFLOW_STATES.failed, {
            trainingReceipt: sanitizeTrainingReceipt(receipt),
          });
        }
        if (normalizedStatus === "cancelled") {
          return transition(THETA_WORKFLOW_STATES.cancelled, {
            trainingReceipt: sanitizeTrainingReceipt(receipt),
          });
        }
        if (
          normalizedStatus === "quarantined" ||
          normalizedStatus === "not_found" ||
          !["queued", "running", "cancel_requested"].includes(normalizedStatus)
        ) {
          return transition(THETA_WORKFLOW_STATES.quarantined, {
            trainingReceipt: sanitizeTrainingReceipt(receipt),
          });
        }
        return {
          result: {
            kind: "waiting",
            wait: {
              type: "timer",
              expiresAt: new Date(Date.parse(now()) + 3_000).toISOString(),
              reason:
                "Training is still running; poll again after the durable timer fires.",
              metadata: sanitizeTrainingReceipt(receipt) as Record<
                string,
                RuntimeJsonValue
              >,
            },
          },
        };
      }
      default:
        return failed(
          "RUNTIME_STATE_NOT_FOUND",
          `THETA workflow has no executor for state ${execution.state.id}.`,
          execution.state.id,
        );
    }
  } catch (error) {
    return failed(
      "RUNTIME_INTERNAL_ERROR",
      error instanceof Error ? error.message : String(error),
      execution.state.id,
    );
  }
};

const approvalDecision = (
  execution: BoundedStateExecutorInput,
  variables: Record<string, unknown>,
  pendingActionRef: string,
  approvedTarget: string,
  metadata: Record<string, RuntimeJsonValue> = {},
  ignoredResumeAt?: string,
): BoundedStateExecutionDecision => {
  const payload = isRecord(execution.projection.lastResume?.payload)
    ? execution.projection.lastResume.payload
    : undefined;
  const isFreshResume =
    execution.projection.lastResume?.resumedAt !== ignoredResumeAt;
  if (isFreshResume && payload?.pendingActionRef === pendingActionRef) {
    if (payload.decision === "rejected") {
      return failed(
        "RUNTIME_CANCELLED",
        `Human rejected ${pendingActionRef}.`,
        execution.state.id,
      );
    }
    if (payload.decision === "approved") {
      const priorActors = isRecord(variables.approvalActors)
        ? variables.approvalActors
        : {};
      return transition(approvedTarget, {
        approvalActors: {
          ...priorActors,
          [pendingActionRef]:
            execution.projection.lastResume?.principalId ?? USER_ID,
        },
        approvalDecisions: {
          ...(isRecord(variables.approvalDecisions)
            ? variables.approvalDecisions
            : {}),
          [pendingActionRef]: {
            approvedBy: execution.projection.lastResume?.principalId ?? USER_ID,
            approvedAt:
              execution.projection.lastResume?.resumedAt ??
              new Date().toISOString(),
          },
        },
      });
    }
  }
  return {
    result: {
      kind: "waiting",
      wait: {
        type: "human",
        pendingActionRef,
        reason: `Explicit owner approval is required for ${pendingActionRef}.`,
        metadata: { stateId: execution.state.id, ...metadata },
      },
    },
  };
};

const approvalDecisionRecord = (
  variables: Record<string, unknown>,
  key: string,
): { approvedBy: string; approvedAt: string } => {
  const decisions = requireRecord(
    variables.approvalDecisions,
    "approval decisions",
  );
  const decision = requireRecord(
    decisions[key],
    `approval decision for ${key}`,
  );
  return {
    approvedBy: requiredString(decision.approvedBy, `approvedBy for ${key}`),
    approvedAt: requiredString(decision.approvedAt, `approvedAt for ${key}`),
  };
};

const requiresStructuredHumanInput = (
  pendingActionRef: string | undefined,
): boolean =>
  pendingActionRef === THETA_APPROVAL_KEYS.researchClarification ||
  pendingActionRef === THETA_APPROVAL_KEYS.columnConfirmation ||
  pendingActionRef === THETA_APPROVAL_KEYS.datasetUnderstanding ||
  pendingActionRef === THETA_APPROVAL_KEYS.researchIntent;

const datasetUnderstandingWait = (
  understanding: DatasetUnderstandingDraft,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "waiting",
    wait: {
      type: "human",
      pendingActionRef: THETA_APPROVAL_KEYS.datasetUnderstanding,
      reason:
        "请确认系统对数据领域、分析单位和列角色的理解；如有错误，请在一次提交中更正。",
      metadata: understanding as unknown as Record<string, RuntimeJsonValue>,
    },
  },
});

const researchIntentWait = (
  gap: DecisionGap,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "waiting",
    wait: {
      type: "human",
      pendingActionRef: THETA_APPROVAL_KEYS.researchIntent,
      reason: gap.question,
      metadata: gap as unknown as Record<string, RuntimeJsonValue>,
    },
  },
});

const researchClarificationWait = (
  assessment: ResearchAssessment,
  stateAttempt = 1,
): BoundedStateExecutionDecision => {
  const grilling = decideResearchGrilling(assessment, stateAttempt);
  return {
    result: {
      kind: "waiting",
      wait: {
        type: "human",
        pendingActionRef: THETA_APPROVAL_KEYS.researchClarification,
        reason:
          (grilling.kind === "unresolved"
            ? `${grilling.activeQuestion ?? "仍有研究信息未明确"} 你可以回答“不知道”或“不适用”，或使用 /brief 查看当前记录。`
            : grilling.activeQuestion) ??
          "Structured research clarification is required.",
        metadata: sanitizeResearchAssessment(assessment),
      },
    },
  };
};

const columnConfirmationWait = (
  profile: DatasetProfile,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "waiting",
    wait: {
      type: "human",
      pendingActionRef: THETA_APPROVAL_KEYS.columnConfirmation,
      reason:
        "Confirm text, time, ID, training-covariate, descriptive-metadata, display-group, and evaluation-label roles for this dataset hash.",
      metadata: {
        datasetSha256: profile.datasetSha256,
        columns: profile.columns,
        columnCandidates: profile.columnCandidates,
      },
    },
  },
});

const sanitizeResearchAssessment = (
  assessment: ResearchAssessment,
): Record<string, RuntimeJsonValue> =>
  runtimeRecord({
    brief: assessment.brief,
    gaps: assessment.gaps,
    conflicts: assessment.conflicts,
    questions: assessment.questions,
    blocking: assessment.blocking,
  });

const researchPlanningContext = (
  variables: Record<string, unknown>,
  currentState: string,
  stateAttempt: number,
): {
  currentState: string;
  askedCounts?: Readonly<Record<string, number>>;
  recentlyAskedGapId?: string;
  datasetProfile?: DatasetProfile;
} => {
  const previousAssessment = isRecord(variables.researchAssessment)
    ? variables.researchAssessment
    : undefined;
  const previousQuestion = previousAssessment
    ? arrayValue(previousAssessment.questions)
        .map((item) => (isRecord(item) ? item : undefined))
        .find((item) => item !== undefined)
    : undefined;
  const recentlyAskedGapId = previousQuestion
    ? stringValue(previousQuestion.gapId)
    : undefined;
  const datasetProfile = isRecord(variables.datasetProfile)
    ? datasetProfileSchema.parse(variables.datasetProfile)
    : undefined;
  return {
    currentState,
    ...(recentlyAskedGapId
      ? {
          recentlyAskedGapId,
          askedCounts: {
            [recentlyAskedGapId]: Math.max(1, stateAttempt),
          },
        }
      : {}),
    ...(datasetProfile ? { datasetProfile } : {}),
  };
};

const planningInvalidationPatch = (
  variables: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  approvalActors: withoutPlanningApprovalKeys(variables.approvalActors),
  approvalDecisions: withoutPlanningApprovalKeys(variables.approvalDecisions),
  planRecord: null,
  planReview: null,
  dryRun: null,
  trainingReview: null,
  validation: null,
  validatedPlan: null,
  planAdjustment: null,
  processedPlanAdjustmentHash: null,
  planAdjustmentResumeAt: null,
});

const withoutPlanningApprovalKeys = (value: unknown): RuntimeJsonValue => {
  if (!isRecord(value)) return {};
  return runtimeRecord(
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          key !== THETA_APPROVAL_KEYS.planReview &&
          key !== THETA_APPROVAL_KEYS.trainingReview,
      ),
    ),
  );
};

const validateConfirmedColumns = (
  confirmation: ColumnConfirmationDraft,
  profile: DatasetProfile,
): void => {
  const selected = [
    ...confirmation.textColumns,
    ...(confirmation.timeColumn ? [confirmation.timeColumn] : []),
    ...(confirmation.idColumn ? [confirmation.idColumn] : []),
    ...(confirmation.covariateColumns ?? []),
    ...confirmation.metadataColumns,
    ...(confirmation.groupingColumns ?? []),
    ...(confirmation.evaluationLabelColumns ?? []),
  ];
  const unknown = selected.filter((name) => !profile.columns.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Column confirmation references unknown columns: ${unique(unknown).join(", ")}.`,
    );
  }
  const assignments = new Map<string, string[]>();
  const assign = (name: string, role: string): void => {
    assignments.set(name, [...(assignments.get(name) ?? []), role]);
  };
  confirmation.textColumns.forEach((name) => assign(name, "text"));
  if (confirmation.timeColumn) assign(confirmation.timeColumn, "time");
  if (confirmation.idColumn) assign(confirmation.idColumn, "id");
  (confirmation.covariateColumns ?? []).forEach((name) => assign(name, "covariate"));
  confirmation.metadataColumns.forEach((name) => assign(name, "metadata"));
  (confirmation.groupingColumns ?? []).forEach((name) => assign(name, "grouping"));
  (confirmation.evaluationLabelColumns ?? []).forEach((name) => assign(name, "evaluation_label"));
  const overlap = [...assignments].find(([, roles]) => {
    const uniqueRoles = new Set(roles);
    return roles.length > 1 && !(
      uniqueRoles.size === 2 &&
      uniqueRoles.has("covariate") &&
      uniqueRoles.has("grouping")
    );
  });
  if (overlap) {
    throw new Error(`Column ${overlap[0]} has conflicting roles: ${overlap[1].join(", ")}.`);
  }
  const profiles = new Map(profile.columnProfiles.map((item) => [item.name, item]));
  const idLike = (name: string): boolean =>
    /(?:^|_)(?:id|uuid|key|index|record_id)(?:$|_)/iu.test(name);
  for (const column of confirmation.textColumns) {
    const item = profiles.get(column);
    if (
      idLike(column) ||
      item?.inferredType === "number" ||
      item?.inferredType === "datetime" ||
      item?.inferredType === "empty" ||
      (item && item.avgLength < 8 && item.inferredType !== "text")
    ) {
      throw new Error(`Column ${column} failed the text-column type check.`);
    }
  }
  if (confirmation.timeColumn) {
    const item = profiles.get(confirmation.timeColumn);
    if (item && item.inferredType !== "datetime") {
      throw new Error(`Column ${confirmation.timeColumn} failed the time-column parse check.`);
    }
  }
  if (confirmation.idColumn) {
    const item = profiles.get(confirmation.idColumn);
    const ratio = item && item.nonEmptySampleCount > 0
      ? item.uniqueSampleCount / item.nonEmptySampleCount
      : 0;
    if (!idLike(confirmation.idColumn) && item && ratio < 0.8) {
      throw new Error(`Column ${confirmation.idColumn} failed the ID uniqueness check.`);
    }
  }
  for (const column of [
    ...(confirmation.covariateColumns ?? []),
    ...(confirmation.groupingColumns ?? []),
  ]) {
    const item = profiles.get(column);
    const ratio = item && item.nonEmptySampleCount > 0
      ? item.uniqueSampleCount / item.nonEmptySampleCount
      : 0;
    if (item && (item.inferredType === "text" || ratio > 0.8)) {
      throw new Error(`Column ${column} is not a safe low-cardinality covariate/grouping column.`);
    }
  }
};

const transition = (
  to: string,
  variablesPatch?: Record<string, unknown>,
  output?: unknown,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "completed",
    ...(variablesPatch === undefined
      ? {}
      : { variablesPatch: variablesPatch as Record<string, RuntimeJsonValue> }),
    ...(output === undefined ? {} : { output: output as RuntimeJsonValue }),
  },
  transition: { to },
});

const failed = (
  code:
    | "RUNTIME_INVARIANT_FAILED"
    | "RUNTIME_INTERNAL_ERROR"
    | "RUNTIME_STATE_NOT_FOUND"
    | "RUNTIME_CANCELLED",
  message: string,
  stateId: string,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "failed",
    error: { code, message, retryable: false, stateId },
  },
});

const seedRun = async (
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>["events"],
  scope: RuntimeScope,
  input: ThetaWorkflowInput,
  timestamp: string,
): Promise<void> => {
  const existing = await events.getStreamHead(streamScope(scope));
  if (existing) return;
  const event = (
    id: string,
    type: EventCreateInput["type"],
    payload: Record<string, unknown>,
  ): EventCreateInput => ({
    id,
    type,
    version: "1.0.0",
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    runId: scope.runId,
    agentId: scope.agentId,
    correlationId: scope.runId,
    timestamp,
    payload,
  });
  await events.append({
    scope: streamScope(scope),
    events: [
      event(`${scope.runId}:created`, "run.created", { runId: scope.runId }),
      event(`${scope.runId}:started`, "run.started", {
        runId: scope.runId,
        input,
      }),
    ],
    expectedLastSequence: 0,
    idempotencyKey: `theta-workflow-seed:${scope.runId}`,
  });
};

const hydrateVariables = async (
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>["events"],
  scope: RuntimeScope,
): Promise<Record<string, unknown>> => {
  const stream = await events.read({ scope: streamScope(scope) });
  const variables: Record<string, unknown> = {};
  for (const event of stream) {
    if (event.type === "run.started") {
      const input = recordProperty(event.payload, "input");
      if (input) variables.input = input;
    }
    if (event.type === "fsm.transition.accepted") {
      const patch = recordProperty(event.payload, "variablesPatch");
      if (patch) Object.assign(variables, patch);
    }
    if (
      event.type === "reasoning.decision.recorded" &&
      stringProperty(event.payload, "pendingActionRef")
    ) {
      const researchAnswers = recordProperty(event.payload, "researchAnswers");
      if (researchAnswers) {
        variables.researchAnswers = {
          ...(isRecord(variables.researchAnswers)
            ? variables.researchAnswers
            : {}),
          ...researchAnswers,
        };
      }
      const columnConfirmation = recordProperty(
        event.payload,
        "columnConfirmation",
      );
      if (columnConfirmation) {
        variables.columnConfirmation = columnConfirmation;
      }
      const datasetConfirmation = recordProperty(
        event.payload,
        "datasetConfirmation",
      );
      if (datasetConfirmation) {
        variables.datasetConfirmationSubmission = datasetConfirmation;
      }
      const decisionAnswer = stringProperty(event.payload, "decisionAnswer");
      if (decisionAnswer) {
        variables.decisionAnswer = decisionAnswer;
        variables.decisionAnswerActionRef = stringProperty(
          event.payload,
          "pendingActionRef",
        );
      }
      const planAdjustment = recordProperty(event.payload, "planAdjustment");
      if (planAdjustment) {
        variables.planAdjustment = planAdjustment;
      }
    }
  }
  return variables;
};

const runtimeVariable = (
  variables: Record<string, unknown>,
  key:
    | 'candidatePlan'
    | 'validatedPlan'
    | 'planRecord'
    | 'planReview'
    | 'recommendation'
    | 'evidenceBundle'
    | 'planProposal'
    | 'plannerResolution'
    | 'validation'
    | 'planAdjustment'
    | 'datasetProfile'
    | 'columnConfirmation'
    | 'dryRun'
    | 'trainingReview'
    | 'trainingReceipt'
    | 'datasetFacts'
    | 'datasetUnderstanding'
    | 'datasetConfirmation'
    | 'researchIntent'
    | 'researchIntentSummary'
    | 'plannerInputV2'
    | 'plannerDecisionV2'
    | 'plannerValidationV2'
    | 'plannerPresentationV2',
): Partial<ThetaWorkflowPlan> => {
  const value = variables[key];
  return value === undefined ? {} : { [key]: value as RuntimeJsonValue };
};

const sanitizePlanAdjustment = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => {
  const output: Record<string, RuntimeJsonValue> = {};
  const modelId = stringValue(value.modelId);
  const mode = stringValue(value.mode);
  const topicCountMode = stringValue(value.topicCountMode);
  const numTopics = numberValue(value.numTopics);
  const maxTopics = numberValue(value.maxTopics);
  const batchSize = numberValue(value.batchSize);
  const epochs = numberValue(value.epochs);
  const covariateColumns = stringArray(value.covariateColumns);
  const acceptDegradation = value.acceptDegradation === true;
  const experimentProtocol = value.experimentProtocol;
  if (modelId) output.modelId = modelId.toLowerCase();
  if (
    mode &&
    ["zero_shot", "supervised", "unsupervised"].includes(mode)
  ) {
    output.mode = mode;
  }
  if (
    topicCountMode &&
    ["fixed", "auto", "target_reduction"].includes(topicCountMode)
  ) {
    output.topicCountMode = topicCountMode;
  }
  if (value.numTopics === null) {
    output.numTopics = null;
  } else if (numTopics !== undefined) {
    if (!Number.isInteger(numTopics) || numTopics < 2 || numTopics > 200) {
      throw new Error("主题数必须是 2 到 200 之间的整数。");
    }
    output.numTopics = numTopics;
  }
  if (maxTopics !== undefined) {
    if (!Number.isInteger(maxTopics) || maxTopics < 2 || maxTopics > 1000) {
      throw new Error("最大主题数必须是 2 到 1000 之间的整数。");
    }
    output.maxTopics = maxTopics;
  }
  if (batchSize !== undefined) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("批大小必须是正整数。");
    }
    output.batchSize = batchSize;
  }
  if (epochs !== undefined) {
    if (!Number.isInteger(epochs) || epochs < 1) {
      throw new Error("迭代次数必须是正整数。");
    }
    output.epochs = epochs;
  }
  if (value.covariateColumns !== undefined) {
    if (!Array.isArray(value.covariateColumns)) {
      throw new Error("协变量必须是列名数组。");
    }
    output.covariateColumns = [...new Set(covariateColumns)];
  }
  if (acceptDegradation) output.acceptDegradation = true;
  if (experimentProtocol !== undefined) {
    output.experimentProtocol = canonicalExperimentProtocolSchema.parse(
      experimentProtocol,
    ) as RuntimeJsonValue;
  }
  if (Object.keys(output).length === 0) {
    throw new Error("没有识别出可调整的模型或参数。");
  }
  return output;
};

const planFieldsFromAdjustment = (
  value: Record<string, RuntimeJsonValue>,
): Record<string, RuntimeJsonValue> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'acceptDegradation'),
  );

const sanitizeDatasetProfile = (
  inspection: Record<string, unknown>,
  columns: Record<string, unknown>,
): DatasetProfile => {
  const columnNames = stringArray(inspection.columns);
  const profiles = arrayValue(inspection.columnProfiles).map((value) =>
    isRecord(value) ? value : {},
  );
  const missingRatio =
    profiles.length === 0
      ? 0
      : profiles.reduce(
          (total, profile) =>
            total + (numberValue(profile.missingSampleRatio) ?? 0),
          0,
        ) / profiles.length;
  const textCandidateName = arrayValue(columns.textColumns)
    .map((candidate) =>
      isRecord(candidate) ? stringValue(candidate.name) : undefined,
    )
    .find((name): name is string => Boolean(name));
  const textProfile = profiles.find(
    (profile) => stringValue(profile.name) === textCandidateName,
  );
  const averageTextLength = numberValue(textProfile?.avgLength) ?? 0;
  const maximumTextLength = numberValue(textProfile?.maxLength) ?? 0;
  return datasetProfileSchema.parse({
    schemaVersion: RESEARCH_CONTRACT_VERSION,
    datasetSha256: requiredString(inspection.datasetSha256, "datasetSha256"),
    fileName: stringValue(inspection.fileName) ?? "unknown",
    fileSizeBytes: numberValue(inspection.fileSizeBytes) ?? 0,
    format: stringValue(inspection.suffix)?.replace(/^\./, "") || "unknown",
    encoding: stringValue(inspection.encoding) ?? "unknown",
    rowCount: numberValue(inspection.rowCount) ?? 0,
    sampledRowCount: numberValue(inspection.sampleRowCount) ?? 0,
    profileScope:
      (numberValue(inspection.sampleRowCount) ?? 0) >=
      (numberValue(inspection.rowCount) ?? 0)
        ? "full"
        : "sample",
    estimationWarnings:
      (numberValue(inspection.sampleRowCount) ?? 0) <
      (numberValue(inspection.rowCount) ?? 0)
        ? [
            `重复率、语言、文本长度和时间覆盖基于前 ${String(numberValue(inspection.sampleRowCount) ?? 0)} 行样本估计，不代表全量精确统计。`,
          ]
        : [],
    columnCount: columnNames.length,
    columns: columnNames,
    columnProfiles: profiles.map((profile) => ({
      name: requiredString(profile.name, "column profile name"),
      inferredType: stringValue(profile.inferredType) ?? "empty",
      nonEmptySampleCount: numberValue(profile.nonEmptySampleCount) ?? 0,
      uniqueSampleCount: numberValue(profile.uniqueSampleCount) ?? 0,
      avgLength: numberValue(profile.avgLength) ?? 0,
      maxLength: numberValue(profile.maxLength) ?? 0,
    })),
    missingRatio:
      numberValue(textProfile?.missingSampleRatio) ?? missingRatio,
    duplicateRatio: numberValue(inspection.sampleDuplicateRatio) ?? 0,
    textLengthDistribution: {
      average: averageTextLength,
      maximum: maximumTextLength,
    },
    languageDistribution: arrayValue(inspection.languageDistribution).map(
      (value) => {
        const distribution = isRecord(value) ? value : {};
        return {
          language: stringValue(distribution.language) ?? "unknown",
          ratio: numberValue(distribution.ratio) ?? 0,
        };
      },
    ),
    timeCoverage: {
      start: nullableStringProperty(inspection.timeCoverage, "start"),
      end: nullableStringProperty(inspection.timeCoverage, "end"),
    },
    columnCandidates: {
      text: sanitizeCandidates(columns.textColumns),
      time: sanitizeCandidates(columns.timeColumns),
      metadata: sanitizeCandidates(columns.metadataColumns),
    },
    sensitiveRiskCodes: sensitiveRiskCodes(columnNames),
    ...(isRecord(inspection.inferredDomain)
      ? {
          inferredDomain: {
            label:
              stringValue(inspection.inferredDomain.label) ?? '通用文本分析',
            confidence:
              numberValue(inspection.inferredDomain.confidence) ?? 0.35,
            evidence: arrayValue(inspection.inferredDomain.evidence)
              .map(stringValue)
              .filter((value): value is string => Boolean(value))
              .slice(0, 8),
          },
        }
      : {}),
  });
};

const v2DecisionGapContext = (
  variables: Record<string, unknown>,
): { decisionGap: DecisionGap } | Record<string, never> => {
  const understanding = datasetUnderstandingDraftSchema.safeParse(
    variables.datasetUnderstanding,
  );
  const confirmation = datasetConfirmationSchema.safeParse(
    variables.datasetConfirmation,
  );
  const intent = researchIntentSchema.safeParse(variables.researchIntent);
  if (!understanding.success || !confirmation.success || !intent.success) {
    return {};
  }
  const memory = interviewMemorySchema.safeParse(variables.interviewMemory);
  const nextGap = selectNextDecisionGap(
    deriveDecisionGaps(understanding.data, confirmation.data, intent.data),
    memory.success ? memory.data : emptyInterviewMemory(),
  );
  return nextGap ? { decisionGap: nextGap } : {};
};

const isV2Workflow = (input: Record<string, unknown>): boolean =>
  input.workflowVersion === '2.0.0';

const applyDatasetConfirmationToUnderstanding = (
  facts: DatasetFacts,
  understanding: DatasetUnderstandingDraft,
  confirmation: DatasetConfirmation,
  generatedAt: string,
): DatasetUnderstandingDraft => {
  const available = new Set(facts.columns.map((column) => column.name));
  const roleEntries = (
    columns: string[] | undefined,
    fallback: DatasetUnderstandingDraft['textColumns'],
    role: string,
  ): DatasetUnderstandingDraft['textColumns'] => {
    const source = columns ?? fallback.map((entry) => entry.column);
    return [...new Set(source)].filter((column) => available.has(column)).map((column) => ({
      column,
      confidence: 1,
      reason: `User confirmed ${column} as ${role}.`,
    }));
  };
  return datasetUnderstandingDraftSchema.parse({
    ...understanding,
    domain: {
      label: confirmation.domainLabel,
      confidence: 1,
      evidence: [`User-confirmed domain: ${confirmation.domainLabel}`],
    },
    analysisUnit: confirmation.analysisUnit,
    textColumns: roleEntries(confirmation.textColumns, understanding.textColumns, 'text'),
    timeColumns: roleEntries(confirmation.timeColumns, understanding.timeColumns, 'time'),
    idColumns: roleEntries(confirmation.idColumns, understanding.idColumns, 'identifier'),
    metadataColumns: roleEntries(confirmation.metadataColumns, understanding.metadataColumns, 'metadata'),
    groupColumns: roleEntries(confirmation.groupColumns, understanding.groupColumns, 'display/comparison group'),
    covariateColumns: roleEntries(confirmation.covariateColumns, understanding.covariateColumns, 'training covariate'),
    evaluationColumns: roleEntries(confirmation.evaluationColumns, understanding.evaluationColumns, 'evaluation-only'),
    ignoredColumns: roleEntries(confirmation.ignoredColumns, understanding.ignoredColumns, 'ignored'),
    provenance: {
      ...understanding.provenance,
      source: confirmation.status === 'corrected' ? 'user' : 'hybrid',
      toolIds: [...new Set([...understanding.provenance.toolIds, 'theta.dataset.confirm'])],
      generatedAt,
    },
  });
};

const deterministicDatasetUnderstanding = async (
  datasetRef: string,
  explore: (input: { datasetRef: string; sheetName?: string }) => Promise<ThetaDatasetExploreOutput>,
): Promise<DatasetUnderstandingLanguageLoopResult> => {
  const output = await explore({ datasetRef });
  const facts = buildDatasetFacts(output);
  return {
    facts,
    draft: buildDeterministicUnderstanding(facts, output),
    source: 'deterministic',
    explorationCalls: 1,
    fallbackReason: 'consent_required',
  };
};

const v2DataProfile = (
  facts: DatasetFacts,
  confirmation: DatasetConfirmation,
): Record<string, unknown> => ({
  datasetSha256: facts.datasetHash,
  rowCount: facts.rowCount,
  columns: facts.columns.map((column) => column.name),
  columnProfiles: facts.columns,
  languageDistribution: facts.languageDistribution,
  duplicateRatio: facts.duplicateRatio,
  qualityWarnings: facts.qualityWarnings,
  sensitiveDataRisk: facts.sensitiveDataRisk,
  textColumns: confirmation.textColumns,
  timeColumns: confirmation.timeColumns,
});

const researchIntentReviewWait = (
  summary: ResearchIntentSummary,
): BoundedStateExecutionDecision => ({
  result: {
    kind: 'waiting',
    wait: {
      type: 'human',
      pendingActionRef: THETA_APPROVAL_KEYS.researchIntentReview,
      reason: '请确认研究意图摘要。确认后才会生成方案；如需修改，请直接用自然语言说明。',
      metadata: summary as unknown as Record<string, RuntimeJsonValue>,
    },
  },
});

const plannerDecisionToTrainingPlan = (
  facts: DatasetFacts,
  confirmation: DatasetConfirmation,
  decision: ReturnType<typeof plannerDecisionV2Schema.parse>,
): ThetaTrainingPlan => {
  const parameters = { ...decision.parameters };
  const mode = parameters.mode === 'zero_shot' || parameters.mode === 'supervised'
    ? parameters.mode
    : 'unsupervised';
  const topicCountMode = decision.modelId === 'hdp'
    ? 'auto'
    : decision.modelId === 'bertopic'
      ? (typeof parameters.numTopics === 'number' ? 'target_reduction' : 'auto')
      : parameters.topicCountMode === 'auto' || parameters.topicCountMode === 'target_reduction'
        ? parameters.topicCountMode
        : 'fixed';
  const numTopics = typeof parameters.numTopics === 'number'
    ? parameters.numTopics
    : topicCountMode === 'auto' ? null : 10;
  const maxTopics = typeof parameters.maxTopics === 'number'
    ? parameters.maxTopics
    : decision.modelId === 'hdp' ? 30 : null;
  delete parameters.mode;
  delete parameters.topicCountMode;
  delete parameters.numTopics;
  delete parameters.maxTopics;
  return {
    datasetId: facts.datasetRef,
    modelId: decision.modelId,
    mode,
    topicCountMode,
    numTopics,
    maxTopics,
    textColumn: confirmation.textColumns[0],
    timeColumn: confirmation.timeColumns[0] ?? null,
    idColumn: confirmation.idColumns[0] ?? null,
    covariateColumns: confirmation.covariateColumns ?? [],
    metadataColumns: confirmation.metadataColumns,
    groupingColumns: confirmation.groupColumns ?? [],
    evaluationLabelColumns: confirmation.evaluationColumns ?? [],
    ...parameters,
    experimentProtocol: {
      mode: decision.experiment.mode,
      primarySeeds: decision.experiment.primarySeeds,
      baselineModelId: decision.baselineModelId,
      baselineSeeds: decision.experiment.baselineSeeds,
      rationale: decision.experiment.rationale,
      evidenceRefs: decision.evidenceRefs,
      confidence: decision.evidenceRefs.length ? 'high' : 'low',
    },
  };
};

const sanitizeCandidates = (
  value: unknown,
): Array<{ name: string; score: number; reason: string }> =>
  arrayValue(value).map((candidate) => {
    const item = isRecord(candidate) ? candidate : {};
    return {
      name: stringValue(item.name) ?? "",
      score: numberValue(item.score) ?? 0,
      reason: stringValue(item.reason) ?? "",
    };
  });

const sensitiveRiskCodes = (columns: readonly string[]): string[] => {
  const risks = new Set<string>();
  for (const column of columns) {
    const normalized = column.toLowerCase();
    if (/(email|e-mail)/.test(normalized)) risks.add("possible_email");
    if (/(phone|mobile|tel)/.test(normalized)) risks.add("possible_phone");
    if (/(name|user_name|username)/.test(normalized))
      risks.add("possible_person_name");
    if (/(address|location|gps)/.test(normalized))
      risks.add("possible_location");
    if (/(id_card|identity|passport|ssn)/.test(normalized))
      risks.add("possible_government_id");
  }
  return [...risks].sort();
};

const sanitizeCatalog = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  source: "theta-model-catalog",
  supportedModelIds: stringArray(value.supportedModelIds),
});

const sanitizeRecommendation = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  schemaVersion: stringValue(value.schemaVersion) ?? "1.0.0",
  deterministic: value.deterministic === true,
  recommendationVersion: stringValue(value.recommendationVersion) ?? "1.0.0",
  catalogSource: stringValue(value.catalogSource) ?? "unknown",
  dataProfileSummary: (isRecord(value.dataProfileSummary)
    ? value.dataProfileSummary
    : {}) as Record<string, RuntimeJsonValue>,
  recommendations: arrayValue(value.recommendations) as RuntimeJsonValue[],
  skipped: arrayValue(value.skipped) as RuntimeJsonValue[],
  warnings: stringArray(value.warnings),
  constraintsApplied: (isRecord(value.constraintsApplied)
    ? value.constraintsApplied
    : {}) as Record<string, RuntimeJsonValue>,
  researchRequirements: (isRecord(value.researchRequirements)
    ? value.researchRequirements
    : {
        required: [],
        preferred: [],
        reasons: {},
      }) as Record<string, RuntimeJsonValue>,
  degradation: (isRecord(value.degradation)
    ? value.degradation
    : {
        required: false,
        unmetRequirements: [],
        message: null,
      }) as Record<string, RuntimeJsonValue>,
  noEvidence: value.noEvidence === true,
});

const candidatePlan = (
  input: Record<string, unknown>,
  datasetProfile: Record<string, unknown>,
  recommendation: Record<string, unknown>,
  columnConfirmation: Record<string, unknown>,
): ThetaTrainingPlan => {
  if (isRecord(input.plan)) return input.plan as ThetaTrainingPlan;
  const top = isRecord(arrayValue(recommendation.recommendations)[0])
    ? (arrayValue(recommendation.recommendations)[0] as Record<string, unknown>)
    : {};
  const patch = isRecord(top.recommendedPlanPatch)
    ? top.recommendedPlanPatch
    : {};
  const constraints = isRecord(input.constraints) ? input.constraints : {};
  const fileName = stringValue(datasetProfile.fileName) ?? "dataset";
  return {
    ...patch,
    datasetId: stringValue(input.datasetId) ?? path.parse(fileName).name,
    modelId: requiredString(
      top.modelId ?? patch.modelId,
      "recommendation.modelId",
    ),
    mode: normalizedMode(patch.mode),
    topicCountMode: normalizedTopicCountMode(
      patch.topicCountMode,
      requiredString(top.modelId ?? patch.modelId, "recommendation.modelId"),
    ),
    ...(patch.numTopics === null
      ? { numTopics: null }
      : numberValue(patch.numTopics) !== undefined
        ? { numTopics: numberValue(patch.numTopics) as number }
        : {}),
    ...(patch.maxTopics === null
      ? { maxTopics: null }
      : numberValue(patch.maxTopics) !== undefined
        ? { maxTopics: numberValue(patch.maxTopics) as number }
        : {}),
    ...(stringArray(columnConfirmation.textColumns)[0]
      ? { textColumn: stringArray(columnConfirmation.textColumns)[0] }
      : {}),
    ...(stringValue(columnConfirmation.timeColumn)
      ? { timeColumn: stringValue(columnConfirmation.timeColumn) as string }
      : {}),
    ...(stringValue(columnConfirmation.idColumn)
      ? { idColumn: stringValue(columnConfirmation.idColumn) as string }
      : {}),
    covariateColumns: stringArray(columnConfirmation.covariateColumns),
    metadataColumns: stringArray(columnConfirmation.metadataColumns),
  };
};

const normalizedMode = (value: unknown): ThetaTrainingPlan["mode"] => {
  const mode = stringValue(value);
  return mode &&
    ["zero_shot", "supervised", "unsupervised"].includes(mode)
    ? (mode as ThetaTrainingPlan["mode"])
    : "unsupervised";
};

const normalizedTopicCountMode = (
  value: unknown,
  modelId: string,
): NonNullable<ThetaTrainingPlan["topicCountMode"]> => {
  const mode = stringValue(value);
  return mode && ["fixed", "auto", "target_reduction"].includes(mode)
    ? (mode as NonNullable<ThetaTrainingPlan["topicCountMode"]>)
    : modelId === "hdp"
      ? "auto"
      : "fixed";
};

const sanitizeArtifact = (value: unknown): Record<string, RuntimeJsonValue> => {
  const artifact = isRecord(value) ? value : {};
  return {
    kind: stringValue(artifact.kind) ?? "artifact",
    path: stringValue(artifact.path) ?? "",
    description: stringValue(artifact.description) ?? "",
    ...(typeof artifact.exists === "boolean"
      ? { exists: artifact.exists }
      : {}),
    ...(stringValue(artifact.fileType)
      ? { fileType: stringValue(artifact.fileType) as string }
      : {}),
    ...(typeof artifact.sizeBytes === "number" || artifact.sizeBytes === null
      ? { sizeBytes: artifact.sizeBytes as number | null }
      : {}),
    ...(typeof artifact.sha256 === "string" || artifact.sha256 === null
      ? { sha256: artifact.sha256 as string | null }
      : {}),
  };
};

const sanitizeTrainingReceipt = (
  receipt: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  trainingRunId: requiredString(receipt.trainingRunId, "trainingRunId"),
  attempt: numberValue(receipt.attempt) ?? 1,
  retryOfTrainingRunId: stringValue(receipt.retryOfTrainingRunId) ?? null,
  idempotencyKey: requiredString(receipt.idempotencyKey, "idempotencyKey"),
  planId: requiredString(receipt.planId, "planId"),
  planHash: requiredString(receipt.planHash, "planHash"),
  planReviewApprovalId: requiredString(
    receipt.planReviewApprovalId,
    "planReviewApprovalId",
  ),
  trainingReviewApprovalId: requiredString(
    receipt.trainingReviewApprovalId,
    "trainingReviewApprovalId",
  ),
  dryRunHash: requiredString(receipt.dryRunHash, "dryRunHash"),
  status: stringValue(receipt.status) ?? "unknown",
  executionStatus:
    stringValue(receipt.executionStatus) ?? stringValue(receipt.status) ?? "unknown",
  quality: sanitizeRuntimeValue(receipt.quality),
  progress: numberValue(receipt.progress) ?? 0,
  currentStep: stringValue(receipt.currentStep) ?? "unknown",
  logPath: stringValue(receipt.logPath) ?? null,
  pythonExecutable: stringValue(receipt.pythonExecutable) ?? "unknown",
  pythonVersion: stringValue(receipt.pythonVersion) ?? "unknown",
  pythonEnvironment: stringValue(receipt.pythonEnvironment) ?? null,
  analysisBindings: (isRecord(receipt.analysisBindings)
      ? receipt.analysisBindings
      : {
        timeColumn: null,
        covariateColumns: [],
        metadataColumns: [],
        temporalArtifactsRequested: false,
        groupArtifactsRequested: false,
      }) as Record<string, RuntimeJsonValue>,
  resultArtifacts: arrayValue(receipt.resultArtifacts).map(sanitizeArtifact),
  errorMessage: stringValue(receipt.errorMessage) ?? null,
  failure: sanitizeRuntimeValue(receipt.failure),
  quarantineReason: stringValue(receipt.quarantineReason) ?? null,
  cancellation: sanitizeRuntimeValue(receipt.cancellation),
});

const approvalActor = (
  variables: Record<string, unknown>,
  key: string,
): string => {
  const actors = requireRecord(variables.approvalActors, "approval actors");
  return requiredString(actors[key], `approval actor for ${key}`);
};

const completedOutput = (
  toolId: string,
  result: ToolCallResult,
): Record<string, unknown> => {
  if (result.status !== "completed" || !isRecord(result.output)) {
    const detail =
      typeof result.error === "string"
        ? result.error
        : (result.error?.message ?? `status=${result.status}`);
    throw new Error(`Governed tool ${toolId} did not complete: ${detail}`);
  }
  return result.output;
};

const toRunResult = (
  runId: string,
  runtimeDb: string,
  result: BoundedFSMDriverResult,
  output?: RuntimeJsonValue,
): ThetaWorkflowRunResult => ({
  runId,
  runtimeDb,
  disposition: result.disposition,
  status: result.projection.runStatus,
  ...(result.projection.currentState
    ? { currentState: result.projection.currentState }
    : {}),
  ...(result.projection.pendingWait?.pendingActionRef
    ? { pendingActionRef: result.projection.pendingWait.pendingActionRef }
    : {}),
  ...(result.projection.pendingWait?.reason
    ? { pendingReason: result.projection.pendingWait.reason }
    : {}),
  statePath: result.projection.statePath,
  ...(output === undefined ? {} : { output }),
});

const toStatusResult = (
  runId: string,
  runtimeDb: string,
  projection: RuntimeOrchestrationProjection,
  eventCount: number,
  lastEventType: string,
  lastEventAt: string,
  output?: RuntimeJsonValue,
): ThetaWorkflowStatus => ({
  runId,
  runtimeDb,
  status: projection.runStatus,
  ...(projection.currentState
    ? { currentState: projection.currentState }
    : {}),
  ...(projection.pendingWait?.pendingActionRef
    ? { pendingActionRef: projection.pendingWait.pendingActionRef }
    : {}),
  ...(projection.pendingWait?.reason
    ? { pendingReason: projection.pendingWait.reason }
    : {}),
  statePath: projection.statePath,
  eventCount,
  lastEventType,
  lastEventAt,
  ...(output === undefined ? {} : { output }),
});

const terminalOutput = async (
  runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
  scope: RuntimeScope,
): Promise<RuntimeJsonValue | undefined> => {
  const terminal = [
    ...(await runtime.events.read({ scope: streamScope(scope) })),
  ]
    .reverse()
    .find((event) => event.type === "run.completed");
  return recordProperty(terminal?.payload, "output") as
    | RuntimeJsonValue
    | undefined;
};

const invocationKey = (request: ThetaWorkflowToolRequest): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        runId: request.runId,
        stateId: request.stateId,
        stateAttempt: request.stateAttempt,
        toolId: request.toolId,
        input: request.input,
      }),
    )
    .digest("hex");

const runtimeScope = (runId: string): RuntimeScope => ({
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  sessionId: `session:${runId}`,
  runId,
  agentId: AGENT_ID,
});

const streamScope = (scope: RuntimeScope) => ({
  ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
  userId: scope.userId,
  runId: scope.runId,
});

const prepareWorkflowInput = async (
  input: ThetaWorkflowInput,
  runtimeDb: string,
): Promise<ThetaWorkflowInput> => {
  const workflowVersion = resolveWorkflowVersion({
    isNewRun: true,
    ...(input.workflowVersion
      ? { requestedVersion: input.workflowVersion }
      : {}),
  });
  if (workflowVersion !== "2.0.0" || input.datasetRef) {
    return {
      ...input,
      workflowVersion,
      ...(workflowVersion === '2.0.0' ? { plannerMode: 'minimax' as const } : {}),
    };
  }
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  try {
    const dataset = await registry.registerLocalFile(input.filePath, {
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    return {
      ...input,
      workflowVersion,
      plannerMode: 'minimax',
      datasetRef: dataset.datasetRef,
    };
  } finally {
    registry.close();
  }
};

const syncV2ResearchReadModel = async (
  runtimeDb: string,
  runId: string,
  variables: Record<string, unknown>,
): Promise<void> => {
  const input = isRecord(variables.input) ? variables.input : undefined;
  if (input?.workflowVersion !== "2.0.0") return;
  const store = new SQLiteV2ResearchStore(runtimeDb);
  try {
    const facts = datasetFactsSchema.safeParse(variables.datasetFacts);
    if (facts.success) {
      const previous = store.latestFacts(runId);
      if (!previous || canonicalJson(previous.value) !== canonicalJson(facts.data)) {
        if (previous && previous.value.datasetHash !== facts.data.datasetHash) {
          store.invalidateAfterDatasetHashChange(runId, facts.data.datasetHash);
        }
        store.appendFacts(runId, facts.data);
      }
      store.saveRemoteSampleConsent({
        runId,
        datasetRef: facts.data.datasetRef,
        datasetHash: facts.data.datasetHash,
        allowed: input?.allowRemoteSamples === true,
        maxRows: 10,
        policyVersion: '1.0.0',
        grantedBy: USER_ID,
        grantedAt: new Date().toISOString(),
      });
      const sampleReceipt = isRecord(variables.remoteSampleReceipt)
        ? variables.remoteSampleReceipt
        : undefined;
      if (
        sampleReceipt &&
        typeof sampleReceipt.payloadHash === 'string' &&
        typeof sampleReceipt.rowCount === 'number' &&
        typeof sampleReceipt.redactedValueCount === 'number'
      ) {
        store.saveRemoteSampleReceipt({
          runId,
          datasetHash: facts.data.datasetHash,
          provider: 'minimax-openai-compatible',
          model: process.env.MINIMAX_MODEL?.trim() || 'MiniMax-M2.7',
          payloadHash: sampleReceipt.payloadHash,
          rowCount: sampleReceipt.rowCount,
          redactedValueCount: sampleReceipt.redactedValueCount,
          redactionRules: arrayValue(sampleReceipt.redactionRules)
            .filter((value): value is string => typeof value === 'string'),
          createdAt: new Date().toISOString(),
        });
      }
    }
    const understanding = datasetUnderstandingDraftSchema.safeParse(
      variables.datasetUnderstanding,
    );
    if (understanding.success) {
      const previous = store.latestUnderstanding(runId);
      if (
        !previous ||
        canonicalJson(previous.value) !== canonicalJson(understanding.data)
      ) {
        store.appendUnderstanding(runId, understanding.data);
      }
    }
    const confirmation = datasetConfirmationSchema.safeParse(
      variables.datasetConfirmation,
    );
    if (confirmation.success) {
      store.saveConfirmation(runId, confirmation.data);
    }
    const intent = researchIntentSchema.safeParse(variables.researchIntent);
    if (intent.success) {
      const previous = store.latestIntent(runId);
      if (!previous || canonicalJson(previous.value) !== canonicalJson(intent.data)) {
        store.appendIntent(runId, intent.data);
      }
    }
    const memory = interviewMemorySchema.safeParse(variables.interviewMemory);
    if (memory.success) {
      store.saveInterviewMemory(runId, memory.data);
    }
    const plannerInput = plannerInputV2Schema.safeParse(variables.plannerInputV2);
    const plannerDecision = plannerDecisionV2Schema.safeParse(variables.plannerDecisionV2);
    const plannerValidation = isRecord(variables.plannerValidationV2)
      ? variables.plannerValidationV2
      : undefined;
    const plannerPresentation = isRecord(variables.plannerPresentationV2)
      ? variables.plannerPresentationV2
      : undefined;
    if (
      plannerInput.success &&
      plannerDecision.success &&
      plannerValidation &&
      plannerPresentation
    ) {
      store.savePlannerV2({
        runId,
        datasetHash: plannerInput.data.facts.datasetHash,
        input: plannerInput.data,
        decision: plannerDecision.data,
        validation: validatePlannerDecisionV2(plannerInput.data, plannerDecision.data),
        presentation: plannerPresentation,
        createdAt: new Date().toISOString(),
      });
    }
  } finally {
    store.close();
  }
};

const validateInput = (input: ThetaWorkflowInput): void => {
  if (!input || typeof input !== "object")
    throw new Error("Workflow input must be an object.");
  required(input.filePath, "input.filePath");
  if (
    input.workflowVersion !== undefined &&
    input.workflowVersion !== "1.0.0" &&
    input.workflowVersion !== "2.0.0"
  ) {
    throw new Error("input.workflowVersion must be 1.0.0 or 2.0.0.");
  }
  if (input.plannerMode !== undefined && input.plannerMode !== "deterministic" && input.plannerMode !== "minimax") {
    throw new Error("input.plannerMode must be deterministic or minimax.");
  }
  if (
    input.allowRemoteSamples !== undefined &&
    typeof input.allowRemoteSamples !== 'boolean'
  ) {
    throw new Error('input.allowRemoteSamples must be a boolean.');
  }
  if (
    input.sampleSize !== undefined &&
    (!Number.isInteger(input.sampleSize) ||
      input.sampleSize < 1 ||
      input.sampleSize > 1000)
  ) {
    throw new Error("input.sampleSize must be an integer from 1 to 1000.");
  }
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const evidenceExecutions = (
  queries: readonly EvidenceQuery[],
  results: readonly Record<string, unknown>[],
): EvidenceQueryExecution[] => {
  if (queries.length !== results.length) {
    throw new Error("Evidence query/result count mismatch.");
  }
  return queries.map((query, index) => {
    const result = results[index] ?? {};
    const rawTrace = isRecord(result.retrievalTrace)
      ? result.retrievalTrace
      : {};
    const trace: RetrievalTrace = {
      schemaVersion: "1.0.0",
      subqueries: [],
      routesUsed: stringArray(rawTrace.routesUsed).filter(
        (item): item is RetrievalTrace["routesUsed"][number] =>
          ["exact", "fts_raw", "fts_tokens", "fts_grams"].includes(item),
      ),
      candidateCount: numberValue(rawTrace.candidateCount) ?? 0,
      selectedCount: numberValue(rawTrace.selectedCount) ?? 0,
      sourceCap: numberValue(rawTrace.sourceCap) ?? 3,
      coverage: stringArray(rawTrace.coverage),
      noEvidence: rawTrace.noEvidence !== false,
    };
    return {
      query,
      evidence: arrayValue(result.evidence).map((item) =>
        evidenceRefSchema.parse(item),
      ),
      trace,
    };
  });
};

const runtimeRecord = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> =>
  JSON.parse(JSON.stringify(value)) as Record<string, RuntimeJsonValue>;

const sanitizeRuntimeValue = (value: unknown): RuntimeJsonValue => {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as RuntimeJsonValue;
};

const latestTimerReceipt = (
  events: readonly FrameworkEvent[],
): RuntimeJsonValue | undefined => {
  const event = [...events]
    .reverse()
    .find((item) => item.type === "run.waiting_timer");
  const payload = event && isRecord(event.payload) ? event.payload : undefined;
  const wait = payload && isRecord(payload.wait) ? payload.wait : undefined;
  return wait?.metadata === undefined
    ? undefined
    : sanitizeRuntimeValue(wait.metadata);
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const stringArray = (value: unknown): string[] =>
  arrayValue(value).filter((item): item is string => typeof item === "string");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const requireRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
};
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const requiredString = (value: unknown, label: string): string => {
  const resolved = stringValue(value);
  if (!resolved) throw new Error(`${label} is required.`);
  return resolved;
};
const required = (value: string, label: string): string =>
  requiredString(value, label);
const recordProperty = (
  value: unknown,
  property: string,
): Record<string, unknown> | undefined => {
  const record = isRecord(value) ? value : undefined;
  return isRecord(record?.[property]) ? record[property] : undefined;
};
const stringProperty = (
  value: unknown,
  property: string,
): string | undefined =>
  isRecord(value) ? stringValue(value[property]) : undefined;
const nullableStringProperty = (
  value: unknown,
  property: string,
): string | null =>
  isRecord(value) ? (stringValue(value[property]) ?? null) : null;
