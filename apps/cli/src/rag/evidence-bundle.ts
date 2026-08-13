import { createHash } from "node:crypto";
import { z } from "zod";
import { evidenceRefSchema, type EvidenceRef } from "./contracts.js";
import type { RetrievalTrace } from "./fts-index.js";
import type {
  DatasetConfirmation,
  DatasetFacts,
  ResearchIntent,
} from '../dataset-understanding/contracts.js';

export const EVIDENCE_BUNDLE_VERSION = "1.0.0";

export const evidencePurposeSchema = z.enum([
  "model_selection",
  "hyperparameter",
  "preprocessing",
  "evaluation",
  "resource_and_environment",
  "failure_diagnosis",
]);

export const evidenceCoverageSchema = z.enum([
  "implementation",
  "model",
  "parameter",
  "preprocessing",
  "evaluation",
  "resource",
  "failure",
  "paper",
]);

export const evidenceQuerySchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    purpose: evidencePurposeSchema,
    query: z.string().trim().min(1).max(1000),
    rationale: z.string().trim().min(1).max(500),
    requiredCoverage: z.array(evidenceCoverageSchema).max(8),
  })
  .strict();

const traceSummarySchema = z
  .object({
    candidateCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    routesUsed: z.array(z.enum(["exact", "fts_raw", "fts_tokens", "fts_grams"])),
    coverage: z.array(z.string()),
  })
  .strict();

const evidenceQueryResultSchema = z
  .object({
    queryId: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
    noEvidence: z.boolean(),
    trace: traceSummarySchema,
  })
  .strict();

const evidenceConflictSchema = z
  .object({
    conflictGroupId: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
    summary: z.string().min(1).max(1200),
    requiresHumanAttention: z.boolean(),
  })
  .strict();

const evidenceUncertaintySchema = z
  .object({
    code: z.enum([
      "QUERY_NO_EVIDENCE",
      "IMPLEMENTATION_EVIDENCE_MISSING",
      "PAPER_EVIDENCE_MISSING",
      "CONFLICT_REQUIRES_RESOLUTION",
      "METADATA_ONLY_EVIDENCE",
    ]),
    message: z.string().min(1).max(800),
    relatedQueryIds: z.array(z.string().min(1)),
  })
  .strict();

export const evidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_BUNDLE_VERSION),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    queries: z.array(evidenceQuerySchema).min(1).max(16),
    queryResults: z.array(evidenceQueryResultSchema).min(1).max(16),
    evidence: z.array(evidenceRefSchema).max(30),
    coverage: z.array(evidenceCoverageSchema),
    authorityCounts: z
      .object({
        L1: z.number().int().nonnegative(),
        L2: z.number().int().nonnegative(),
        L3: z.number().int().nonnegative(),
        L4: z.number().int().nonnegative(),
      })
      .strict(),
    conflicts: z.array(evidenceConflictSchema),
    uncertainties: z.array(evidenceUncertaintySchema),
    noEvidence: z.boolean(),
  })
  .strict();

export type EvidencePurpose = z.infer<typeof evidencePurposeSchema>;
export type EvidenceCoverage = z.infer<typeof evidenceCoverageSchema>;
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export interface EvidenceQueryExecution {
  query: EvidenceQuery;
  evidence: EvidenceRef[];
  trace: RetrievalTrace;
}

export interface PlanEvidenceQueryInput {
  researchBrief: Record<string, unknown>;
  datasetProfile: Record<string, unknown>;
  columnConfirmation: Record<string, unknown>;
  researchGoal?: string;
}

