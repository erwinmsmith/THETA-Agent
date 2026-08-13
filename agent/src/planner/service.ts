import type { InferenceProvider, PromptMessage } from "@hypha/inference";
import { ZodError } from "zod";
import { CapabilityRegistry } from "@theta-agent/tools/support/capabilities/registry.js";
import {
  evidenceBundleSchema,
  type EvidenceBundle,
} from "@theta-agent/tools/support/rag/evidence-bundle.js";
import type { RecommendationResult } from "@theta-agent/domain/recommendation/contracts.js";
import {
  PLANNER_CONTRACT_VERSION,
  planProposalDraftSchema,
  planProposalResultSchema,
  plannerSkeletonSchema,
  type PlanProposalDraft,
  type PlanProposalResult,
  type PlannerSkeleton,
  type PlannerSkeletonDecision,
  type PlannerFallbackReason,
  type ModelDecision,
  type EvidenceSelectionReceipt,
  type PlannerProgressEvent,
  type PlannerInputSnapshot,
} from "@theta-agent/domain/planner/contracts.js";
import {
  createPlannerInputSnapshot,
  sanitizePlannerInput,
} from '@theta-agent/tools/support/planner/input-snapshot.js';
import {
  EvidenceCompatibilityError,
  createRejectedEvidenceSelectionReceipt,
  evidenceCompatibilityIssue,
  validateEvidenceSelections,
} from "./evidence-compatibility.js";
import {
  EvidenceSelectionError,
  executeSelectEvidence,
  selectEvidenceToolDescriptor,
  type EvidenceSelectionTarget,
  type SelectedEvidence,
} from "@theta-agent/tools/support/planner/select-evidence-tool.js";

export interface PlannerInput {
  researchBrief: Record<string, unknown>;
  datasetProfile: Record<string, unknown>;
  columnConfirmation: Record<string, unknown>;
  recommendation: RecommendationResult;
  evidenceBundle: EvidenceBundle;
}

export interface PlannerServiceOptions {
  provider?: InferenceProvider;
  enabled?: boolean;
  modelAlias?: string;
  onProgress?: (event: PlannerProgressEvent) => void | Promise<void>;
}

export class ThetaPlannerService {
  constructor(private readonly options: PlannerServiceOptions = {}) {}

  async propose(input: PlannerInput): Promise<PlanProposalResult> {
    const progress = new PlannerProgressRecorder(this.options.onProgress);
    await progress.record("analyze_brief", "started", 1);
    const safeInput = sanitizePlannerInput(input);
    const inputSnapshot = createPlannerInputSnapshot(safeInput);
    const factsHash = inputSnapshot.factsHash;
    await progress.record("analyze_brief", "completed", 1);
    await progress.record("build_retrieval_queries", "started", 1);
    await progress.record("build_retrieval_queries", "completed", 1);
    await progress.record("retrieve_evidence", "started", 1);
    await progress.record(
      "retrieve_evidence",
      "completed",
      1,
      `${safeInput.evidenceBundle.evidence.length} evidence items`,
    );
    const evidenceSelectionReceipts: EvidenceSelectionReceipt[] = [];
    if (!this.options.enabled) return fallback(safeInput, inputSnapshot, "planner_not_enabled", undefined, evidenceSelectionReceipts, progress.events);
    if (!this.options.provider) return fallback(safeInput, inputSnapshot, "provider_not_configured", undefined, evidenceSelectionReceipts, progress.events);
    try {
      let skeleton: PlannerSkeleton;
      try {
        await progress.record("draft_proposal", "started", 1);
        skeleton = await this.inferSkeleton(safeInput, factsHash, false);
        await progress.record("draft_proposal", "completed", 1);
      } catch (firstError) {
        if (!retryableDraftError(firstError)) throw firstError;
        await progress.record("draft_proposal", "failed", 1, errorSummary(firstError));
        await progress.record("bounded_retry", "started", 2);
        skeleton = await this.inferSkeleton(safeInput, factsHash, true, errorSummary(firstError));
        await progress.record("bounded_retry", "completed", 2);
      }
      await progress.record("resolve_plan", "started", 1);
      const draft = expandPlannerSkeleton(skeleton, safeInput);
      enforceCatalogBoundaries(draft, safeInput);
      await progress.record("resolve_plan", "completed", 1);
      try {
        await progress.record("select_evidence", "started", 1);
        await this.bindEvidenceWithTool(draft, safeInput, factsHash, false, 1, evidenceSelectionReceipts);
        await progress.record("select_evidence", "completed", 1);
      } catch (firstEvidenceError) {
        if (!(firstEvidenceError instanceof EvidenceSelectionError)) throw firstEvidenceError;
        await progress.record("select_evidence", "failed", 1, errorSummary(firstEvidenceError));
        await progress.record("bounded_retry", "started", 2);
        await this.bindEvidenceWithTool(
          draft,
          safeInput,
          factsHash,
          true,
          2,
          evidenceSelectionReceipts,
          errorSummary(firstEvidenceError),
        );
        await progress.record("bounded_retry", "completed", 2);
      }
      await progress.record("validate_plan", "started", 1);
      await progress.record("validate_plan", "completed", 1);
      await progress.record("final_review", "started", 1);
      await progress.record("final_review", "completed", 1);
      return planProposalResultSchema.parse({
        schemaVersion: PLANNER_CONTRACT_VERSION,
        source: "minimax",
        factsHash,
        inputSnapshot,
        plannerProgress: progress.events,
        evidenceSelectionReceipts,
        draft,
      });
    } catch (error) {
      return fallback(
        safeInput,
        inputSnapshot,
        plannerFallbackReason(error),
        errorSummary(error),
        evidenceSelectionReceipts,
        progress.events,
      );
    }
  }

