import { CapabilityRegistry } from "@theta-agent/tools/support/capabilities/registry.js";
import type { RecommendationResult } from "@theta-agent/domain/recommendation/contracts.js";
import type { EvidenceBundle } from "@theta-agent/tools/support/rag/evidence-bundle.js";
import type { ThetaTrainingPlan } from "@theta-agent/tools/plan-validate-tool.js";
import type { PlanProposalResult } from "@theta-agent/domain/planner/contracts.js";
import { evidenceCompatibilityIssue } from "./evidence-compatibility.js";
import type { EvidenceSelectionTarget } from "@theta-agent/tools/support/planner/select-evidence-tool.js";
import {
  buildParameterDecisions,
} from "../planning/parameter-decisions.js";
import type { ParameterDecisionMap } from "@theta-agent/domain/planning/contracts.js";

export interface ResolvePlannerInput {
  proposal: PlanProposalResult;
  recommendation: RecommendationResult;
  workflowInput: Record<string, unknown>;
  datasetProfile: Record<string, unknown>;
  columnConfirmation: Record<string, unknown>;
  evidenceBundle: EvidenceBundle;
}

export interface PlannerResolution {
  schemaVersion: "1.0.0";
  source: "provider" | "deterministic" | "explicit_user_plan";
  resolvedPlan: ThetaTrainingPlan;
  acceptedFields: string[];
  rejectedFields: Array<{ field: string; reason: string }>;
  selectedModelId: string;
  inputSnapshotHash: string;
  evidenceBundleHash: string;
  acceptedEvidenceRefs: string[];
  authorityPolicy: "implementation_over_paper";
  parameterDecisions: ParameterDecisionMap;
}