export const planEvidenceQueriesV2 = (input: {
  facts: DatasetFacts;
  confirmation: DatasetConfirmation;
  intent: ResearchIntent;
}): EvidenceQuery[] => {
  const context = compact([
    input.intent.researchQuestion,
    `rows ${input.facts.rowCount}`,
    `text columns ${input.confirmation.textColumns.join(' ')}`,
    input.intent.temporalAnalysis
      ? input.intent.temporalPurpose === 'topic_evolution'
        ? `native temporal topic evolution ${input.confirmation.timeColumns.join(' ')}`
        : `posthoc temporal trend aggregation ${input.confirmation.timeColumns.join(' ')}`
      : 'static topic analysis',
    input.intent.comparisonDimensions.length
      ? input.intent.comparisonPurpose === 'model'
        ? `comparison as training covariates ${input.intent.comparisonDimensions.join(' ')}`
        : `posthoc display comparison ${input.intent.comparisonDimensions.join(' ')}`
      : '',
    input.confirmation.groupColumns?.length
      ? `group comparison ${input.confirmation.groupColumns.join(' ')}`
      : '',
    input.confirmation.covariateColumns?.length
      ? `training covariates ${input.confirmation.covariateColumns.join(' ')}`
      : '',
    `topic granularity ${input.intent.topicGranularity}`,
    input.intent.successCriteria.join(' '),
    input.intent.constraints.join(' '),
  ]);
  return [
    query('v2-model-selection', 'model_selection', `${context} LDA BTM HDP DTM STM BERTopic THETA applicability baseline`, '为原生 Planner V2 检索模型选择依据。', ['implementation', 'model', 'paper']),
    query('v2-parameters', 'hyperparameter', `${context} topic count parameters seeds hyperparameter ranges`, '检索参数和实验设计依据。', ['parameter', 'implementation', 'paper']),
    query('v2-preprocessing', 'preprocessing', `${context} preprocessing tokenization empty duplicate vocabulary`, '检索预处理依据。', ['preprocessing', 'implementation']),
    query('v2-evaluation', 'evaluation', `${context} coherence diversity stability human interpretation evaluation visualization`, '检索评价和展示依据。', ['evaluation', 'paper']),
    query('v2-resources', 'resource_and_environment', `${context} CPU GPU memory offline runtime dependencies`, '检索资源约束依据。', ['resource', 'implementation']),
  ];
};

export const planEvidenceQueries = (
  input: PlanEvidenceQueryInput,
): EvidenceQuery[] => {
  const brief = input.researchBrief;
  const profile = input.datasetProfile;
  const columns = input.columnConfirmation;
  const averageTextLength = numberValue(record(profile.textLengthDistribution).average);
  const rowCount = numberValue(profile.rowCount);
  const comparisonGroups = stringArray(brief.comparisonGroups);
  const context = compact([
    stringValue(brief.researchQuestion),
    input.researchGoal,
    stringValue(brief.analysisUnit),
    stringValue(brief.textFieldIntent),
    stringValue(brief.language),
    stringArray(brief.successCriteria).join(" "),
    comparisonGroups.length ? `group comparison ${comparisonGroups.join(" ")}` : "",
    brief.trendAnalysis === true || stringValue(columns.timeColumn)
      ? "temporal trend time slices DTM"
      : "static topics",
    averageTextLength !== undefined && averageTextLength < 80
      ? `short text sparse documents average length ${averageTextLength}`
      : averageTextLength !== undefined
        ? `document average length ${averageTextLength}`
        : "",
    rowCount !== undefined ? `corpus rows ${rowCount}` : "",
    stringArray(columns.covariateColumns).length
      ? `explicit training covariates STM ${stringArray(columns.covariateColumns).join(" ")}`
      : "",
    stringArray(columns.groupingColumns).length
      ? `posthoc grouping ${stringArray(columns.groupingColumns).join(" ")}`
      : "",
    stringArray(columns.evaluationLabelColumns).length
      ? `held out evaluation labels ${stringArray(columns.evaluationLabelColumns).join(" ")}`
      : "",
    brief.offlineOnly === true ? "offline local only" : "network allowed",
    `device ${stringValue(record(brief.hardwareLimit).device) ?? "unknown"}`,
    stringValue(brief.topicGranularity)
      ? `topic granularity ${stringValue(brief.topicGranularity)}`
      : "",
  ]);

  return [
    query(
      "research-model-selection",
      "model_selection",
      `${context} choose primary baseline alternative LDA HDP BTM DTM STM BERTopic THETA model selection applicability`,
      "寻找与研究目标、文本形态和列结构匹配的模型依据。",
      ["implementation", "model", "paper"],
    ),
    query(
      "research-hyperparameters",
      "hyperparameter",
      `${context} topic count mode numTopics maxTopics epochs batch size clustering hyperparameter candidate range`,
      "寻找主题数和模型特有参数的候选范围及语义边界。",
      ["parameter", "implementation", "paper"],
    ),
    query(
      "research-preprocessing",
      "preprocessing",
      `${context} preprocessing tokenization empty text duplicates vocabulary embeddings language domain fit biterm`,
      "寻找会改变可行性或模型可比性的预处理要求。",
      ["preprocessing", "implementation"],
    ),
    query(
      "research-evaluation",
      "evaluation",
      `${context} evaluation coherence C_V NPMI perplexity topic diversity stability multi seed human word intrusion acceptance`,
      "寻找自动指标、稳定性和人工解释的联合验收依据。",
      ["evaluation", "paper"],
    ),
    query(
      "research-resources",
      "resource_and_environment",
      `${context} CPU GPU memory runtime offline dependency embedding cache environment requirements`,
      "寻找本地运行、硬件和离线资产的实现约束。",
      ["resource", "implementation"],
    ),
    query(
      "research-failures",
      "failure_diagnosis",
      `${context} failure risk topic collapse empty vocabulary outliers microclusters unstable slices no biterms troubleshooting`,
      "寻找训练前必须暴露的失败模式和诊断方法。",
      ["failure", "implementation", "paper"],
    ),
  ];
};

