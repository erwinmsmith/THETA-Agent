import { createHash } from "node:crypto";
import type { EvidenceRef } from "../rag/contracts.js";
import type { EvidenceBundle } from "../rag/evidence-bundle.js";
import type {
  EvidenceSelectionIssue,
  EvidenceSelectionReceipt,
} from "./contracts.js";
import {
  EvidenceSelectionError,
  type EvidenceSelectionTarget,
  type SelectedEvidence,
} from "./select-evidence-tool.js";

export interface ValidateEvidenceSelectionInput {
  bundle: EvidenceBundle;
  targets: readonly EvidenceSelectionTarget[];
  selections: readonly SelectedEvidence[];
  factsHash: string;
  attempt: number;
  provider: string;
  model: string;
}

export class EvidenceCompatibilityError extends EvidenceSelectionError {
  constructor(
    message: string,
    readonly receipt: EvidenceSelectionReceipt,
  ) {
    super(message);
  }
}

export const createRejectedEvidenceSelectionReceipt = (
  input: Omit<ValidateEvidenceSelectionInput, "selections">,
  error: EvidenceSelectionError,
): EvidenceSelectionReceipt => {
  const issues: EvidenceSelectionIssue[] = [{
    targetId: error.targetId ?? "selection",
    evidenceId: error.evidenceId,
    code: error.receiptCode,
    message: error.message,
  }];
  const receiptMaterial = {
    schemaVersion: "1.0.0" as const,
    evidenceBundleHash: input.bundle.bundleHash,
    factsHash: input.factsHash,
    attempt: input.attempt,
    provider: input.provider,
    model: input.model,
    outcome: "rejected" as const,
    availableEvidenceIds: input.bundle.evidence.map((item) => item.evidenceId),
    acceptedEvidenceIds: [],
    rejectedEvidence: issues,
    bindings: input.targets.map((target) => ({
      targetId: target.targetId,
      evidenceIds: [],
      compatible: false,
    })),
    issues,
  };
  return {
    ...receiptMaterial,
    receiptId: `evidence_selection_${sha256(receiptMaterial).slice(0, 20)}`,
    createdAt: new Date().toISOString(),
  };
};

export const validateEvidenceSelections = (
  input: ValidateEvidenceSelectionInput,
): EvidenceSelectionReceipt => {
  const evidenceById = new Map(
    input.bundle.evidence.map((item) => [item.evidenceId, item]),
  );
  const targetById = new Map(input.targets.map((item) => [item.targetId, item]));
  const issues: EvidenceSelectionIssue[] = [];
  const bindings = input.selections.map((selection) => {
    const target = targetById.get(selection.targetId);
    if (!target) {
      issues.push({
        targetId: selection.targetId,
        evidenceId: null,
        code: "EVIDENCE_TARGET_MISMATCH",
        message: "Evidence target is outside the current Planner draft.",
      });
      return { ...selection, compatible: false };
    }
    let compatible = true;
    for (const evidenceId of selection.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      const issue = evidence
        ? evidenceCompatibilityIssue(target, evidence)
        : {
            code: "EVIDENCE_ID_NOT_IN_RETRIEVAL_SET",
            message: "Evidence is outside the current bounded bundle.",
          };
      if (issue) {
        compatible = false;
        issues.push({
          targetId: target.targetId,
          evidenceId,
          code: issue.code,
          message: issue.message,
        });
      }
    }
    return { ...selection, compatible };
  });
  const outcome = issues.length === 0 ? "accepted" : "rejected";
  const receiptMaterial = {
    schemaVersion: "1.0.0",
    evidenceBundleHash: input.bundle.bundleHash,
    factsHash: input.factsHash,
    attempt: input.attempt,
    provider: input.provider,
    model: input.model,
    outcome,
    availableEvidenceIds: input.bundle.evidence.map((item) => item.evidenceId),
    acceptedEvidenceIds: bindings
      .filter((binding) => binding.compatible)
      .flatMap((binding) => binding.evidenceIds),
    rejectedEvidence: issues,
    bindings,
    issues,
  } as const;
  const receipt: EvidenceSelectionReceipt = {
    ...receiptMaterial,
    receiptId: `evidence_selection_${sha256(receiptMaterial).slice(0, 20)}`,
    createdAt: new Date().toISOString(),
  };
  if (issues.length > 0) {
    throw new EvidenceCompatibilityError(
      `Selected evidence is legal but incompatible with ${issues.length} Planner claim(s): ${issues
        .slice(0, 4)
        .map((issue) => `${issue.targetId}:${issue.code}`)
        .join(", ")}.`,
      receipt,
    );
  }
  return receipt;
};

