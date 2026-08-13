import { z } from "zod";
import { evidenceRefSchema } from "../rag/contracts.js";
import {
  evidenceSelectionReceiptSchema,
  plannerInputSnapshotSchema,
} from '../planner/contracts.js';

export const TRAINING_PLAN_SCHEMA_VERSION = "2.0.0";
export const trainingPlanSchemaVersionSchema = z.enum(["1.0.0", "2.0.0"]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const parameterDecisionValueSchema = z.union([
  scalarSchema,
  z.null(),
  z.array(z.union([scalarSchema, z.null()])),
]);

export const parameterDecisionSchema = z
  .object({
    recommendedValue: parameterDecisionValueSchema,
    effectiveValue: parameterDecisionValueSchema,
    source: z.enum([
      "system_recommendation",
      "user_override",
      "validator_correction",
    ]),
    rationale: z.string().min(1).max(1200).optional(),
    overriddenAt: z.string().datetime().optional(),
  })
  .strict();

export const parameterDecisionMapSchema = z.record(
  z.string().min(1),
  parameterDecisionSchema,
);

export type ParameterDecision = z.infer<typeof parameterDecisionSchema>;
export type ParameterDecisionMap = z.infer<typeof parameterDecisionMapSchema>;

export const canonicalExperimentProtocolSchema = z
  .object({
    mode: z.enum(["quick", "comparative", "stability"]),
    primarySeeds: z.array(z.number().int().min(0).max(2_147_483_647)).min(1).max(5),
    baselineModelId: z.string().min(1).nullable(),
    baselineSeeds: z.array(z.number().int().min(0).max(2_147_483_647)).max(3),
    rationale: z.string().min(1).max(1200),
    evidenceRefs: z.array(z.string().min(1)).max(8),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict()
  .superRefine((protocol, context) => {
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
  });

export const canonicalTrainingPlanSchema = z
  .object({
    schemaVersion: trainingPlanSchemaVersionSchema,
    datasetId: z.string().min(1),
    datasetSha256: sha256Schema,
    model: z
      .object({
        modelId: z.string().min(1),
        mode: z.enum(["zero_shot", "supervised", "unsupervised"]),
        topicCountMode: z.enum(["fixed", "auto", "target_reduction"]),
        numTopics: z.number().int().min(2).max(200).nullable(),
        maxTopics: z.number().int().min(2).max(1000).nullable(),
        parameters: z.record(scalarSchema),
      })
      .strict()
      .superRefine((model, context) => {
        if (
          ["fixed", "target_reduction"].includes(model.topicCountMode) &&
          model.numTopics === null
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["numTopics"],
            message: `${model.topicCountMode} requires numTopics.`,
          });
        }
        if (model.topicCountMode === "auto" && model.numTopics !== null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["numTopics"],
            message: "auto topic mode must not bind numTopics.",
          });
        }
        if (
          model.topicCountMode === "auto" &&
          model.modelId === "hdp" &&
          model.maxTopics === null
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["maxTopics"],
            message: "HDP auto topic mode requires maxTopics.",
          });
        }
      }),
    columns: z
      .object({
        textColumns: z.array(z.string().min(1)).min(1),
        timeColumn: z.string().min(1).nullable(),
        idColumn: z.string().min(1).nullable(),
        covariateColumns: z.array(z.string().min(1)),
        metadataColumns: z.array(z.string().min(1)),
        groupingColumns: z.array(z.string().min(1)),
        evaluationLabelColumns: z.array(z.string().min(1)),
      })
      .strict(),
    preprocessing: z
      .object({
        trimWhitespace: z.boolean(),
        dropEmptyText: z.boolean(),
        deduplicate: z.boolean(),
      })
      .strict(),
    resources: z
      .object({
        device: z.enum(["cpu", "gpu", "unknown"]),
        memoryGb: z.number().positive().nullable(),
        networkAllowed: z.boolean(),
      })
      .strict(),
    experimentProtocol: canonicalExperimentProtocolSchema,
    bindings: z
      .object({
        researchBriefHash: sha256Schema,
        datasetProfileHash: sha256Schema,
        columnConfirmationHash: sha256Schema,
        recommendationHash: sha256Schema,
        evidenceBundleHash: sha256Schema,
        planProposalHash: sha256Schema,
        plannerResolutionHash: sha256Schema,
        domainPackId: z.string().min(1),
        domainPackVersion: z.string().min(1),
        recommendationVersion: z.string().min(1),
        validatorVersion: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const planReviewSnapshotSchema = z
  .object({
    researchQuestion: z.string().min(1),
    datasetFileName: z.string().min(1),
    datasetRowCount: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)),
    reasonCodes: z.array(z.string().min(1)),
    evidence: z.array(evidenceRefSchema),
    evidenceBundleHash: sha256Schema,
    planProposalSource: z.enum(["minimax", "deterministic", "explicit_user_plan"]),
    plannerAcceptedEvidenceRefs: z.array(z.string().min(1)),
    evidenceSelectionReceipts: z.array(evidenceSelectionReceiptSchema),
    plannerInputSnapshot: plannerInputSnapshotSchema.optional(),
    parameterDecisions: parameterDecisionMapSchema.optional(),
    validatorVersion: z.string().min(1),
  })
  .strict();