export const planCandidateEvidenceQueries = (
  input: PlanEvidenceQueryInput,
  modelIds: readonly string[],
): EvidenceQuery[] => {
  const models = [...new Set(modelIds.map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 5);
  if (models.length === 0) return [];
  const context = compact([
    stringValue(input.researchBrief.researchQuestion),
    input.researchGoal,
    `candidate models ${models.join(" ")}`,
    input.researchBrief.trendAnalysis === true ? "temporal" : "static",
    input.researchBrief.offlineOnly === true ? "offline" : "online",
  ]);
  return [
    query(
      "candidate-capabilities",
      "hyperparameter",
      `${context} implementation capability parameter semantics topic count training fields backend differences`,
      "为确定性候选补齐模型特有参数与实现边界。",
      ["implementation", "parameter", "paper"],
    ),
    query(
      "candidate-acceptance",
      "evaluation",
      `${context} model-specific evaluation failure risks comparison baseline stability human review artifacts`,
      "为候选模型补齐对照实验、失败诊断与人工验收依据。",
      ["evaluation", "failure", "paper"],
    ),
  ];
};

export const buildEvidenceBundle = (
  executions: readonly EvidenceQueryExecution[],
  limit = 24,
  requiredModelIds: readonly string[] = [],
): EvidenceBundle => {
  const boundedLimit = Math.max(1, Math.min(limit, 30));
  const candidates = mergeCandidates(executions);
  const selected: EvidenceRef[] = [];
  const selectedIds = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const take = (item: EvidenceRef | undefined): void => {
    if (!item || selectedIds.has(item.evidenceId)) return;
    if ((sourceCounts.get(item.sourceId) ?? 0) >= 3) return;
    selected.push(item);
    selectedIds.add(item.evidenceId);
    sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) ?? 0) + 1);
  };
  const forceTake = (item: EvidenceRef | undefined): void => {
    if (!item || selectedIds.has(item.evidenceId)) return;
    selected.push(item);
    selectedIds.add(item.evidenceId);
    sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) ?? 0) + 1);
  };

  // Candidate cards are mandatory planner context, not opportunistic search
  // hits. Reserve them before diversity/coverage filling.
  for (const modelId of [...new Set(requiredModelIds.map((item) => item.toLowerCase()))]) {
    forceTake(
      candidates.find(
        (item) =>
          item.objectId === `model.${modelId}` ||
          (item.objectType === "model" && item.modelIds?.includes(modelId)),
      ),
    );
  }

  for (const execution of executions) {
    take(candidates.find((item) => execution.evidence.some((match) => match.evidenceId === item.evidenceId)));
  }
  for (const coverage of evidenceCoverageSchema.options) {
    take(candidates.find((item) => coverageFor(item).includes(coverage)));
  }
  take(candidates.find((item) => item.authority === "L1" || item.authority === "L2"));
  take(candidates.find((item) => item.authority === "L3" || item.authority === "L4"));
  for (const item of candidates) {
    if (selected.length >= boundedLimit) break;
    take(item);
  }
  selected.splice(boundedLimit);

  const coverage = [...new Set(selected.flatMap(coverageFor))];
  const authorityCounts = { L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const item of selected) authorityCounts[item.authority] += 1;
  const queryResults = executions.map((execution) => ({
    queryId: execution.query.id,
    evidenceIds: execution.evidence.map((item) => item.evidenceId),
    noEvidence: execution.evidence.length === 0,
    trace: {
      candidateCount: execution.trace.candidateCount,
      selectedCount: execution.trace.selectedCount,
      routesUsed: execution.trace.routesUsed,
      coverage: execution.trace.coverage,
    },
  }));
  const conflicts = conflictGroups(selected);
  const uncertainties = [
    ...executions
      .filter((execution) => execution.evidence.length === 0)
      .map((execution) => ({
        code: "QUERY_NO_EVIDENCE" as const,
        message: `检索问题“${execution.query.rationale}”没有返回本地证据。`,
        relatedQueryIds: [execution.query.id],
      })),
    ...(authorityCounts.L1 + authorityCounts.L2 === 0
      ? [{
          code: "IMPLEMENTATION_EVIDENCE_MISSING" as const,
          message: "证据包缺少 THETA 实现或官方项目文档，不能编译为可执行参数。",
          relatedQueryIds: executions.map((item) => item.query.id),
        }]
      : []),
    ...(authorityCounts.L3 + authorityCounts.L4 === 0
      ? [{
          code: "PAPER_EVIDENCE_MISSING" as const,
          message: "证据包缺少论文或综述，只能依据当前实现给出保守方案。",
          relatedQueryIds: executions.map((item) => item.query.id),
        }]
      : []),
    ...conflicts.map((conflict) => ({
      code: "CONFLICT_REQUIRES_RESOLUTION" as const,
      message: conflict.summary,
      relatedQueryIds: executions.map((item) => item.query.id),
    })),
    ...(selected.some((item) => item.scenarioTags?.includes("metadata_only"))
      ? [{
          code: "METADATA_ONLY_EVIDENCE" as const,
          message: "部分文献只有元数据，只能用于发现来源，不能支持公式、阈值或硬规则。",
          relatedQueryIds: executions.map((item) => item.query.id),
        }]
      : []),
  ];
  const material = {
    schemaVersion: EVIDENCE_BUNDLE_VERSION,
    queries: executions.map((item) => item.query),
    queryResults,
    evidence: selected,
    coverage,
    authorityCounts,
    conflicts,
    uncertainties,
    noEvidence: selected.length === 0,
  };
  return evidenceBundleSchema.parse({
    ...material,
    bundleHash: sha256(canonicalJson(material)),
  });
};