export const evidenceCompatibilityIssue = (
  target: EvidenceSelectionTarget,
  evidence: EvidenceRef,
): { code: string; message: string } | null => {
  if (evidence.thetaSupportStatus === "unsupported") {
    return {
      code: "EVIDENCE_INSUFFICIENT_SUPPORT",
      message: "Evidence explicitly marks the THETA capability as unsupported.",
    };
  }
  if (target.kind === "parameter") {
    if (!matchesModel(target.modelId, evidence)) {
      return {
        code: "EVIDENCE_MODEL_MISMATCH",
        message: `Parameter evidence does not apply to model '${target.modelId ?? "unknown"}'.`,
      };
    }
    if (!matchesParameter(target.parameterId, evidence)) {
      return {
        code: "EVIDENCE_TARGET_MISMATCH",
        message: `Evidence does not cover parameter '${target.parameterId ?? "unknown"}'.`,
      };
    }
    if (evidence.authority === "L3" || evidence.authority === "L4") {
      return {
        code: "EVIDENCE_INSUFFICIENT_SUPPORT",
        message: "Paper/heuristic evidence cannot authorize an executable parameter value.",
      };
    }
    return null;
  }
  if (target.kind === "model") {
    if (!matchesModel(target.modelId, evidence)) {
      return {
        code: "EVIDENCE_MODEL_MISMATCH",
        message: `Evidence does not support model '${target.modelId ?? "unknown"}'.`,
      };
    }
    if (
      evidence.objectType &&
      ![
        "source",
        "model",
        "rule",
        "recipe",
        "implementation_capability",
        "project_constraint",
        "conflict_group",
      ].includes(evidence.objectType)
    ) {
      return {
        code: "EVIDENCE_TARGET_MISMATCH",
        message: "Parameter, metric, or failure evidence cannot by itself justify model selection.",
      };
    }
    return null;
  }
  if (target.kind === "evaluation") {
    return evidence.objectType === "evaluation_metric" ||
      evidence.objectType === "rule" ||
      evidence.objectType === "recipe" ||
      evidence.objectType === "conflict_group" ||
      hasTag(evidence, /evaluation|coherence|diversity|stability|human_review|perplexity/iu)
      ? null
      : {
          code: "EVIDENCE_TARGET_MISMATCH",
          message: "Evidence is not an evaluation or quality-assessment object.",
        };
  }
  if (target.kind === "experiment_protocol") {
    return evidence.objectType === "recipe" ||
      evidence.objectType === "rule" ||
      evidence.objectType === "evaluation_metric" ||
      evidence.objectType === "conflict_group" ||
      hasTag(evidence, /experiment|protocol|baseline|stability|random_seed|comparison|evaluation/iu)
      ? null
      : {
          code: "EVIDENCE_TARGET_MISMATCH",
          message: "Evidence does not cover experiment scheduling, comparison, or stability.",
        };
  }
  if (target.kind === "preprocessing") {
    if (evidence.modelIds?.length && !matchesModel(target.modelId, evidence)) {
      return {
        code: "EVIDENCE_MODEL_MISMATCH",
        message: "Model-specific preprocessing evidence applies to a different model.",
      };
    }
    return evidence.objectType === "rule" ||
      evidence.objectType === "recipe" ||
      evidence.objectType === "failure_mode" ||
      evidence.objectType === "project_constraint" ||
      hasTag(evidence, /preprocess|token|vocab|empty|duplicate|language|embedding/iu)
      ? null
      : {
          code: "EVIDENCE_TARGET_MISMATCH",
          message: "Evidence is not applicable to preprocessing.",
        };
  }
  return {
    code: "EVIDENCE_TARGET_MISMATCH",
    message: `Unsupported evidence target kind '${target.kind}'.`,
  };
};

const matchesModel = (
  modelId: string | undefined,
  evidence: EvidenceRef,
): boolean => {
  if (!modelId) return true;
  const normalized = normalize(modelId);
  if (evidence.modelIds?.some((candidate) => normalize(candidate) === normalized)) {
    return true;
  }
  if (evidence.modelIds?.length) return false;
  return exactToken(
    `${evidence.symbol ?? ""} ${evidence.title ?? ""} ${evidence.excerpt}`,
    modelId,
  );
};

const matchesParameter = (
  parameterId: string | undefined,
  evidence: EvidenceRef,
): boolean => {
  if (!parameterId) return false;
  const normalized = normalize(parameterId);
  if (evidence.parameterIds?.some((candidate) => normalize(candidate) === normalized)) {
    return true;
  }
  if (evidence.parameterIds?.length) return false;
  const text = normalize(`${evidence.symbol ?? ""} ${evidence.title ?? ""} ${evidence.excerpt}`);
  return text.includes(normalized);
};

const hasTag = (evidence: EvidenceRef, pattern: RegExp): boolean =>
  (evidence.scenarioTags ?? []).some((tag) => pattern.test(tag));

const exactToken = (text: string, token: string): boolean =>
  new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(token.toLowerCase())}([^a-z0-9_-]|$)`, "u")
    .test(text.toLowerCase());
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/gu, "");
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