  private async inferSkeleton(
    input: PlannerInput,
    factsHash: string,
    repair: boolean,
    repairReason?: string,
  ): Promise<PlannerSkeleton> {
    if (!this.options.provider) throw new Error("Planner provider is not configured.");
    const response = await this.options.provider.infer({
      runId: `theta-planner-${factsHash.slice(0, 16)}`,
      stepId: repair ? "draft_plan_skeleton_repair" : "draft_plan_skeleton",
      modelAlias: this.options.modelAlias ?? "configured-planner-model",
      input: { messages: skeletonPromptMessages(input, repair, repairReason) },
      options: { temperature: repair ? 0 : 0.1, maxTokens: repair ? 520 : 700 },
      trace: true,
      metadata: {
        purpose: "draft_plan_skeleton",
        schemaVersion: PLANNER_CONTRACT_VERSION,
        repair,
      },
    });
    assertRawEvidenceAliases(response.output, evidenceAliases(input));
    return plannerSkeletonSchema.parse(normalizePlannerSkeleton(response.output));
  }

  private async bindEvidenceWithTool(
    draft: PlanProposalDraft,
    input: PlannerInput,
    factsHash: string,
    compact: boolean,
    attempt: number,
    receipts: EvidenceSelectionReceipt[],
    priorError?: string,
  ): Promise<PlanProposalDraft> {
    if (!this.options.provider) throw new Error("Planner provider is not configured.");
    const aliases = evidenceAliases(input);
    const bindings = draftEvidenceBindings(draft, aliases);
    if (aliases.size === 0) {
      for (const binding of bindings) {
        binding.item.evidenceRefs = [];
        binding.item.confidence = "low";
      }
      return draft;
    }
    const targets = bindings.map((binding) => binding.target);
    const compatibleAliases = compatibleAliasesByTarget(input, targets, aliases);
    const response = await this.options.provider.infer({
      runId: `theta-planner-${factsHash.slice(0, 16)}`,
      stepId: compact ? "select_evidence_compact_retry" : "select_evidence",
      modelAlias: this.options.modelAlias ?? "configured-planner-model",
      input: { messages: evidenceSelectionMessages(input, targets, compatibleAliases, compact, priorError) },
      tools: [selectEvidenceToolDescriptor(aliases, targets, compatibleAliases)],
      options: {
        temperature: 0,
        maxTokens: compact ? 900 : 1400,
        // MiniMax's documented tool_choice modes are auto/none. The local
        // executor supplies the strictness by rejecting a non-tool response.
        extra: { toolChoice: "auto" },
      },
      trace: true,
      metadata: {
        purpose: "select_planner_evidence",
        schemaVersion: PLANNER_CONTRACT_VERSION,
        evidenceBundleHash: input.evidenceBundle.bundleHash,
        compactRetry: compact,
      },
    });
    let selected: SelectedEvidence[];
    try {
      selected = executeSelectEvidence(response.output, aliases, targets);
    } catch (error) {
      if (error instanceof EvidenceSelectionError) {
        receipts.push(createRejectedEvidenceSelectionReceipt({
          bundle: input.evidenceBundle,
          targets,
          factsHash,
          attempt,
          provider: "minimax",
          model: this.options.modelAlias ?? "configured-planner-model",
        }, error));
      }
      throw error;
    }
    try {
      receipts.push(validateEvidenceSelections({
        bundle: input.evidenceBundle,
        targets,
        selections: selected,
        factsHash,
        attempt,
        provider: "minimax",
        model: this.options.modelAlias ?? "configured-planner-model",
      }));
    } catch (error) {
      if (error instanceof EvidenceCompatibilityError) receipts.push(error.receipt);
      throw error;
    }
    applySelectedEvidence(bindings, selected);
    return draft;
  }
}

