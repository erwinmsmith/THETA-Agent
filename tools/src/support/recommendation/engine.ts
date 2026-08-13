import type {
  ColumnConfirmation,
  ResearchBrief,
} from "@theta-agent/domain/research/contracts.js";
import type { EvidenceRef } from "@theta-agent/domain/rag/contracts.js";
import {
  RECOMMENDATION_VERSION,
  recommendationResultSchema,
  type ModelRecommendation,
  type ParameterRecommendation,
  type RecommendationResult,
  type ResourceEstimate,
  type TopicRecommendation,
} from "@theta-agent/domain/recommendation/contracts.js";
import {
  capabilitiesForModel,
  deriveResearchRequirements,
  unmetResearchCapabilities,
  type ModelCapabilities,
  type ResearchRequirements,
} from './model-capabilities.js';

export interface CatalogModel {
  id: string;
  name: string;
  type: string;
  requires: string[];
  params: Record<string, unknown>;
  runnable?: boolean;
  experimental?: boolean;
  autoTopics?: boolean;
  plannerEligible?: boolean;
  maturity?: "production" | "experimental" | "incomplete" | "unavailable";
}

export interface DeterministicRecommendationInput {
  catalogSource: string;
  models: CatalogModel[];
  dataProfile: Record<string, unknown>;
  columnConfirmation?: ColumnConfirmation;
  researchBrief?: ResearchBrief;
  researchGoal?: string;
  constraints?: Record<string, unknown>;
  evidence?: EvidenceRef[];
  capabilityOverrides?: Readonly<Record<string, ModelCapabilities>>;
}

interface ProfileSummary {
  rowCount: number;
  textColumnCount: number;
  timeColumnCount: number;
  metadataColumnCount: number;
  covariateColumnCount: number;
  columnRolesConfirmed: boolean;
  averageTextLength: number;
}

interface RecommendationSignals {
  classicalBaseline: boolean;
  shortText: boolean;
  unknownTopicCount: boolean;
  semanticClustering: boolean;
  localEmbeddingReady: boolean;
}

export const recommendModels = (
  input: DeterministicRecommendationInput,
): RecommendationResult => {
  const summary = summarizeProfile(input);
  const constraints = normalizedConstraints(input.constraints);
  const evidence = input.evidence ?? [];
  const recommendations: ModelRecommendation[] = [];
  const degradedRecommendations: ModelRecommendation[] = [];
  const skipped: RecommendationResult["skipped"] = [];
  const researchRequirements = deriveResearchRequirements(input.researchBrief);
  const signals = recommendationSignals(input, summary, constraints);

  for (const model of [...input.models].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const modelId = model.id.toLowerCase();
    const hardFailures = hardConstraintFailures(
      model,
      summary,
      input,
      constraints,
      signals,
    );
    if (hardFailures.length > 0) {
      skipped.push({ modelId, reasonCodes: hardFailures });
      continue;
    }

    const catalogCapabilities = capabilitiesForModel(
      model,
      input.capabilityOverrides?.[modelId],
    );
    const capabilities =
      modelId === "bertopic" && signals.localEmbeddingReady
        ? { ...catalogCapabilities, offlineExecution: true }
        : catalogCapabilities;
    const unmet = unmetResearchCapabilities(
      capabilities,
      researchRequirements,
    );
    const built = buildRecommendation(
      model,
      summary,
      input,
      constraints,
      evidenceForModel(model, evidence),
      capabilities,
      unmet,
      signals,
    );
    if (unmet.length === 0) {
      recommendations.push(built);
    } else {
      degradedRecommendations.push({
        ...built,
        score: Math.max(0, built.score - 12 * unmet.length),
        warnings: [
          ...built.warnings,
          ...unmet.map(
            (requirement) => `UNMET_RESEARCH_REQUIREMENT:${requirement}`,
          ),
        ],
      });
    }
  }

  const degradationRequired =
    recommendations.length === 0 && degradedRecommendations.length > 0;
  const selectable = degradationRequired
    ? degradedRecommendations
    : recommendations;
  selectable.sort(
    (a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId),
  );
  const ranked = selectable.slice(0, 5).map((item, index) => ({
    ...item,
    rank: index + 1,
  }));

  const warnings = new Set<string>();
  if (evidence.length === 0) warnings.add("NO_EVIDENCE_AVAILABLE");
  if (summary.rowCount < 100) warnings.add("SMALL_CORPUS");
  if (ranked.length === 0) warnings.add("NO_COMPATIBLE_MODEL");
  if (degradationRequired) warnings.add('EXPLICIT_DEGRADATION_APPROVAL_REQUIRED');
  if (ranked[0] && ranked[0].confidence === "low") {
    warnings.add("LOW_CONFIDENCE_RECOMMENDATION");
  }

  return recommendationResultSchema.parse({
    schemaVersion: RECOMMENDATION_VERSION,
    deterministic: true,
    recommendationVersion: RECOMMENDATION_VERSION,
    catalogSource: input.catalogSource || "theta-model-catalog",
    dataProfileSummary: {
      rowCount: summary.rowCount,
      textColumnCount: summary.textColumnCount,
      timeColumnCount: summary.timeColumnCount,
      metadataColumnCount: summary.metadataColumnCount,
      averageTextLength: summary.averageTextLength,
    },
    recommendations: ranked,
    skipped,
    warnings: [...warnings],
    constraintsApplied: constraints,
    researchRequirements,
    degradation: {
      required: degradationRequired,
      unmetRequirements: [
        ...new Set(
          ranked.flatMap(
            (item) => item.capabilityAssessment.unmetResearchRequirements,
          ),
        ),
      ],
      message: degradationRequired
        ? '没有模型同时满足全部研究目标与运行约束；继续前必须明确接受列出的能力降级。'
        : null,
    },
    noEvidence: evidence.length === 0,
  });
};

