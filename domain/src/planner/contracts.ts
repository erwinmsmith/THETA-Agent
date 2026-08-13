import { z } from "zod";

export const PLANNER_CONTRACT_VERSION = "1.0.0";
const bounded = z.string().trim().min(1).max(1200);
const refs = z.array(z.string().trim().min(1).max(180)).max(8);

export const plannerConfidenceSchema = z.enum(["low", "medium", "high"]);
export const plannerRoleSchema = z.enum(["primary", "baseline", "alternative"]);

export const plannerStageSchema = z.enum([
  "analyze_brief",
  "build_retrieval_queries",
  "retrieve_evidence",
  "draft_proposal",
  "select_evidence",
  "resolve_plan",
  "validate_plan",
  "bounded_retry",
  "final_review",
]);

export const plannerProgressEventSchema = z.object({
  stage: plannerStageSchema,
  status: z.enum(["started", "completed", "failed"]),
  attempt: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  elapsedMs: z.number().int().nonnegative(),
  detail: z.string().trim().min(1).max(240).optional(),
}).strict();

export const evidenceSelectionIssueSchema = z.object({
  targetId: z.string().min(1),
  evidenceId: z.string().min(1).nullable(),
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const evidenceSelectionReceiptSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  receiptId: z.string().regex(/^evidence_selection_[a-f0-9]{20}$/),
  evidenceBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  factsHash: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  outcome: z.enum(["accepted", "rejected"]),
  availableEvidenceIds: z.array(z.string().min(1)).optional(),
  acceptedEvidenceIds: z.array(z.string().min(1)).optional(),
  rejectedEvidence: z.array(evidenceSelectionIssueSchema).optional(),
  bindings: z.array(z.object({
    targetId: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
    compatible: z.boolean(),
  }).strict()),
  issues: z.array(evidenceSelectionIssueSchema),
  createdAt: z.string().datetime(),
}).strict();

export const experimentProtocolSchema = z
  .object({
    mode: z.enum(["quick", "comparative", "stability"]),
    primarySeeds: z.array(z.number().int().min(0).max(2_147_483_647)).min(1).max(5),
    baselineModelId: z.string().trim().min(1).max(80).nullable(),
    baselineSeeds: z.array(z.number().int().min(0).max(2_147_483_647)).max(3),
    rationale: bounded,
    evidenceRefs: refs,
    confidence: plannerConfidenceSchema,
  })
  .strict()
  .superRefine((protocol, context) => {
    validateExperimentProtocolShape(protocol, context);
  });