/** Projects either the new compact skeleton or a legacy full Draft onto the
 * compact Planner-owned decision surface. Executable expansion stays local. */
const normalizePlannerSkeleton = (value: unknown): unknown => {
  const root = record(value);
  const decision = (input: unknown): PlannerSkeletonDecision => {
    const item = record(input);
    return {
      modelId: string(item.modelId ?? item.model_id),
      rationale: string(item.rationale ?? item.choice),
      parameters: array(
        item.parameters ?? item.parameterCandidates ?? item.parameter_candidates,
      )
        .map(record)
        .filter((parameter) => isPrimitive(parameter.value))
        .map((parameter) => ({
          field: string(parameter.field),
          value: parameter.value as string | number | boolean | null,
          rationale: string(parameter.rationale),
        }))
        .slice(0, 3),
    };
  };
  const protocol = record(root.experimentProtocol ?? root.experiment_protocol);
  const baseline = root.baseline === null || root.baseline === undefined
    ? null
    : decision(root.baseline);
  const primarySeeds = array(protocol.primarySeeds ?? protocol.primary_seeds)
    .filter((item): item is number => typeof item === "number" && Number.isInteger(item))
    .slice(0, 3);
  const baselineSeeds = array(protocol.baselineSeeds ?? protocol.baseline_seeds)
    .filter((item): item is number => typeof item === "number" && Number.isInteger(item))
    .slice(0, 1);
  const requestedMode = string(protocol.mode);
  const mode = requestedMode === "comparative" || requestedMode === "stability"
    ? requestedMode
    : "quick";
  return {
    schemaVersion: PLANNER_CONTRACT_VERSION,
    summary: string(root.summary),
    primary: decision(root.primary),
    baseline,
    alternatives: array(root.alternatives).map(decision).slice(0, 1),
    experimentProtocol: {
      mode,
      primarySeeds: primarySeeds.length
        ? primarySeeds
        : mode === "stability"
          ? [17, 42, 73]
          : [42],
      baselineModelId: mode === "comparative"
        ? string(protocol.baselineModelId ?? protocol.baseline_model_id) ||
          baseline?.modelId ||
          null
        : null,
      baselineSeeds: mode === "comparative"
        ? (baselineSeeds.length ? baselineSeeds : [42])
        : [],
      rationale:
        string(protocol.rationale) ||
        "先执行一次主模型快速运行，再根据质量结果决定是否扩展比较。",
    },
    openQuestions: strings(root.openQuestions ?? root.open_questions).slice(0, 3),
  };
};

