import { z } from "zod";
import {
  expectedArtifactSchema,
  trainingCommandSchema,
} from "../planning/contracts.js";

export const TRAINING_RUNTIME_SCHEMA_VERSION = "1.0.0";

export const trainingRunStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "quarantined",
]);

export const trainingPhaseSchema = z.enum([
  "preparing",
  "preprocessing",
  "training",
  "evaluating",
  "visualizing",
  "packaging",
  "completed",
]);

export const trainingPhaseContextSchema = z.object({
  modelId: z.string().min(1).nullable(),
  seed: z.number().int().nullable(),
  runIndex: z.number().int().positive().nullable(),
  totalRuns: z.number().int().positive().nullable(),
}).strict();

export const boundResultArtifactSchema = z
  .object({
    kind: z.string().min(1),
    path: z.string().min(1),
    description: z.string(),
    exists: z.boolean(),
    fileType: z.enum(["file", "directory", "missing"]),
    sizeBytes: z.number().int().nonnegative().nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

export const cancellationReceiptSchema = z
  .object({
    cancellationId: z.string().regex(/^cancel_[a-f0-9]{20}$/),
    trainingRunId: z.string().regex(/^run_[a-f0-9]{12}$/),
    operator: z.string().min(1),
    reason: z.string().min(1),
    requestedAt: z.string().datetime(),
    targetPid: z.number().int().positive().nullable(),
    gracefulResult: z.enum(["pending", "not_required", "succeeded", "failed"]),
    forcedResult: z.enum(["pending", "not_required", "succeeded", "failed"]),
  })
  .strict();

export const trainingFailureSchema = z
  .object({
    code: z.string().min(1),
    stage: z.string().min(1),
    summary: z.string().min(1),
    technicalDetail: z.string().min(1),
    retryable: z.boolean(),
    suggestedCommands: z.array(z.string().min(1)),
    partialArtifactsAvailable: z.boolean(),
  })
  .strict();

export const trainingQualitySchema = z
  .object({
    modelId: z.string().min(1).optional(),
    profileVersion: z.string().min(1).optional(),
    status: z.enum(["passed", "warning", "failed"]),
    checks: z.array(
      z
        .object({
          code: z.string().min(1),
          status: z.enum(["pass", "warn", "fail"]),
          detail: z.string().min(1),
          value: z.number().optional(),
        })
        .strict(),
    ),
    assessedAt: z.string().datetime(),
  })
  .strict();

export const qualityReassessmentReceiptSchema = z.object({
  receiptId: z.string().regex(/^quality_reassessment_[a-f0-9]{20}$/),
  trainingRunId: z.string().regex(/^run_[a-f0-9]{12}$/),
  artifactSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactHashes: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }).strict()),
  modelId: z.string().min(1),
  profileVersion: z.string().min(1),
  qualityStatus: z.enum(["passed", "warning", "failed"]),
  checks: trainingQualitySchema.shape.checks,
  assessedAt: z.string().datetime(),
}).strict();

export const trainingReceiptSchema = z
  .object({
    schemaVersion: z.literal(TRAINING_RUNTIME_SCHEMA_VERSION),
    trainingRunId: z.string().regex(/^run_[a-f0-9]{12}$/),
    attempt: z.number().int().positive(),
    retryOfTrainingRunId: z
      .string()
      .regex(/^run_[a-f0-9]{12}$/)
      .nullable(),
    idempotencyKey: z.string().min(1),
    planId: z.string().regex(/^plan_[a-f0-9]{16}$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    planReviewApprovalId: z.string().regex(/^approval_[a-f0-9]{20}$/),
    trainingReviewApprovalId: z.string().regex(/^approval_[a-f0-9]{20}$/),
    dryRunHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: trainingRunStatusSchema,
    executionStatus: trainingRunStatusSchema.optional(),
    quality: trainingQualitySchema.or(z.object({}).strict()).default({}),
    progress: z.number().min(0).max(100),
    processStarted: z.boolean(),
    pid: z.number().int().positive().nullable(),
    runnerPid: z.number().int().positive().nullable(),
    activePid: z.number().int().positive().nullable(),
    currentStep: z.string().min(1),
    currentPhase: trainingPhaseSchema,
    phaseContext: trainingPhaseContextSchema,
    phaseUpdatedAt: z.string().datetime(),
    logPath: z.string().min(1).nullable(),
    pythonExecutable: z.string().min(1),
    pythonVersion: z.string().min(1),
    pythonEnvironment: z.string().min(1).nullable(),
    commands: z.array(trainingCommandSchema).min(1),
    analysisBindings: z
      .object({
        timeColumn: z.string().min(1).nullable(),
        covariateColumns: z.array(z.string().min(1)).default([]),
        metadataColumns: z.array(z.string().min(1)),
        temporalArtifactsRequested: z.boolean(),
        groupArtifactsRequested: z.boolean(),
      })
      .strict()
      .default({
        timeColumn: null,
        covariateColumns: [],
        metadataColumns: [],
        temporalArtifactsRequested: false,
        groupArtifactsRequested: false,
      }),
    expectedArtifacts: z.array(expectedArtifactSchema),
    resultArtifacts: z.array(boundResultArtifactSchema),
    errorMessage: z.string().min(1).nullable(),
    failure: trainingFailureSchema.nullable(),
    quarantineReason: z.string().min(1).nullable(),
    cancellation: cancellationReceiptSchema.nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    message: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.planReviewApprovalId === value.trainingReviewApprovalId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trainingReviewApprovalId"],
        message: "Training and plan review approvals must be distinct.",
      });
    }
    if (value.status === "quarantined" && value.quarantineReason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quarantineReason"],
        message: "Quarantined runs require a reason.",
      });
    }
  });

export const trainingLifecycleEventSchema = z
  .object({
    type: z.string().min(1),
    payload: z.record(z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

export const trainingStatusOutputSchema = z.discriminatedUnion("found", [
  z
    .object({
      trainingRunId: z.string().min(1),
      found: z.literal(false),
      status: z.literal("not_found"),
      logs: z.array(z.string()),
      events: z.array(trainingLifecycleEventSchema),
      reassessed: z.boolean().optional(),
      reassessmentReceipt: qualityReassessmentReceiptSchema.optional(),
    })
    .strict(),
  z
    .object({
      trainingRunId: z.string().regex(/^run_[a-f0-9]{12}$/),
      found: z.literal(true),
      receipt: trainingReceiptSchema,
      status: trainingRunStatusSchema,
      logs: z.array(z.string()),
      events: z.array(trainingLifecycleEventSchema),
      reassessed: z.boolean().optional(),
      reassessmentReceipt: qualityReassessmentReceiptSchema.optional(),
    })
    .strict(),
]);

export type TrainingRunStatus = z.infer<typeof trainingRunStatusSchema>;
export type BoundResultArtifact = z.infer<typeof boundResultArtifactSchema>;
export type CancellationReceipt = z.infer<typeof cancellationReceiptSchema>;
export type TrainingFailure = z.infer<typeof trainingFailureSchema>;
export type TrainingReceipt = z.infer<typeof trainingReceiptSchema>;
export type TrainingStatusOutput = z.infer<typeof trainingStatusOutputSchema>;