const mergeCandidates = (executions: readonly EvidenceQueryExecution[]): EvidenceRef[] => {
  const merged = new Map<string, EvidenceRef>();
  for (const execution of executions) {
    for (const item of execution.evidence) {
      const existing = merged.get(item.evidenceId);
      if (!existing || item.finalScore > existing.finalScore) merged.set(item.evidenceId, item);
    }
  }
  return [...merged.values()].sort((a, b) =>
    weightedScore(b) - weightedScore(a) || a.evidenceId.localeCompare(b.evidenceId),
  );
};

const weightedScore = (item: EvidenceRef): number =>
  item.finalScore + ({ L1: 8, L2: 5, L3: 2, L4: 0 } as const)[item.authority];

const coverageFor = (item: EvidenceRef): EvidenceCoverage[] => {
  const coverage = new Set<EvidenceCoverage>();
  if (item.authority === "L1" || item.authority === "L2") coverage.add("implementation");
  if (item.authority === "L3" || item.authority === "L4" || /^(paper|survey)\./.test(item.sourceId)) coverage.add("paper");
  if (item.objectType === "model" || item.objectType === "implementation_capability" || item.objectType === "source") coverage.add("model");
  if (item.objectType === "parameter" || (item.parameterIds?.length ?? 0) > 0) coverage.add("parameter");
  if (item.objectType === "evaluation_metric" || item.scenarioTags?.some((tag) => /evaluation|coherence|stability|human_review/i.test(tag))) coverage.add("evaluation");
  if (item.objectType === "failure_mode") coverage.add("failure");
  if (item.scenarioTags?.some((tag) => /preprocess|token|clean|vocabulary|biterm/i.test(tag))) coverage.add("preprocessing");
  if (item.scenarioTags?.some((tag) => /resource|cpu|gpu|offline|environment|hardware/i.test(tag))) coverage.add("resource");
  return [...coverage];
};

const conflictGroups = (evidence: readonly EvidenceRef[]): EvidenceBundle["conflicts"] => {
  const groups = new Map<string, EvidenceRef[]>();
  for (const item of evidence) {
    if (!item.conflictGroupId) continue;
    groups.set(item.conflictGroupId, [...(groups.get(item.conflictGroupId) ?? []), item]);
  }
  return [...groups.entries()].map(([conflictGroupId, items]) => ({
    conflictGroupId,
    evidenceIds: items.map((item) => item.evidenceId),
    summary: items.map((item) => item.title ?? item.excerpt.slice(0, 120)).join("；"),
    requiresHumanAttention: true,
  }));
};

const query = (
  id: string,
  purpose: EvidencePurpose,
  value: string,
  rationale: string,
  requiredCoverage: EvidenceCoverage[],
): EvidenceQuery => evidenceQuerySchema.parse({
  id,
  purpose,
  query: value.replace(/\s+/g, " ").trim().slice(0, 1000),
  rationale,
  requiredCoverage,
});

const compact = (parts: Array<string | undefined>): string =>
  parts.filter((item): item is string => Boolean(item?.trim())).join(" ").replace(/\s+/g, " ").trim();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