const validateExperimentProtocolShape = (
  protocol: {
    mode: "quick" | "comparative" | "stability";
    primarySeeds: number[];
    baselineModelId: string | null;
    baselineSeeds: number[];
  },
  context: z.RefinementCtx,
): void => {
  const issue = (path: string[], message: string): void => {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  if (new Set(protocol.primarySeeds).size !== protocol.primarySeeds.length) {
    issue(["primarySeeds"], "primarySeeds must be unique.");
  }
  if (new Set(protocol.baselineSeeds).size !== protocol.baselineSeeds.length) {
    issue(["baselineSeeds"], "baselineSeeds must be unique.");
  }
  if (protocol.primarySeeds.length + protocol.baselineSeeds.length > 6) {
    issue([], "Experiment protocol may contain at most six real training runs.");
  }
  if (
    protocol.mode === "quick" &&
    (protocol.primarySeeds.length !== 1 ||
      protocol.baselineModelId !== null ||
      protocol.baselineSeeds.length > 0)
  ) {
    issue([], "quick mode requires one primary seed and no baseline.");
  }
  if (protocol.mode === "comparative" && protocol.baselineModelId === null) {
    issue(["baselineModelId"], "comparative mode requires a baseline model.");
  }
  if (protocol.mode === "stability" && protocol.primarySeeds.length < 3) {
    issue(["primarySeeds"], "stability mode requires at least three primary seeds.");
  }
  if (protocol.baselineModelId === null && protocol.baselineSeeds.length > 0) {
    issue(["baselineSeeds"], "baseline seeds require a baseline model.");
  }
  if (protocol.baselineModelId !== null && protocol.baselineSeeds.length === 0) {
    issue(["baselineSeeds"], "A baseline model requires at least one seed.");
  }
};

export const parameterCandidateSchema = z
  .object({
    field: z.string().trim().min(1).max(80),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    rationale: bounded,
    evidenceRefs: refs,
    confidence: plannerConfidenceSchema,
  })
  .strict();

const plannerSkeletonParameterSchema = z
  .object({
    field: z.string().trim().min(1).max(80),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    rationale: z.string().trim().min(1).max(240),
  })
  .strict();

export const plannerSkeletonDecisionSchema = z
  .object({
    modelId: z.string().trim().min(1).max(80),
    rationale: z.string().trim().min(1).max(320),
    parameters: z.array(plannerSkeletonParameterSchema).max(3).default([]),
  })
  .strict();

export const plannerSkeletonSchema = z
  .object({
    schemaVersion: z.literal(PLANNER_CONTRACT_VERSION),
    summary: z.string().trim().min(1).max(320),
    primary: plannerSkeletonDecisionSchema,
    baseline: plannerSkeletonDecisionSchema.nullable().default(null),
    alternatives: z.array(plannerSkeletonDecisionSchema).max(1).default([]),
    experimentProtocol: z
      .object({
        mode: z.enum(["quick", "comparative", "stability"]),
        primarySeeds: z.array(z.number().int().min(0).max(2_147_483_647)).min(1).max(3),
        baselineModelId: z.string().trim().min(1).max(80).nullable(),
        baselineSeeds: z.array(z.number().int().min(0).max(2_147_483_647)).max(1),
        rationale: z.string().trim().min(1).max(320),
      })
      .strict(),
    openQuestions: z.array(z.string().trim().min(1).max(240)).max(3).default([]),
  })
  .strict();

export const modelDecisionSchema = z
  .object({
    role: plannerRoleSchema,
    modelId: z.string().trim().min(1).max(80),
    choice: bounded,
    evidenceRefs: refs,
    confidence: plannerConfidenceSchema,
    assumptions: z.array(bounded).max(8),
    risks: z.array(bounded).max(8),
    alternativesConsidered: z.array(z.string().trim().min(1).max(80)).max(8),
    parameterCandidates: z.array(parameterCandidateSchema).max(20),
  })
  .strict();

export const groundedPlanItemSchema = z
  .object({
    choice: bounded,
    evidenceRefs: refs,
    confidence: plannerConfidenceSchema,
    assumptions: z.array(bounded).max(6),
    risks: z.array(bounded).max(6),
    alternativesConsidered: z.array(bounded).max(6),
  })
  .strict();

export const plannerToolRequestSchema = z
  .object({
    toolId: z.enum([
      "dataset_profiler",
      "time_slice_profiler",
      "metadata_balance_profiler",
      "dependency_checker",
      "hardware_profiler",
      "catalog_lookup",
      "rag_retrieval",
    ]),
    reason: bounded,
  })
  .strict();

export const planProposalDraftSchema = z
  .object({
    schemaVersion: z.literal(PLANNER_CONTRACT_VERSION),
    summary: bounded,
    primary: modelDecisionSchema.extend({ role: z.literal("primary") }),
    baseline: modelDecisionSchema.extend({ role: z.literal("baseline") }).nullable(),
    alternatives: z.array(modelDecisionSchema.extend({ role: z.literal("alternative") })).max(2),
    experimentProtocol: experimentProtocolSchema,
    preprocessing: z.array(groundedPlanItemSchema).min(1).max(6),
    evaluation: z.array(groundedPlanItemSchema).min(1).max(8),
    visualizations: z.array(bounded).max(8),
    requestedTools: z.array(plannerToolRequestSchema).max(8),
    openQuestions: z.array(bounded).max(8),
  })
  .strict();

export const plannerInputSectionSchema = z.enum([
  'researchBrief',
  'datasetProfile',
  'columnConfirmation',
  'recommendation',
  'evidenceBundle',
]);

export const plannerInputSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PLANNER_CONTRACT_VERSION),
    researchBriefHash: z.string().regex(/^[a-f0-9]{64}$/),
    datasetProfileHash: z.string().regex(/^[a-f0-9]{64}$/),
    columnConfirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
    recommendationHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    factsHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const plannerInputChangeSchema = z
  .object({
    changed: z.boolean(),
    changedSections: z.array(plannerInputSectionSchema),
    previousSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    currentSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvalInvalidated: z.boolean(),
  })
  .strict();

export const planProposalResultSchema = z
  .object({
    schemaVersion: z.literal(PLANNER_CONTRACT_VERSION),
    source: z.enum(["minimax", "deterministic"]),
    fallbackReason: z.enum([
      "planner_not_enabled",
      "provider_not_configured",
      "network_failure",
      "timeout",
      "provider_error",
      "schema_validation_failed",
      "evidence_violation",
      "catalog_violation",
    ]).optional(),
    fallbackDetail: z.string().trim().min(1).max(500).optional(),
    boundaryAdjustments: z.array(bounded).max(12).optional(),
    factsHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputSnapshot: plannerInputSnapshotSchema,
    plannerProgress: z.array(plannerProgressEventSchema).optional(),
    evidenceSelectionReceipts: z.array(evidenceSelectionReceiptSchema).default([]),
    draft: planProposalDraftSchema,
  })
  .strict();

export type ParameterCandidate = z.infer<typeof parameterCandidateSchema>;
export type PlannerSkeleton = z.infer<typeof plannerSkeletonSchema>;
export type PlannerSkeletonDecision = z.infer<typeof plannerSkeletonDecisionSchema>;
export type ModelDecision = z.infer<typeof modelDecisionSchema>;
export type ExperimentProtocol = z.infer<typeof experimentProtocolSchema>;
export type PlanProposalDraft = z.infer<typeof planProposalDraftSchema>;
export type PlanProposalResult = z.infer<typeof planProposalResultSchema>;
export type PlannerInputSection = z.infer<typeof plannerInputSectionSchema>;
export type PlannerInputSnapshot = z.infer<typeof plannerInputSnapshotSchema>;
export type PlannerInputChange = z.infer<typeof plannerInputChangeSchema>;
export type PlannerFallbackReason = NonNullable<PlanProposalResult["fallbackReason"]>;
export type EvidenceSelectionIssue = z.infer<typeof evidenceSelectionIssueSchema>;
export type EvidenceSelectionReceipt = z.infer<typeof evidenceSelectionReceiptSchema>;
export type PlannerProgressEvent = z.infer<typeof plannerProgressEventSchema>;