const expandPlannerSkeleton = (
  skeleton: PlannerSkeleton,
  input: PlannerInput,
): PlanProposalDraft => {
  const recommendations = new Map(
    input.recommendation.recommendations.map((item) => [item.modelId, item]),
  );
  const selectedModelIds = [
    skeleton.primary.modelId,
    ...(skeleton.baseline ? [skeleton.baseline.modelId] : []),
    ...skeleton.alternatives.map((item) => item.modelId),
  ];
  const decision = (
    item: PlannerSkeletonDecision,
    role: "primary" | "baseline" | "alternative",
  ): ModelDecision => {
    const recommendation = recommendations.get(item.modelId);
    if (!recommendation) {
      throw new PlannerBoundaryError(
        "catalog_violation",
        `Unknown candidate model '${item.modelId}'.`,
      );
    }
    return {
      role,
      modelId: item.modelId,
      choice: item.rationale,
      evidenceRefs: [],
      confidence: "low",
      assumptions: ["数据画像和用户确认的列角色准确。"],
      risks: recommendation.warnings.length
        ? recommendation.warnings.slice(0, 5)
        : ["首轮结果仍需人工检查主题可解释性。"],
      alternativesConsidered: selectedModelIds
        .filter((modelId) => modelId !== item.modelId)
        .slice(0, 5),
      parameterCandidates: item.parameters.map((parameter) => ({
        ...parameter,
        evidenceRefs: [],
        confidence: "low" as const,
      })),
    };
  };
  const modelId = skeleton.primary.modelId.toLowerCase();
  const preprocessingChoice =
    modelId === "btm"
      ? "检查空文本、分词结果和有效 biterm 数量，再执行短文本训练。"
      : modelId === "dtm"
        ? "检查空文本、时间解析、时间切片覆盖与每个切片的文档数量。"
        : modelId === "stm"
          ? "检查空文本、协变量缺失、类别平衡和高基数，再执行协变量主题训练。"
          : modelId === "bertopic"
            ? "检查空文本、嵌入依赖与离线模型可用性，再执行聚类主题训练。"
            : "检查空文本、重复、语言与词表可用性，再执行词袋主题训练。";
  const visualizations = ["主题关键词与代表文本", "文档—主题分布"];
  if (modelId === "dtm") visualizations.push("主题随时间变化");
  if (modelId === "stm") visualizations.push("协变量与主题关系");
  return planProposalDraftSchema.parse({
    schemaVersion: PLANNER_CONTRACT_VERSION,
    summary: skeleton.summary,
    primary: decision(skeleton.primary, "primary"),
    baseline: skeleton.baseline ? decision(skeleton.baseline, "baseline") : null,
    alternatives: skeleton.alternatives.map((item) => decision(item, "alternative")),
    experimentProtocol: {
      ...skeleton.experimentProtocol,
      evidenceRefs: [],
      confidence: "low",
    },
    preprocessing: [{
      choice: preprocessingChoice,
      evidenceRefs: [],
      confidence: "low",
      assumptions: [],
      risks: ["预处理改变会影响主题可比性。"],
      alternativesConsidered: [],
    }],
    evaluation: [{
      choice: "联合比较主题连贯性、多样性、稳定性与人工可解释性，不以单一指标宣布最佳模型。",
      evidenceRefs: [],
      confidence: "low",
      assumptions: [],
      risks: ["小样本自动指标具有较高不确定性。"],
      alternativesConsidered: [],
    }],
    visualizations,
    requestedTools: [],
    openQuestions: skeleton.openQuestions,
  });
};

const record = (value: unknown): Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : typeof value === "string" && value.trim()
      ? [value.trim()]
      : [];
const isPrimitive = (value: unknown): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const evidenceAliases = (input: PlannerInput): Map<string, string> =>
  new Map(input.evidenceBundle.evidence.map((item, index) => [`E${index + 1}`, item.evidenceId]));