const summarizeProfile = (
  input: DeterministicRecommendationInput,
): ProfileSummary => {
  const profile = input.dataProfile;
  const columns = input.columnConfirmation;
  const candidates = record(profile.columnCandidates);
  const textProfiles = array(profile.columnProfiles);
  const textColumn = columns?.textColumns[0];
  const matchingProfile = textProfiles
    .map(record)
    .find((item) => item.name === textColumn);
  return {
    rowCount: integer(profile.rowCount),
    textColumnCount:
      columns?.textColumns.length ||
      array(candidates.text).length ||
      array(profile.textColumns).length,
    timeColumnCount:
      columns !== undefined
        ? columns.timeColumn
          ? 1
          : 0
        : array(candidates.time).length ||
          array(profile.timeColumns).length,
    metadataColumnCount:
      columns !== undefined
        ? columns.metadataColumns.length
        : array(candidates.metadata).length ||
          array(profile.metadataColumns).length,
    covariateColumnCount: columns?.covariateColumns?.length ?? 0,
    columnRolesConfirmed: columns !== undefined,
    averageTextLength:
      number(matchingProfile?.avgLength) ||
      number(record(profile.textLengthDistribution).average),
  };
};

const normalizedConstraints = (
  value: Record<string, unknown> | undefined,
): RecommendationResult["constraintsApplied"] => ({
  preferredModelIds: strings(value?.preferredModelIds).sort(),
  forbiddenModelIds: strings(value?.forbiddenModelIds).sort(),
  unavailableRequirements: strings(value?.unavailableRequirements).sort(),
  mode: typeof value?.mode === "string" ? value.mode : null,
  maxTopics:
    typeof value?.maxTopics === "number" && Number.isInteger(value.maxTopics)
      ? value.maxTopics
      : null,
});