export const resolvePlannerProposal = (input: ResolvePlannerInput): PlannerResolution => {
  if (isRecord(input.workflowInput.plan)) {
    const explicit = input.workflowInput.plan as ThetaTrainingPlan;
    return {
      schemaVersion: "1.0.0",
      source: "explicit_user_plan",
      resolvedPlan: explicit,
      acceptedFields: Object.keys(explicit),
      rejectedFields: [],
      selectedModelId: String(explicit.modelId),
      inputSnapshotHash: input.proposal.inputSnapshot.snapshotHash,
      evidenceBundleHash: input.evidenceBundle.bundleHash,
      acceptedEvidenceRefs: [],
      authorityPolicy: "implementation_over_paper",
      parameterDecisions: buildParameterDecisions({
        recommendedPlan: explicit,
        effectivePlan: explicit,
        source: "user_override",
      }),
    };
  }
  const selected = input.recommendation.recommendations.find((item) => item.modelId === input.proposal.draft.primary.modelId) ?? input.recommendation.recommendations[0];
  if (!selected) throw new Error("Catalog Resolver requires one deterministic recommendation.");
  const registry = new CapabilityRegistry();
  const card = registry.require(selected.modelId);
  const allowed = new Set(card.parameters.filter((parameter) => parameter.usedByTraining).map((parameter) => parameter.planField));
  for (const field of ["mode", "topicCountMode", "numTopics", "maxTopics"]) allowed.add(field);
  const patch: Record<string, unknown> = { ...selected.recommendedPlanPatch };
  const acceptedFields: string[] = [];
  const rejectedFields: Array<{ field: string; reason: string }> = [];
  const acceptedEvidenceRefs = new Set<string>(input.proposal.draft.primary.evidenceRefs);
  assertCompatibleRefs(
    input.proposal.draft.primary.evidenceRefs,
    {
      targetId: "primary",
      claim: input.proposal.draft.primary.choice,
      provisionalAliases: [],
      kind: "model",
      modelId: selected.modelId,
    },
    input.evidenceBundle,
  );
  for (const parameter of input.proposal.draft.primary.parameterCandidates) {
    if (!allowed.has(parameter.field)) {
      rejectedFields.push({ field: parameter.field, reason: "not_exposed_by_capability_registry" });
      continue;
    }
    if (parameter.evidenceRefs.length === 0) {
      rejectedFields.push({ field: parameter.field, reason: "ungrounded_parameter_candidate" });
      continue;
    }
    assertCompatibleRefs(
      parameter.evidenceRefs,
      {
        targetId: `primary.parameter.${parameter.field}`,
        claim: parameter.rationale,
        provisionalAliases: [],
        kind: "parameter",
        modelId: selected.modelId,
        parameterId: parameter.field,
      },
      input.evidenceBundle,
    );
    patch[parameter.field] = parameter.value;
    acceptedFields.push(parameter.field);
    for (const evidenceRef of parameter.evidenceRefs) acceptedEvidenceRefs.add(evidenceRef);
  }
  const proposedProtocol = input.proposal.draft.experimentProtocol;
  let experimentProtocol: Record<string, unknown> = {
    mode: "quick",
    primarySeeds: [42],
    baselineModelId: null,
    baselineSeeds: [],
    rationale: "未采纳额外实验成本，先执行一次主模型快速运行。",
    evidenceRefs: [],
    confidence: "low",
  };
  if (
    proposedProtocol.mode === "quick" ||
    proposedProtocol.evidenceRefs.length > 0
  ) {
    assertCompatibleRefs(
      proposedProtocol.evidenceRefs,
      {
        targetId: "experimentProtocol",
        claim: proposedProtocol.rationale,
        provisionalAliases: [],
        kind: "experiment_protocol",
        modelId: selected.modelId,
      },
      input.evidenceBundle,
    );
    experimentProtocol = { ...proposedProtocol };
    acceptedFields.push("experimentProtocol");
    for (const evidenceRef of proposedProtocol.evidenceRefs) {
      acceptedEvidenceRefs.add(evidenceRef);
    }
  } else {
    rejectedFields.push({
      field: "experimentProtocol",
      reason: "ungrounded_additional_experiment_cost",
    });
  }
  const fileName = stringValue(input.datasetProfile.fileName) ?? "dataset";
  const modelId = selected.modelId;
  const resolvedPlan: ThetaTrainingPlan = {
    ...patch,
    datasetId: stringValue(input.workflowInput.datasetId) ?? fileName.replace(/\.[^.]+$/, ""),
    modelId,
    mode: mode(patch.mode),
    topicCountMode: topicMode(patch.topicCountMode, modelId),
    ...(firstString(input.columnConfirmation.textColumns) ? { textColumn: firstString(input.columnConfirmation.textColumns) } : {}),
    ...(stringValue(input.columnConfirmation.timeColumn) ? { timeColumn: stringValue(input.columnConfirmation.timeColumn) } : {}),
    ...(stringValue(input.columnConfirmation.idColumn) ? { idColumn: stringValue(input.columnConfirmation.idColumn) } : {}),
    covariateColumns: stringArray(input.columnConfirmation.covariateColumns),
    metadataColumns: stringArray(input.columnConfirmation.metadataColumns),
    experimentProtocol,
  };
  if (modelId === "hdp") {
    resolvedPlan.topicCountMode = "auto";
    resolvedPlan.numTopics = null;
  }
  if (modelId === "bertopic" && resolvedPlan.topicCountMode === "auto") resolvedPlan.numTopics = null;
  const parameterRationales = Object.fromEntries(
    selected.parameters.map((parameter) => [
      parameter.name,
      parameter.reasonCodes.join(", "),
    ]),
  );
  return {
    schemaVersion: "1.0.0",
    source: input.proposal.source,
    resolvedPlan,
    acceptedFields,
    rejectedFields,
    selectedModelId: modelId,
    inputSnapshotHash: input.proposal.inputSnapshot.snapshotHash,
    evidenceBundleHash: input.evidenceBundle.bundleHash,
    acceptedEvidenceRefs: [...acceptedEvidenceRefs],
    authorityPolicy: "implementation_over_paper",
    parameterDecisions: buildParameterDecisions({
      recommendedPlan: selected.recommendedPlanPatch,
      effectivePlan: resolvedPlan,
      rationales: parameterRationales,
    }),
  };
};

const assertCompatibleRefs = (
  refs: readonly string[],
  target: EvidenceSelectionTarget,
  bundle: EvidenceBundle,
): void => {
  const byId = new Map(bundle.evidence.map((item) => [item.evidenceId, item]));
  for (const evidenceId of refs) {
    const evidence = byId.get(evidenceId);
    if (!evidence) {
      throw new Error(`Resolver rejected evidence outside the current bundle: ${evidenceId}`);
    }
    const issue = evidenceCompatibilityIssue(target, evidence);
    if (issue) {
      throw new Error(
        `Resolver rejected incompatible evidence '${evidenceId}' for '${target.targetId}': ${issue.code}.`,
      );
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
const firstString = (value: unknown): string | undefined => stringArray(value)[0];
const mode = (value: unknown): ThetaTrainingPlan["mode"] => value === "zero_shot" || value === "supervised" ? value : "unsupervised";
const topicMode = (value: unknown, modelId: string): NonNullable<ThetaTrainingPlan["topicCountMode"]> => value === "auto" || value === "target_reduction" || value === "fixed" ? value : modelId === "hdp" ? "auto" : "fixed";