const skeletonPromptMessages = (
  input: PlannerInput,
  repair = false,
  repairReason?: string,
): PromptMessage[] => [
  {
    role: "system",
    content: [
      "You are the bounded THETA research planner. Return one compact JSON object only.",
      "You may choose primary, baseline and alternatives only from recommendation.recommendations.",
      "Choose only model roles, up to three candidate parameter values, and the experiment mode. Local code will add preprocessing, evaluation, visualization, evidence, defaults and executable fields.",
      "quick means one primary seed and no baseline; comparative requires the same baseline object and one baseline seed; stability requires at least three primary seeds.",
      "Parameter fields and values must come from the selected recommendation's recommendedPlanPatch. Omit a parameter rather than inventing it.",
      "Do not emit evidence IDs, aliases, commands, paths, hashes, confidence, assumptions, risks, preprocessing, evaluation, visualizations, tools or approvals.",
      "Use concise Chinese rationale. Do not claim causal effects.",
      repair
        ? `REPAIR RETRY: the previous compact object was invalid (${repairReason ?? "shape error"}). Emit fewer fields and carefully close JSON arrays and objects.`
        : "Keep the entire object under 500 output tokens.",
      'Shape: {"schemaVersion":"1.0.0","summary":"...","primary":{"modelId":"...","rationale":"...","parameters":[{"field":"numTopics","value":8,"rationale":"..."}]},"baseline":null|{"modelId":"...","rationale":"...","parameters":[]},"alternatives":[{"modelId":"...","rationale":"...","parameters":[]}],"experimentProtocol":{"mode":"quick|comparative|stability","primarySeeds":[42],"baselineModelId":null,"baselineSeeds":[],"rationale":"..."},"openQuestions":[]}.',
    ].join(" "),
  },
  {
    role: "user",
    content: JSON.stringify({
      researchBrief: input.researchBrief,
      datasetProfile: input.datasetProfile,
      columnConfirmation: input.columnConfirmation,
      recommendations: input.recommendation.recommendations.slice(0, 4).map((item) => ({
        modelId: item.modelId,
        modelName: item.modelName,
        score: item.score,
        confidence: item.confidence,
        reasonCodes: item.reasonCodes,
        warnings: item.warnings,
        recommendedPlanPatch: item.recommendedPlanPatch,
        capabilityAssessment: item.capabilityAssessment,
      })),
      degradation: input.recommendation.degradation,
    }),
  },
];

interface EvidenceBearing {
  evidenceRefs: string[];
  confidence: "low" | "medium" | "high";
}

interface DraftEvidenceBinding {
  target: EvidenceSelectionTarget;
  item: EvidenceBearing;
}

const draftEvidenceBindings = (
  draft: PlanProposalDraft,
  aliases: ReadonlyMap<string, string>,
): DraftEvidenceBinding[] => {
  const actualToAlias = new Map(
    [...aliases].map(([alias, evidenceId]) => [evidenceId, alias]),
  );
  const bindings: DraftEvidenceBinding[] = [];
  const add = (
    targetId: string,
    claim: string,
    item: EvidenceBearing,
    metadata: Omit<EvidenceSelectionTarget, "targetId" | "claim" | "provisionalAliases">,
  ): void => {
    bindings.push({
      target: {
        targetId,
        claim,
        ...metadata,
        provisionalAliases: item.evidenceRefs.map((ref) => {
          const alias = actualToAlias.get(ref);
          if (!alias) {
            throw new EvidenceSelectionError(
              `Planner draft referenced evidence outside the current bundle: ${ref}`,
            );
          }
          return alias;
        }),
      },
      item,
    });
  };
  const addDecision = (
    prefix: string,
    decision: ModelDecision,
  ): void => {
    add(prefix, `${decision.modelId}: ${decision.choice}`, decision, {
      kind: "model",
      modelId: decision.modelId,
    });
    decision.parameterCandidates.forEach((parameter, index) =>
      add(
        `${prefix}.parameter.${index}`,
        `${decision.modelId}.${parameter.field}=${String(parameter.value)}: ${parameter.rationale}`,
        parameter,
        {
          kind: "parameter",
          modelId: decision.modelId,
          parameterId: parameter.field,
        },
      ),
    );
  };
  addDecision("primary", draft.primary);
  if (draft.baseline) addDecision("baseline", draft.baseline);
  draft.alternatives.forEach((decision, index) =>
    addDecision(`alternative.${index}`, decision),
  );
  draft.preprocessing.forEach((item, index) =>
    add(`preprocessing.${index}`, item.choice, item, {
      kind: "preprocessing",
      modelId: draft.primary.modelId,
    }),
  );
  draft.evaluation.forEach((item, index) =>
    add(`evaluation.${index}`, item.choice, item, {
      kind: "evaluation",
      modelId: draft.primary.modelId,
    }),
  );
  add(
    "experimentProtocol",
    `${draft.experimentProtocol.mode}: ${draft.experimentProtocol.rationale}`,
    draft.experimentProtocol,
    {
      kind: "experiment_protocol",
      modelId: draft.primary.modelId,
    },
  );
  return bindings;
};