const hardConstraintFailures = (
  model: CatalogModel,
  summary: ProfileSummary,
  input: DeterministicRecommendationInput,
  constraints: RecommendationResult["constraintsApplied"],
  signals: RecommendationSignals,
): string[] => {
  const failures = new Set<string>();
  const modelId = model.id.toLowerCase();
  const requirements = model.requires.map((item) => item.toLowerCase());
  if (model.plannerEligible === false) {
    failures.add("PLANNER_CAPABILITY_NOT_ELIGIBLE");
  }
  if (model.maturity === "incomplete" || model.maturity === "unavailable") {
    failures.add("MODEL_MATURITY_NOT_EXECUTABLE");
  }
  if (model.runnable === false) failures.add("MODEL_NOT_RUNNABLE");
  if (constraints.forbiddenModelIds.includes(modelId)) {
    failures.add("MODEL_FORBIDDEN");
  }
  if (!summary.columnRolesConfirmed) {
    failures.add("COLUMN_CONFIRMATION_REQUIRED");
  } else {
    if (summary.textColumnCount === 0) failures.add("TEXT_COLUMN_REQUIRED");
    if (requirements.includes("time") && summary.timeColumnCount === 0) {
      failures.add("TIME_COLUMN_REQUIRED");
    }
    if (
      requirements.includes("covariates") &&
      summary.covariateColumnCount === 0
    ) {
      failures.add("COVARIATE_COLUMN_REQUIRED");
    }
  }
  if (modelId === "bertopic" && !signals.semanticClustering) {
    failures.add("SEMANTIC_CLUSTERING_GOAL_REQUIRED");
  }
  if (modelId === "bertopic" && !signals.localEmbeddingReady) {
    failures.add("LOCAL_EMBEDDING_REQUIRED");
  }
  if (
    requirements.some((requirement) =>
      constraints.unavailableRequirements.includes(requirement),
    )
  ) {
    failures.add("DEPENDENCY_UNAVAILABLE");
  }
  if (
    constraints.mode &&
    modelId !== "theta" &&
    constraints.mode !== "unsupervised"
  ) {
    failures.add("MODE_NOT_SUPPORTED");
  }
  if (
    constraints.mode &&
    modelId === "theta" &&
    !catalogChoices(model, "mode").includes(constraints.mode)
  ) {
    failures.add("MODE_NOT_SUPPORTED");
  }
  if (summary.rowCount < minimumRows(model)) {
    failures.add("DATASET_BELOW_ABSOLUTE_MINIMUM");
  }
  if (
    input.researchBrief?.hardwareLimit.device === "cpu" &&
    modelId === "theta" &&
    input.constraints?.modelSize === "8B"
  ) {
    failures.add("DEVICE_CANNOT_RUN_MODEL");
  }
  return [...failures].sort();
};

const buildRecommendation = (
  model: CatalogModel,
  summary: ProfileSummary,
  input: DeterministicRecommendationInput,
  constraints: RecommendationResult["constraintsApplied"],
  evidence: EvidenceRef[],
  capabilities: ModelCapabilities,
  unmetRequirements: ResearchRequirements['required'],
  signals: RecommendationSignals,
): ModelRecommendation => {
  const modelId = model.id.toLowerCase();
  const decisionEvidence = evidence.filter(isModelDecisionEvidence);
  const reasonCodes = new Set<string>(["RUNNABLE_CATALOG_MODEL"]);
  const warnings = new Set<string>();
  let score = model.type === "traditional" ? 58 : 52;
  if (model.maturity === "experimental" || model.experimental === true) {
    score -= 18;
    warnings.add("EXPERIMENTAL_MODEL_REQUIRES_HUMAN_REVIEW");
    reasonCodes.add("EXPERIMENTAL_CAPABILITY_BOUNDARY");
  }

  if (constraints.preferredModelIds.includes(modelId)) {
    score += 12;
    reasonCodes.add("CALLER_PREFERENCE");
  }
  if (modelId === "dtm" && input.researchBrief?.trendAnalysis) {
    score += 24;
    reasonCodes.add("TREND_ANALYSIS_MATCH");
  }
  if (modelId === "btm" && signals.shortText) {
    score += 18;
    reasonCodes.add("SHORT_TEXT_BTM");
  }
  if (modelId === "stm" && summary.covariateColumnCount > 0) {
    score += 14;
    reasonCodes.add("COVARIATE_ANALYSIS_STM");
  }
  if (modelId === "hdp" && signals.unknownTopicCount) {
    score += 12;
    reasonCodes.add("UNKNOWN_TOPIC_COUNT_HDP");
  }
  if (modelId === "lda" && signals.classicalBaseline) {
    score += 24;
    reasonCodes.add("BASELINE_CLASSICAL_LDA");
  }
  if (modelId === "bertopic" && signals.semanticClustering) {
    score += 22;
    reasonCodes.add("SEMANTIC_CLUSTERING_BERTOPIC");
    warnings.add("LOCAL_EMBEDDING_DRY_RUN_REQUIRED");
  }
  if (modelId === "theta") {
    score += 10;
    reasonCodes.add("THETA_NATIVE_MODEL");
  }
  if (summary.rowCount < 100 && model.type === "neural") {
    score -= 15;
    warnings.add("NEURAL_MODEL_SMALL_CORPUS");
  }
  if (decisionEvidence.length > 0) {
    score += Math.min(10, Math.round(decisionEvidence[0].finalScore / 10));
    reasonCodes.add("EVIDENCE_SUPPORTED");
  }

  const topicRecommendation = recommendTopics(summary.rowCount, constraints);
  const mode = recommendMode(modelId, constraints.mode);
  const batchSize = summary.rowCount < 500 ? 32 : 64;
  const epochs =
    model.type === "traditional" ? 100 : summary.rowCount < 500 ? 30 : 50;
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const rawConfidence =
    boundedScore >= 80 && decisionEvidence.length > 0
      ? "high"
      : boundedScore >= 60
        ? "medium"
        : "low";
  const confidence =
    model.maturity === "experimental" && rawConfidence === "high"
      ? "medium"
      : rawConfidence;

  return {
    rank: 1,
    modelId,
    modelName: model.name || modelId.toUpperCase(),
    maturity: model.maturity ?? (model.experimental ? "experimental" : "production"),
    score: boundedScore,
    confidence,
    reasonCodes: [...reasonCodes],
    warnings: [...warnings],
    requirements: [...model.requires].sort(),
    topicRecommendation,
    parameters: recommendParameters({
      model,
      topicRecommendation,
      batchSize,
      epochs,
      evidence,
      confidence,
    }),
    resourceEstimate: estimateResources(model),
    evidenceRefs: decisionEvidence,
    capabilityAssessment: {
      ...capabilities,
      unmetResearchRequirements: unmetRequirements,
    },
    recommendedPlanPatch: recommendedPlanPatch(
      model,
      mode,
      topicRecommendation,
      batchSize,
      epochs,
      constraints,
    ),
  };
};