export const trainingPlanRecordSchema = z
  .object({
    schemaVersion: trainingPlanSchemaVersionSchema,
    planId: z.string().regex(/^plan_[a-f0-9]{16}$/),
    planHash: sha256Schema,
    planVersion: z.number().int().positive(),
    status: z.enum(["draft", "superseded"]),
    revisionOfPlanId: z.string().regex(/^plan_[a-f0-9]{16}$/).optional(),
    revisionOfPlanHash: sha256Schema.optional(),
    canonicalPlan: canonicalTrainingPlanSchema,
    review: planReviewSnapshotSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const approvalTypeSchema = z.enum([
  "human_plan_review",
  "human_training_review",
]);

export const approvalReceiptSchema = z
  .object({
    schemaVersion: trainingPlanSchemaVersionSchema,
    approvalId: z.string().regex(/^approval_[a-f0-9]{20}$/),
    approvalType: approvalTypeSchema,
    planId: z.string().regex(/^plan_[a-f0-9]{16}$/),
    planHash: sha256Schema,
    dryRunHash: sha256Schema.nullable(),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.approvalType === "human_plan_review" &&
      value.dryRunHash !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dryRunHash"],
        message: "Plan review must not bind a dry-run hash.",
      });
    }
    if (
      value.approvalType === "human_training_review" &&
      value.dryRunHash === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dryRunHash"],
        message: "Training review must bind a dry-run hash.",
      });
    }
  });

export const dryRunCheckSchema = z
  .object({
    code: z.string().min(1),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string().min(1),
  })
  .strict();

export const trainingCommandSchema = z
  .object({
    step: z.string().min(1),
    cwd: z.string().min(1),
    argv: z.array(z.string()).min(1),
    sideEffect: z.string().min(1),
  })
  .strict();

export const expectedArtifactSchema = z
  .object({
    kind: z.string().min(1),
    path: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const dryRunReceiptSchema = z
  .object({
    schemaVersion: trainingPlanSchemaVersionSchema,
    dryRunId: z.string().regex(/^dryrun_[a-f0-9]{16}$/),
    dryRunHash: sha256Schema,
    planId: z.string().regex(/^plan_[a-f0-9]{16}$/),
    planHash: sha256Schema,
    planReviewApprovalId: z.string().regex(/^approval_[a-f0-9]{20}$/),
    passed: z.boolean(),
    checks: z.array(dryRunCheckSchema).min(1),
    commands: z.array(trainingCommandSchema).min(1),
    expectedArtifacts: z.array(expectedArtifactSchema),
    notes: z.array(z.string()),
    checkedAt: z.string().datetime(),
  })
  .strict();

export type CanonicalTrainingPlan = z.infer<typeof canonicalTrainingPlanSchema>;
export type TrainingPlanRecord = z.infer<typeof trainingPlanRecordSchema>;
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;
export type DryRunCheck = z.infer<typeof dryRunCheckSchema>;
export type DryRunReceipt = z.infer<typeof dryRunReceiptSchema>;