const compatibleAliasesByTarget = (
  input: PlannerInput,
  targets: readonly EvidenceSelectionTarget[],
  aliases: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly string[]> => {
  const evidenceById = new Map(
    input.evidenceBundle.evidence.map((item) => [item.evidenceId, item]),
  );
  return new Map(
    targets.map((target) => [
      target.targetId,
      [...aliases]
        .filter(([, evidenceId]) => {
          const evidence = evidenceById.get(evidenceId);
          return Boolean(evidence) && evidenceCompatibilityIssue(target, evidence!) === null;
        })
        .map(([alias]) => alias),
    ]),
  );
};

const evidenceSelectionMessages = (
  input: PlannerInput,
  targets: readonly EvidenceSelectionTarget[],
  compatibleAliases: ReadonlyMap<string, readonly string[]>,
  compact: boolean,
  priorError?: string,
): PromptMessage[] => [
  {
    role: "system",
    content: [
      "You are the evidence-binding stage of the bounded THETA Planner.",
      "Call select_evidence exactly once. Do not answer with text or JSON outside the tool call.",
      "Provide exactly one selection for every targetId. Use only the listed E aliases.",
      "Use aliases=[] when the available bundle does not directly support a claim.",
      "L1/L2 controls implementation claims; L3/L4 may support research rationale but cannot override implementation constraints.",
      compact
        ? `This is an evidence-only retry after an invalid selection (${priorError ?? "invalid selection"}). Keep the Planner skeleton unchanged and be strictly literal.`
        : "Do not invent or rewrite identifiers.",
    ].join(" "),
  },
  {
    role: "user",
    content: JSON.stringify({
      evidenceBundleHash: input.evidenceBundle.bundleHash,
      availableEvidence: input.evidenceBundle.evidence.map((item, index) => ({
        alias: `E${index + 1}`,
        title: item.title,
        objectType: item.objectType,
        authority: item.authority,
        modelIds: item.modelIds ?? [],
        parameterIds: item.parameterIds ?? [],
        scenarioTags: item.scenarioTags ?? [],
        claimScope: item.claimScope,
        excerpt: item.excerpt,
      })),
      targets: targets.map((target) => ({
        ...target,
        compatibleAliases: compatibleAliases.get(target.targetId) ?? [],
      })),
    }),
  },
];

const applySelectedEvidence = (
  bindings: readonly DraftEvidenceBinding[],
  selected: readonly SelectedEvidence[],
): void => {
  const selectedByTarget = new Map(
    selected.map((item) => [item.targetId, item.evidenceIds]),
  );
  for (const binding of bindings) {
    const refs = selectedByTarget.get(binding.target.targetId);
    if (!refs) {
      throw new EvidenceSelectionError(
        `select_evidence omitted '${binding.target.targetId}'.`,
      );
    }
    binding.item.evidenceRefs = [...refs];
    if (refs.length === 0) binding.item.confidence = "low";
  }
};

const assertRawEvidenceAliases = (
  value: unknown,
  aliases: ReadonlyMap<string, string>,
): void => {
  const root = record(value);
  const lists: unknown[] = [];
  const addGrounded = (item: Record<string, unknown>): void => {
    lists.push(item.evidenceRefs ?? item.evidence_refs ?? []);
  };
  const addDecision = (value: unknown): void => {
    const item = record(value);
    addGrounded(item);
    for (const parameter of array(item.parameterCandidates ?? item.parameter_candidates)) {
      addGrounded(record(parameter));
    }
  };
  addDecision(root.primary);
  if (root.baseline !== null && root.baseline !== undefined) addDecision(root.baseline);
  for (const item of array(root.alternatives)) addDecision(item);
  for (const item of array(root.preprocessing)) addGrounded(record(item));
  for (const item of array(root.evaluation)) addGrounded(record(item));
  addGrounded(record(root.experimentProtocol ?? root.experiment_protocol));
  for (const list of lists) {
    for (const ref of strings(list)) {
      if (!aliases.has(ref)) {
        throw new EvidenceSelectionError(
          `Planner may cite evidence only through current-bundle aliases; rejected '${ref}'.`,
        );
      }
    }
  }
};

const enforceCatalogBoundaries = (draft: PlanProposalDraft, input: PlannerInput): void => {
  const recommendations = new Map(input.recommendation.recommendations.map((item) => [item.modelId, item]));
  const decisions = [draft.primary, ...(draft.baseline ? [draft.baseline] : []), ...draft.alternatives];
  for (const decision of decisions) {
    const recommendation = recommendations.get(decision.modelId);
    if (!recommendation) throw new PlannerBoundaryError("catalog_violation", `Unknown candidate model '${decision.modelId}'.`);
    const card = new CapabilityRegistry().get(decision.modelId);
    const fields = new Set([
      ...Object.keys(recommendation.recommendedPlanPatch),
      ...(card?.parameters.filter((parameter) => parameter.usedByTraining).map((parameter) => parameter.planField) ?? []),
    ]);
    for (const parameter of decision.parameterCandidates) {
      if (!fields.has(parameter.field)) throw new PlannerBoundaryError("catalog_violation", `Unknown parameter '${parameter.field}' for ${decision.modelId}.`);
    }
  }
  const protocolBaseline = draft.experimentProtocol.baselineModelId;
  if (protocolBaseline) {
    if (!recommendations.has(protocolBaseline)) {
      throw new PlannerBoundaryError("catalog_violation", `Unknown baseline model '${protocolBaseline}'.`);
    }
    if (!draft.baseline || draft.baseline.modelId !== protocolBaseline) {
      throw new PlannerBoundaryError("catalog_violation", "experimentProtocol baseline must match the baseline decision.");
    }
  }
};

const fallback = (
  input: PlannerInput,
  inputSnapshot: PlannerInputSnapshot,
  reason: PlannerFallbackReason,
  detail?: string,
  evidenceSelectionReceipts: EvidenceSelectionReceipt[] = [],
  plannerProgress: PlannerProgressEvent[] = [],
): PlanProposalResult => {
  const factsHash = inputSnapshot.factsHash;
  const recommendations = input.recommendation.recommendations;
  const primary = recommendations[0];
  if (!primary) throw new Error("Planner fallback requires at least one deterministic recommendation.");
  const evidence = input.evidenceBundle.evidence;
  const refs = primary.evidenceRefs.map((item) => item.evidenceId).filter((id) => evidence.some((item) => item.evidenceId === id)).slice(0, 5);
  const decision = (item: typeof primary, role: "primary" | "baseline" | "alternative") => ({
    role,
    modelId: item.modelId,
    choice: `${item.modelName} 是确定性推荐器保留的${role === "primary" ? "主方案" : role === "baseline" ? "基线" : "备选方案"}。`,
    evidenceRefs: item.evidenceRefs.map((e) => e.evidenceId).filter((id) => evidence.some((e) => e.evidenceId === id)).slice(0, 5),
    confidence: (item.evidenceRefs.length ? item.confidence : "low") as "low" | "medium" | "high",
    assumptions: ["数据画像和用户确认的列角色准确。"],
    risks: item.warnings.length ? item.warnings.slice(0, 5) : ["首轮结果仍需人工检查主题可解释性。"],
    alternativesConsidered: recommendations.filter((candidate) => candidate.modelId !== item.modelId).map((candidate) => candidate.modelId).slice(0, 5),
    parameterCandidates: Object.entries(item.recommendedPlanPatch)
      .filter(([field]) => field !== "modelId")
      .map(([field, value]) => {
        const parameter = item.parameters.find(
          (candidate) => normalizeIdentifier(candidate.name) === normalizeIdentifier(field),
        );
        const parameterRefs = (parameter?.evidenceRefs ?? [])
          .filter((id) => evidence.some((candidate) => candidate.evidenceId === id))
          .slice(0, 3);
        return {
          field,
          value: value as string | number | boolean | null,
          rationale: "采用确定性推荐器与 Capability Registry 的首轮候选值。",
          evidenceRefs: parameterRefs,
          confidence: (parameterRefs.length ? parameter?.confidence ?? item.confidence : "low") as "low" | "medium" | "high",
        };
      }),
  });
  const draft = planProposalDraftSchema.parse({
    schemaVersion: PLANNER_CONTRACT_VERSION,
    summary: `采用确定性后备 Planner：以 ${primary.modelName} 为主方案，并保留可解释基线与备选。`,
    primary: decision(primary, "primary"),
    baseline: recommendations[1] ? decision(recommendations[1], "baseline") : null,
    alternatives: recommendations.slice(2, 4).map((item) => decision(item, "alternative")),
    experimentProtocol: {
      mode: "quick",
      primarySeeds: [42],
      baselineModelId: null,
      baselineSeeds: [],
      rationale: "确定性后备采用一次主模型快速运行，不自动增加基线或多随机种子成本。",
      evidenceRefs: [],
      confidence: "low",
    },
    preprocessing: [{ choice: "训练前检查空文本、重复、语言与词表/嵌入可用性。", evidenceRefs: refs, confidence: refs.length ? "medium" : "low", assumptions: [], risks: ["预处理改变会影响主题可比性。"], alternativesConsidered: [] }],
    evaluation: [{ choice: "联合比较主题连贯性、多样性、稳定性与人工可解释性。", evidenceRefs: refs, confidence: refs.length ? "medium" : "low", assumptions: [], risks: ["单一自动指标不足以决定最佳方案。"], alternativesConsidered: [] }],
    visualizations: ["主题关键词与代表文本", "文档—主题分布", "候选模型指标对比"],
    requestedTools: [],
    openQuestions: [],
  });
  return planProposalResultSchema.parse({
    schemaVersion: PLANNER_CONTRACT_VERSION,
    source: "deterministic",
    fallbackReason: reason,
    ...(detail ? { fallbackDetail: detail.slice(0, 500) } : {}),
    factsHash,
    inputSnapshot,
    plannerProgress,
    evidenceSelectionReceipts,
    draft,
  });
};

class PlannerProgressRecorder {
  readonly events: PlannerProgressEvent[] = [];
  private readonly startedAt = Date.now();

  constructor(
    private readonly listener?: (event: PlannerProgressEvent) => void | Promise<void>,
  ) {}

  async record(
    stage: PlannerProgressEvent["stage"],
    status: PlannerProgressEvent["status"],
    attempt: number,
    detail?: string,
  ): Promise<void> {
    const event: PlannerProgressEvent = {
      stage,
      status,
      attempt,
      occurredAt: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      ...(detail ? { detail: detail.slice(0, 240) } : {}),
    };
    this.events.push(event);
    await this.listener?.(event);
  }
}

class PlannerBoundaryError extends Error {
  constructor(readonly reason: PlannerFallbackReason, message: string) { super(message); }
}
const plannerFallbackReason = (error: unknown): PlannerFallbackReason => {
  if (error instanceof EvidenceSelectionError) return "evidence_violation";
  if (error instanceof PlannerBoundaryError) return error.reason;
  if (error instanceof ZodError) return "schema_validation_failed";
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === "timeout" || code === "network_failure") return code;
    if (code === "non_json_response") return "schema_validation_failed";
  }
  return "provider_error";
};
const retryableDraftError = (error: unknown): boolean =>
  error instanceof ZodError ||
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "non_json_response",
  );
const errorSummary = (error: unknown): string => {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`)
      .join("; ");
  }
  if (error instanceof EvidenceSelectionError) return error.message;
  if (error instanceof PlannerBoundaryError) return error.message;
  if (error instanceof Error) {
    return error.message.replace(/sk-api-[A-Za-z0-9_-]+/giu, "[redacted]");
  }
  return String(error).slice(0, 500);
};
const normalizeIdentifier = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/gu, "");