const recommendationSignals = (
  input: DeterministicRecommendationInput,
  summary: ProfileSummary,
  constraints: RecommendationResult["constraintsApplied"],
): RecommendationSignals => {
  const goal = `${input.researchGoal ?? ""} ${
    input.researchBrief?.researchQuestion ?? ""
  }`.toLowerCase();
  const unavailable = new Set(constraints.unavailableRequirements);
  return {
    classicalBaseline:
      /(?:经典|传统(?:主题模型)?|词袋).{0,10}(?:基线|对照)|(?:基线|对照).{0,10}(?:经典|传统(?:主题模型)?|词袋)/u.test(
        goal,
      ) ||
      /(?:classical|traditional|bag[- ]?of[- ]?words|bow).{0,24}(?:baseline|benchmark)|(?:baseline|benchmark).{0,24}(?:classical|traditional|bag[- ]?of[- ]?words|bow)/u.test(
        goal,
      ),
    shortText:
      (summary.averageTextLength > 0 && summary.averageTextLength < 80) ||
      /短文本|短评(?:论)?|标题|微博|tweet|short[- ]?text|short comments?/u.test(
        goal,
      ),
    unknownTopicCount:
      /(?:不知道|未知|不确定|自动探索|自动发现).{0,12}(?:主题数|主题数量|多少个?主题)|(?:主题数|主题数量).{0,12}(?:不知道|未知|不确定|自动探索|自动发现)|unknown topic count|infer(?:red)? topic count|discover.{0,12}topic count/u.test(
        goal,
      ),
    semanticClustering:
      /语义(?:聚类|分析|主题)|嵌入(?:聚类|主题)|semantic(?: clustering| analysis| topics?)|embedding(?: clustering| topics?)/u.test(
        goal,
      ),
    localEmbeddingReady:
      input.researchBrief?.requestedEmbedding === "local" &&
      !unavailable.has("sbert") &&
      !unavailable.has("transformer"),
  };
};

const isModelDecisionEvidence = (item: EvidenceRef): boolean =>
  item.objectType === undefined ||
  [
    "source",
    "model",
    "rule",
    "recipe",
    "implementation_capability",
    "project_constraint",
    "conflict_group",
  ].includes(item.objectType);

const recommendTopics = (
  rowCount: number,
  constraints: RecommendationResult["constraintsApplied"],
): TopicRecommendation => {
  const naturalMax = rowCount < 100 ? 8 : rowCount < 500 ? 15 : 30;
  const maximum = Math.max(
    2,
    Math.min(200, constraints.maxTopics ?? naturalMax),
  );
  const minimum = Math.min(maximum, rowCount < 50 ? 2 : 5);
  const firstRun = Math.max(
    minimum,
    Math.min(maximum, Math.round((minimum + maximum) / 2)),
  );
  return {
    range: [minimum, maximum],
    firstRun,
    alternatives: [...new Set([minimum, maximum])],
  };
};

const recommendParameters = (input: {
  model: CatalogModel;
  topicRecommendation: TopicRecommendation;
  batchSize: number;
  epochs: number;
  evidence: EvidenceRef[];
  confidence: "low" | "medium" | "high";
}): ParameterRecommendation[] => {
  const modelId = input.model.id.toLowerCase();
  if (modelId === "hdp") {
    const evidenceRefs = parameterEvidenceRefs(input.evidence, "maxTopics");
    return [
      {
        name: "maxTopics",
        recommended: catalogDefault(input.model, "max_topics", 150),
        range: [2, 1000],
        default: catalogDefault(input.model, "max_topics", 150),
        reasonCodes: ["AUTO_TOPIC_UPPER_BOUND"],
        evidenceRefs,
        confidence: evidenceRefs.length ? input.confidence : "low",
        effectIfHigher: "Allows HDP to retain more low-mass topics.",
        effectIfLower: "Constrains the inferred topic space.",
      },
    ];
  }
  if (modelId === "bertopic") {
    return ["n_neighbors", "min_cluster_size"].map((catalogName) => {
      const camelName =
        catalogName === "n_neighbors" ? "nNeighbors" : "minClusterSize";
      const evidenceRefs = parameterEvidenceRefs(input.evidence, camelName);
      return {
        name: camelName,
        recommended: catalogDefault(
          input.model,
          catalogName,
          catalogName === "n_neighbors" ? 15 : 10,
        ),
        range: [2, 100] as [number, number],
        default: catalogDefault(
          input.model,
          catalogName,
          catalogName === "n_neighbors" ? 15 : 10,
        ),
        reasonCodes: ["BERTOPIC_CLUSTERING_DEFAULT"],
        evidenceRefs,
        confidence: evidenceRefs.length ? input.confidence : "low",
        effectIfHigher:
          catalogName === "n_neighbors"
            ? "Preserves broader manifold structure."
            : "Requires larger, fewer clusters.",
        effectIfLower:
          catalogName === "n_neighbors"
            ? "Emphasizes local manifold structure."
            : "Allows smaller, more granular clusters.",
      };
    });
  }
  const recommendations: ParameterRecommendation[] = [
    {
      name: "numTopics",
      recommended: input.topicRecommendation.firstRun,
      range: input.topicRecommendation.range,
      default: catalogDefault(input.model, "num_topics", 20),
      reasonCodes: ["CORPUS_SIZE_TOPIC_RANGE"],
      evidenceRefs: parameterEvidenceRefs(input.evidence, "numTopics"),
      confidence: parameterEvidenceRefs(input.evidence, "numTopics").length
        ? input.confidence
        : "low",
      effectIfHigher: "Increases topic granularity and fragmentation risk.",
      effectIfLower: "Produces broader topics and may merge distinct themes.",
    },
  ];
  if (
    "batch_size" in input.model.params ||
    ["dtm", "theta"].includes(modelId)
  ) {
    recommendations.push({
      name: "batchSize",
      recommended: input.batchSize,
      range: [16, 128],
      default: catalogDefault(input.model, "batch_size", 64),
      reasonCodes: ["RESOURCE_AWARE_BATCH_SIZE"],
      evidenceRefs: parameterEvidenceRefs(input.evidence, "batchSize"),
      confidence: parameterEvidenceRefs(input.evidence, "batchSize").length
        ? input.confidence
        : "low",
      effectIfHigher: "Uses more memory and may improve throughput.",
      effectIfLower: "Uses less memory with potentially noisier updates.",
    });
  }
  if (
    "epochs" in input.model.params ||
    modelId === "btm"
  ) {
    recommendations.push({
      name: "epochs",
      recommended: input.epochs,
      range: [10, 100],
      default: catalogDefault(input.model, "epochs", 100),
      reasonCodes: ["MODEL_TYPE_EPOCH_BUDGET"],
      evidenceRefs: parameterEvidenceRefs(input.evidence, "epochs"),
      confidence: parameterEvidenceRefs(input.evidence, "epochs").length
        ? input.confidence
        : "low",
      effectIfHigher: "Increases runtime and overfitting risk.",
      effectIfLower: "Reduces runtime but may underfit.",
    });
  }
  return recommendations;
};

const parameterEvidenceRefs = (
  evidence: readonly EvidenceRef[],
  parameterId: string,
): string[] => {
  const wanted = normalizeIdentifier(parameterId);
  return evidence
    .filter(
      (item) =>
        (item.authority === "L1" || item.authority === "L2") &&
        item.parameterIds?.some(
          (candidate) => normalizeIdentifier(candidate) === wanted,
        ),
    )
    .map((item) => item.evidenceId)
    .slice(0, 3);
};

const normalizeIdentifier = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/gu, "");

const catalogDefault = (
  model: CatalogModel,
  key: string,
  fallback: string | number | boolean | null,
): string | number | boolean | null => {
  const value = record(model.params[key]).default;
  return ["string", "number", "boolean"].includes(typeof value) ||
    value === null
    ? (value as string | number | boolean | null)
    : fallback;
};

const estimateResources = (model: CatalogModel): ResourceEstimate => {
  const requirements = model.requires.map((item) => item.toLowerCase());
  const neural = model.type === "neural";
  const embedding = requirements.some((item) =>
    ["sbert", "qwen", "word2vec"].includes(item),
  );
  return {
    cpu: neural ? "high" : "medium",
    gpu: neural ? "optional" : "none",
    memory: neural ? "high" : "medium",
    disk: embedding ? "high" : "low",
    relativeRuntime: neural ? "long" : "medium",
    network: embedding ? "optional" : "none",
  };
};

const evidenceForModel = (
  model: CatalogModel,
  evidence: readonly EvidenceRef[],
): EvidenceRef[] => {
  const modelId = model.id.toLowerCase();
  const terms = [model.id, model.name].map((item) => item.toLowerCase());
  const matching = evidence.filter((item) => {
    if (item.thetaSupportStatus === "unsupported") return false;
    if (item.modelIds?.some((candidate) => candidate.toLowerCase() === modelId)) {
      return true;
    }
    // Legacy code/config chunks may not have structured modelIds. Retain only
    // exact model-name matches; runtime requirements such as "bow" or "sbert"
    // are deliberately not model evidence.
    const text = `${item.symbol ?? ""} ${item.excerpt}`.toLowerCase();
    return terms.some((term) => exactTerm(text, term));
  });
  return matching.slice(0, 3);
};

const exactTerm = (text: string, term: string): boolean => {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return false;
  if (/^[a-z0-9_-]+$/u.test(normalized)) {
    return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(normalized)}([^a-z0-9_-]|$)`, "u").test(text);
  }
  return text.includes(normalized);
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const minimumRows = (model: CatalogModel): number => {
  if (model.id.toLowerCase() === "dtm") return 30;
  if (model.id.toLowerCase() === "bertopic") return 30;
  return model.type === "neural" ? 20 : 10;
};

const recommendMode = (
  modelId: string,
  requested: string | null,
): ModelRecommendation["recommendedPlanPatch"]["mode"] => {
  if (
    modelId === "theta" &&
    requested &&
    ["zero_shot", "supervised", "unsupervised"].includes(requested)
  ) {
    return requested as ModelRecommendation["recommendedPlanPatch"]["mode"];
  }
  return modelId === "theta" ? "zero_shot" : "unsupervised";
};

const recommendedPlanPatch = (
  model: CatalogModel,
  mode: ModelRecommendation["recommendedPlanPatch"]["mode"],
  topics: TopicRecommendation,
  batchSize: number,
  epochs: number,
  constraints: RecommendationResult["constraintsApplied"],
): ModelRecommendation["recommendedPlanPatch"] => {
  const modelId = model.id.toLowerCase();
  if (modelId === "hdp") {
    return {
      modelId,
      mode: "unsupervised",
      topicCountMode: "auto",
      numTopics: null,
      maxTopics:
        constraints.maxTopics ??
        Number(catalogDefault(model, "max_topics", 150)),
    };
  }
  if (modelId === "bertopic") {
    return {
      modelId,
      mode: "unsupervised",
      topicCountMode: "auto",
      numTopics: null,
      nNeighbors: Number(catalogDefault(model, "n_neighbors", 15)),
      nComponents: Number(catalogDefault(model, "n_components", 5)),
      minClusterSize: Number(
        catalogDefault(model, "min_cluster_size", 10),
      ),
      minSamples: catalogDefault(model, "min_samples", null) as number | null,
      topNWords: Number(catalogDefault(model, "top_n_words", 10)),
      randomState: Number(catalogDefault(model, "random_state", 42)),
    };
  }
  return {
    modelId,
    mode,
    topicCountMode: "fixed",
    numTopics: topics.firstRun,
    ...("batch_size" in model.params || ["dtm", "theta"].includes(modelId)
      ? { batchSize }
      : {}),
    ...("epochs" in model.params || modelId === "btm" ? { epochs } : {}),
  };
};

const catalogChoices = (model: CatalogModel, key: string): string[] =>
  array(record(model.params[key]).choices)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());

const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  array(value)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const integer = (value: unknown): number =>
  Math.max(0, Math.trunc(number(value)));
