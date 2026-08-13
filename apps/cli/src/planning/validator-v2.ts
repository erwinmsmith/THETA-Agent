import { CapabilityRegistry } from "../capabilities/registry.js";
import type {
  CapabilityCatalogModel,
  CapabilityParameter,
  ModelCapabilityCard,
} from "../capabilities/contracts.js";

export const PLAN_VALIDATOR_VERSION = "2.0.0" as const;

export type ValidatorFindingLevel =
  | "error"
  | "blocking_warning"
  | "warning"
  | "informational";

export interface ValidatorFinding {
  findingId: string;
  level: ValidatorFindingLevel;
  code: string;
  jsonPath: string;
  message: string;
  evidenceRefs: string[];
  suggestedFix: string;
  autoFixAllowed: boolean;
}

export interface ValidateTrainingPlanV2Input {
  plan: Record<string, unknown>;
  models: readonly CapabilityCatalogModel[];
  dataProfile?: Record<string, unknown>;
  offlineOnly?: boolean;
  device?: "cpu" | "gpu" | "unknown";
  registry?: CapabilityRegistry;
}

export interface TrainingPlanValidationV2 {
  validatorVersion: typeof PLAN_VALIDATOR_VERSION;
  valid: boolean;
  errors: string[];
  blockingWarnings: string[];
  warnings: string[];
  findings: ValidatorFinding[];
  normalizedPlan: Record<string, unknown>;
  catalogSource: string;
}

const STRUCTURAL_FIELDS = new Set([
  "datasetId",
  "modelId",
  "mode",
  "topicCountMode",
  "numTopics",
  "maxTopics",
  "textColumn",
  "timeColumn",
  "idColumn",
  "covariateColumns",
  "metadataColumns",
  "groupingColumns",
  "evaluationLabelColumns",
  "parameters",
  "acceptDegradation",
  "experimentProtocol",
]);

const SHARED_BOW_BASELINE_MODELS = new Set(["lda", "btm", "hdp", "stm"]);

export const validateTrainingPlanV2 = (
  input: ValidateTrainingPlanV2Input,
): TrainingPlanValidationV2 => {
  const registry = input.registry ?? new CapabilityRegistry();
  const audit = registry.auditCatalog(input.models);
  const findings: ValidatorFinding[] = [];
  const normalized: Record<string, unknown> = {};
  const add = findingWriter(findings);

  if (audit.status === "fail") {
    for (const issue of audit.issues.filter(
      (candidate) => candidate.severity === "error",
    )) {
      add(
        "error",
        "CAPABILITY_REGISTRY_DRIFT",
        "$.modelId",
        issue.message,
        issue.modelId ? [`MODEL_CARD:${issue.modelId}`] : [],
        "修复 Capability Registry 与 Catalog/CLI 的漂移后重新生成计划。",
      );
    }
    return validationResult(findings, normalized);
  }

  const datasetId = stringValue(input.plan.datasetId);
  if (!datasetId) {
    add(
      "error",
      "DATASET_ID_REQUIRED",
      "$.datasetId",
      "datasetId 不能为空。",
      [],
      "绑定当前数据集标识。",
    );
  } else {
    normalized.datasetId = datasetId;
  }

  const modelId = stringValue(input.plan.modelId)?.toLowerCase();
  const catalogModel = input.models.find(
    (candidate) => candidate.id.toLowerCase() === modelId,
  );
  const card = modelId ? registry.get(modelId) : undefined;
  if (!modelId) {
    add(
      "error",
      "MODEL_ID_REQUIRED",
      "$.modelId",
      "modelId 不能为空。",
      [],
      "选择一个已审计模型。",
    );
  } else if (!catalogModel) {
    add(
      "error",
      "MODEL_NOT_IN_CATALOG",
      "$.modelId",
      `模型 '${modelId}' 不在本地 THETA Catalog 中。`,
      [],
      "从本地 Catalog 中选择模型。",
    );
  } else if (!card) {
    add(
      "error",
      "MODEL_NOT_AUDITED",
      "$.modelId",
      `模型 '${modelId}' 尚无 Capability Card。`,
      [],
      "先完成该模型的能力审计。",
    );
  } else {
    normalized.modelId = modelId;
    if (catalogModel.runnable !== true) {
      add(
        "error",
        "MODEL_NOT_RUNNABLE",
        "$.modelId",
        `模型 '${modelId}' 没有可用的 run_pipeline 入口。`,
        [`MODEL_CARD:${modelId}`],
        "修复训练入口或选择其他模型。",
      );
    }
    if (!card.planner.eligible) {
      add(
        "error",
        "MODEL_NOT_PLANNER_ELIGIBLE",
        "$.modelId",
        `模型 '${modelId}' 当前禁止进入自动计划。`,
        [`MODEL_CARD:${modelId}`],
        card.planner.reason,
      );
    }
  }

  if (!catalogModel || !card || !modelId) {
    return validationResult(findings, normalized);
  }

  validateMode(input.plan, catalogModel, modelId, normalized, add);
  validateColumns(input, card, normalized, add);
  validateTopicCount(input.plan, card, normalized, add);
  validateParameters(input.plan, registry, card, normalized, add);
  validateExperimentProtocol(input, modelId, normalized, add, registry);
  validateRuntimePolicy(input, card, add);
  validateProfileRisks(input.dataProfile, add);

  return validationResult(findings, normalized);
};

export const flatPlanFromCanonical = (
  canonicalPlan: Record<string, unknown>,
): Record<string, unknown> => {
  const model = record(canonicalPlan.model);
  const columns = record(canonicalPlan.columns);
  return {
    datasetId: canonicalPlan.datasetId,
    modelId: model.modelId,
    mode: model.mode,
    topicCountMode: model.topicCountMode ?? "fixed",
    numTopics: model.numTopics,
    maxTopics: model.maxTopics,
    ...record(model.parameters),
    textColumn: array(columns.textColumns)[0],
    timeColumn: columns.timeColumn,
    idColumn: columns.idColumn,
    covariateColumns: array(columns.covariateColumns),
    metadataColumns: array(columns.metadataColumns),
    experimentProtocol: canonicalPlan.experimentProtocol,
  };
};

const validateExperimentProtocol = (
  input: ValidateTrainingPlanV2Input,
  primaryModelId: string,
  normalized: Record<string, unknown>,
  add: ReturnType<typeof findingWriter>,
  registry: CapabilityRegistry,
): void => {
  const suppliedProtocol = record(input.plan.experimentProtocol);
  const raw = Object.keys(suppliedProtocol).length > 0
    ? suppliedProtocol
    : {
        mode: "quick",
        primarySeeds: [42],
        baselineModelId: null,
        baselineSeeds: [],
        rationale: "未批准额外比较实验，执行一次主模型快速运行。",
        evidenceRefs: [],
        confidence: "low",
      };
  const mode = stringValue(raw.mode);
  const rawPrimarySeeds = array(raw.primarySeeds);
  const rawBaselineSeeds = array(raw.baselineSeeds);
  const primarySeeds = integerArray(raw.primarySeeds);
  const baselineModelId = stringValue(raw.baselineModelId)?.toLowerCase() ?? null;
  const baselineSeeds = integerArray(raw.baselineSeeds);
  const rationale = stringValue(raw.rationale);
  const evidenceRefs = stringArray(raw.evidenceRefs);
  const confidence = stringValue(raw.confidence);

  if (rawPrimarySeeds.length !== primarySeeds.length) {
    add(
      "error",
      "EXPERIMENT_SEED_TYPE_INVALID",
      "$.experimentProtocol.primarySeeds",
      "primarySeeds 只能包含整数。",
      [],
      "删除小数、字符串或其他非整数值。",
    );
  }
  if (rawBaselineSeeds.length !== baselineSeeds.length) {
    add(
      "error",
      "EXPERIMENT_SEED_TYPE_INVALID",
      "$.experimentProtocol.baselineSeeds",
      "baselineSeeds 只能包含整数。",
      [],
      "删除小数、字符串或其他非整数值。",
    );
  }

  if (!mode || !["quick", "comparative", "stability"].includes(mode)) {
    add(
      "error",
      "EXPERIMENT_MODE_INVALID",
      "$.experimentProtocol.mode",
      "实验协议 mode 必须是 quick、comparative 或 stability。",
      [],
      "明确选择一次快速运行、基线比较或稳定性复验。",
    );
  }
  if (!rationale) {
    add(
      "error",
      "EXPERIMENT_RATIONALE_REQUIRED",
      "$.experimentProtocol.rationale",
      "实验次数和比较方式必须提供理由。",
      [],
      "说明为什么本轮需要这些训练运行。",
    );
  }
  if (!confidence || !["low", "medium", "high"].includes(confidence)) {
    add(
      "error",
      "EXPERIMENT_CONFIDENCE_INVALID",
      "$.experimentProtocol.confidence",
      "实验协议 confidence 必须是 low、medium 或 high。",
      [],
      "记录该实验设计的置信度。",
    );
  }
  validateSeedSet(primarySeeds, "primarySeeds", 1, 5, add);
  validateSeedSet(baselineSeeds, "baselineSeeds", 0, 3, add);
  if (primarySeeds.length + baselineSeeds.length > 6) {
    add(
      "error",
      "EXPERIMENT_RUN_LIMIT_EXCEEDED",
      "$.experimentProtocol",
      "一次计划最多允许 6 次真实模型训练。",
      evidenceRefs,
      "减少主模型或基线随机种子的数量。",
    );
  }

  if (mode === "quick") {
    if (primarySeeds.length !== 1 || baselineModelId !== null || baselineSeeds.length !== 0) {
      add(
        "error",
        "QUICK_PROTOCOL_MUST_BE_SINGLE_RUN",
        "$.experimentProtocol",
        "quick 协议只能执行一次主模型训练，不能包含基线。",
        evidenceRefs,
        "保留一个 primary seed，并清空 baselineModelId 与 baselineSeeds。",
      );
    }
  }
  if (mode === "comparative" && baselineModelId === null) {
    add(
      "error",
      "COMPARATIVE_BASELINE_REQUIRED",
      "$.experimentProtocol.baselineModelId",
      "comparative 协议必须明确一个对照模型。",
      evidenceRefs,
      "从已推荐且可执行的 BOW 模型中选择基线。",
    );
  }
  if (mode === "stability" && primarySeeds.length < 3) {
    add(
      "error",
      "STABILITY_REQUIRES_THREE_SEEDS",
      "$.experimentProtocol.primarySeeds",
      "stability 协议至少需要 3 个不同的主模型随机种子。",
      evidenceRefs,
      "提供至少 3 个不同的 primary seeds。",
    );
  }

  if (baselineModelId === null && baselineSeeds.length > 0) {
    add(
      "error",
      "BASELINE_SEEDS_WITHOUT_MODEL",
      "$.experimentProtocol.baselineSeeds",
      "未选择基线模型时不能提供基线随机种子。",
      [],
      "清空 baselineSeeds，或明确 baselineModelId。",
    );
  }
  if (baselineModelId !== null) {
    if (baselineSeeds.length === 0) {
      add(
        "error",
        "BASELINE_SEED_REQUIRED",
        "$.experimentProtocol.baselineSeeds",
        "选择基线模型后至少需要一个基线随机种子。",
        [],
        "提供一个 baseline seed。",
      );
    }
    if (baselineModelId === primaryModelId) {
      add(
        "error",
        "BASELINE_EQUALS_PRIMARY",
        "$.experimentProtocol.baselineModelId",
        "基线模型不能与主模型相同；同模型复验应使用 stability 协议。",
        evidenceRefs,
        "更换基线，或移除基线并使用多个 primary seeds。",
      );
    }
    const baselineCatalog = input.models.find(
      (candidate) => candidate.id.toLowerCase() === baselineModelId,
    );
    const baselineCard = registry.get(baselineModelId);
    if (!baselineCatalog || !baselineCard) {
      add(
        "error",
        "BASELINE_NOT_AUDITED",
        "$.experimentProtocol.baselineModelId",
        `基线模型 '${baselineModelId}' 不在已审计模型目录中。`,
        [],
        "选择已审计且可执行的模型。",
      );
    } else {
      if (baselineCatalog.runnable !== true || !baselineCard.planner.eligible) {
        add(
          "error",
          "BASELINE_NOT_RUNNABLE",
          "$.experimentProtocol.baselineModelId",
          `基线模型 '${baselineModelId}' 当前不可由 Planner 执行。`,
          [`MODEL_CARD:${baselineModelId}`],
          "选择可执行的基线模型。",
        );
      }
      if (!SHARED_BOW_BASELINE_MODELS.has(baselineModelId)) {
        add(
          "error",
          "BASELINE_WORKSPACE_INCOMPATIBLE",
          "$.experimentProtocol.baselineModelId",
          `V1 比较协议暂只允许共享 BOW 工作区的基线：${[...SHARED_BOW_BASELINE_MODELS].join(", ")}。`,
          [`MODEL_CARD:${baselineModelId}`],
          "使用兼容的 BOW 基线，或拆分为新的独立计划。",
        );
      }
      if (baselineCard.catalog.requires.includes("time") && !stringValue(input.plan.timeColumn)) {
        add(
          "error",
          "BASELINE_TIME_COLUMN_REQUIRED",
          "$.timeColumn",
          `基线模型 '${baselineModelId}' 需要时间列。`,
          [`MODEL_CARD:${baselineModelId}`],
          "绑定时间列或更换基线。",
        );
      }
      if (
        baselineCard.catalog.requires.includes("covariates") &&
        stringArray(input.plan.covariateColumns).length === 0
      ) {
        add(
          "error",
          "BASELINE_COVARIATE_REQUIRED",
          "$.covariateColumns",
          `基线模型 '${baselineModelId}' 需要协变量列。`,
          [`MODEL_CARD:${baselineModelId}`],
          "显式绑定训练协变量列或更换基线。",
        );
      }
    }
  }

  normalized.experimentProtocol = {
    mode: mode ?? "quick",
    primarySeeds,
    baselineModelId,
    baselineSeeds,
    rationale: rationale ?? "",
    evidenceRefs,
    confidence: confidence ?? "low",
  };
};

const validateSeedSet = (
  seeds: number[],
  field: "primarySeeds" | "baselineSeeds",
  minimumCount: number,
  maximumCount: number,
  add: ReturnType<typeof findingWriter>,
): void => {
  if (seeds.length < minimumCount || seeds.length > maximumCount) {
    add(
      "error",
      "EXPERIMENT_SEED_COUNT_INVALID",
      `$.experimentProtocol.${field}`,
      `${field} 数量必须在 ${minimumCount} 到 ${maximumCount} 之间。`,
      [],
      "调整随机种子数量。",
    );
  }
  if (new Set(seeds).size !== seeds.length) {
    add(
      "error",
      "EXPERIMENT_SEEDS_NOT_UNIQUE",
      `$.experimentProtocol.${field}`,
      `${field} 不能包含重复值。`,
      [],
      "删除重复随机种子。",
    );
  }
  if (seeds.some((seed) => seed < 0 || seed > 2_147_483_647)) {
    add(
      "error",
      "EXPERIMENT_SEED_OUT_OF_RANGE",
      `$.experimentProtocol.${field}`,
      `${field} 必须是 0 到 2147483647 之间的整数。`,
      [],
      "提供有效的非负整数种子。",
    );
  }
};

export const validateCanonicalTrainingPlanV2 = (
  planRecord: Record<string, unknown>,
  models: readonly CapabilityCatalogModel[],
): TrainingPlanValidationV2 => {
  const canonical = record(planRecord.canonicalPlan);
  const columns = record(canonical.columns);
  const resources = record(canonical.resources);
  const review = record(planRecord.review);
  return validateTrainingPlanV2({
    plan: flatPlanFromCanonical(canonical),
    models,
    dataProfile: {
      rowCount: review.datasetRowCount,
      columns: [
        ...stringArray(columns.textColumns),
        ...stringArray(columns.covariateColumns),
        ...stringArray(columns.metadataColumns),
        ...[columns.timeColumn, columns.idColumn].filter(
          (value): value is string => typeof value === "string",
        ),
      ],
    },
    offlineOnly: resources.networkAllowed === false,
    device:
      resources.device === "cpu" || resources.device === "gpu"
        ? resources.device
        : "unknown",
  });
};

const validateMode = (
  plan: Record<string, unknown>,
  model: CapabilityCatalogModel,
  modelId: string,
  normalized: Record<string, unknown>,
  add: ReturnType<typeof findingWriter>,
): void => {
  const mode = stringValue(plan.mode) ?? "unsupervised";
  const supported =
    modelId === "theta"
      ? stringArray(record(model.params.mode).choices)
      : ["unsupervised"];
  if (!supported.includes(mode)) {
    add(
      "error",
      "MODE_NOT_SUPPORTED",
      "$.mode",
      `模型 '${modelId}' 不支持模式 '${mode}'。允许值：${supported.join(", ")}。`,
      [`MODEL_CARD:${modelId}`],
      `将 mode 改为 ${supported.join(" 或 ")}。`,
    );
    return;
  }
  normalized.mode = mode;
};

const validateColumns = (
  input: ValidateTrainingPlanV2Input,
  card: ModelCapabilityCard,
  normalized: Record<string, unknown>,
  add: ReturnType<typeof findingWriter>,
): void => {
  const profileColumns = new Set(stringArray(input.dataProfile?.columns));
  const textColumn = stringValue(input.plan.textColumn);
  if (!textColumn) {
    add(
      "error",
      "TEXT_COLUMN_REQUIRED",
      "$.textColumn",
      "训练计划必须绑定文本列。",
      [`MODEL_CARD:${card.modelId}`],
      "选择数据集中承载正文的列。",
    );
  } else {
    normalized.textColumn = textColumn;
    validateColumnExists(textColumn, "$.textColumn", profileColumns, add);
  }

  const timeColumn = stringValue(input.plan.timeColumn);
  if (card.catalog.requires.includes("time") && !timeColumn) {
    add(
      "error",
      "TIME_COLUMN_REQUIRED",
      "$.timeColumn",
      `${card.displayName} 要求有效时间列。`,
      [`MODEL_CARD:${card.modelId}`],
      "绑定时间列，或选择非动态模型。",
    );
  }
  normalized.timeColumn = timeColumn ?? null;
  if (timeColumn) {
    validateColumnExists(timeColumn, "$.timeColumn", profileColumns, add);
  }

  const idColumn = stringValue(input.plan.idColumn);
  normalized.idColumn = idColumn ?? null;
  if (idColumn) {
    validateColumnExists(idColumn, "$.idColumn", profileColumns, add);
  }

  const covariateColumns = stringArray(input.plan.covariateColumns);
  const metadataColumns = stringArray(input.plan.metadataColumns);
  const groupingColumns = stringArray(input.plan.groupingColumns);
  const evaluationLabelColumns = stringArray(input.plan.evaluationLabelColumns);
  if (card.catalog.requires.includes("covariates") && covariateColumns.length === 0) {
    add(
      "error",
      "COVARIATE_COLUMN_REQUIRED",
      "$.covariateColumns",
      `${card.displayName} 要求至少一个协变量列。`,
      [`MODEL_CARD:${card.modelId}`],
      "显式绑定训练协变量列，或选择不依赖协变量的模型。展示分组不能代替训练协变量。",
    );
  }
  if (card.catalog.requires.includes("covariates") && metadataColumns.length > 0 && covariateColumns.length === 0) {
    add(
      "error",
      "LEGACY_METADATA_NOT_COVARIATE",
      "$.metadataColumns",
      "描述元数据不会自动进入 STM 训练。",
      [`MODEL_CARD:${card.modelId}`],
      "把确实需要进入模型的列显式放入 covariateColumns。",
    );
  }
  for (const column of covariateColumns) {
    validateColumnExists(column, "$.covariateColumns", profileColumns, add);
  }
  for (const column of metadataColumns) {
    validateColumnExists(column, "$.metadataColumns", profileColumns, add);
  }
  for (const column of groupingColumns) {
    validateColumnExists(column, "$.groupingColumns", profileColumns, add);
  }
  for (const column of evaluationLabelColumns) {
    validateColumnExists(column, "$.evaluationLabelColumns", profileColumns, add);
  }
  normalized.covariateColumns = [...new Set(covariateColumns)];
  normalized.metadataColumns = [...new Set(metadataColumns)];
  normalized.groupingColumns = [...new Set(groupingColumns)];
  normalized.evaluationLabelColumns = [...new Set(evaluationLabelColumns)];
};

const validateTopicCount = (
  plan: Record<string, unknown>,
  card: ModelCapabilityCard,
  normalized: Record<string, unknown>,
  add: ReturnType<typeof findingWriter>,
): void => {
  const requestedMode =
    stringValue(plan.topicCountMode) ??
    (card.modelId === "hdp"
      ? "auto"
      : card.modelId === "bertopic" && plan.numTopics == null
        ? "auto"
        : "fixed");
  const allowed =
    card.modelId === "hdp"
      ? ["auto"]
      : card.modelId === "bertopic"
        ? ["auto", "target_reduction"]
        : ["fixed"];
  if (!allowed.includes(requestedMode)) {
    add(
      "error",
      "TOPIC_COUNT_MODE_NOT_SUPPORTED",
      "$.topicCountMode",
      `${card.displayName} 不支持主题数模式 '${requestedMode}'。允许值：${allowed.join(", ")}。`,
      [`MODEL_CARD:${card.modelId}`],
      `使用 ${allowed.join(" 或 ")}。`,
    );
    return;
  }
  normalized.topicCountMode = requestedMode;

  if (requestedMode === "fixed" || requestedMode === "target_reduction") {
    const numTopics = integerValue(plan.numTopics);
    if (numTopics === undefined || numTopics < 2 || numTopics > 200) {
      add(
        "error",
        "NUM_TOPICS_OUT_OF_RANGE",
        "$.numTopics",
        "固定或目标缩减模式要求 2 到 200 之间的整数 numTopics。",
        [`MODEL_CARD:${card.modelId}`],
        "提供有效的 numTopics。",
      );
    } else {
      normalized.numTopics = numTopics;
    }
    normalized.maxTopics = null;
    return;
  }

  normalized.numTopics = null;
  if (card.modelId === "hdp") {
    const maxTopics = integerValue(plan.maxTopics) ?? 150;
    if (maxTopics < 2 || maxTopics > 1000) {
      add(
        "error",
        "MAX_TOPICS_OUT_OF_RANGE",
        "$.maxTopics",
        "HDP 的 maxTopics 必须是 2 到 1000 之间的整数。",
        [`MODEL_CARD:${card.modelId}`],
        "提供有效的 maxTopics。",
      );
    } else {
      normalized.maxTopics = maxTopics;
    }
  } else {
    normalized.maxTopics = null;
  }
};

const validateParameters = (
  plan: Record<string, unknown>,
  registry: CapabilityRegistry,
  card: ModelCapabilityCard,
  normalized: Record<string, unknown>,
  add: ReturnType<typeof findingWriter>,
): void => {
  const allPlanFields = new Set(
    registry.cards.flatMap((candidate) =>
      candidate.parameters.flatMap((parameter) =>
        parameter.planField ? [parameter.planField] : [],
      ),
    ),
  );
  const allowedParameters = new Map(
    card.parameters.flatMap((parameter) =>
      parameter.planField ? [[parameter.planField, parameter] as const] : [],
    ),
  );
  const nestedParameters = record(plan.parameters);
  const supplied = { ...nestedParameters, ...plan };

  for (const key of Object.keys(plan)) {
    if (STRUCTURAL_FIELDS.has(key) || allPlanFields.has(key)) continue;
    add(
      "error",
      "UNKNOWN_PLAN_FIELD",
      `$.${key}`,
      `计划字段 '${key}' 不属于 Validator V2 契约。`,
      [`MODEL_CARD:${card.modelId}`],
      "删除该字段或先将它加入 Capability Card。",
    );
  }
  for (const key of Object.keys(nestedParameters)) {
    if (allPlanFields.has(key)) continue;
    add(
      "error",
      "UNKNOWN_PARAMETER",
      `$.parameters.${key}`,
      `参数 '${key}' 不属于任何已审计模型参数。`,
      [`MODEL_CARD:${card.modelId}`],
      "删除该参数或补充能力审计。",
    );
  }
  for (const [key, parameter] of allowedParameters) {
    if (["numTopics", "maxTopics", "mode"].includes(key)) continue;
    const value =
      supplied[key] === undefined ? parameter.defaultValue : supplied[key];
    if (!validateParameterValue(value, parameter)) {
      add(
        "error",
        "PARAMETER_VALUE_INVALID",
        `$.${key}`,
        `参数 '${key}' 的值 ${JSON.stringify(value)} 不符合 ${parameter.valueType}、范围或 choices 约束。`,
        [`MODEL_CARD:${card.modelId}`, `PARAMETER:${card.modelId}.${parameter.parameterId}`],
        parameter.notes,
      );
      continue;
    }
    normalized[key] = value;
  }
  for (const key of allPlanFields) {
    if (
      supplied[key] !== undefined &&
      !allowedParameters.has(key) &&
      !["numTopics", "maxTopics", "mode"].includes(key)
    ) {
      add(
        "error",
        "PARAMETER_NOT_SUPPORTED",
        `$.${key}`,
        `参数 '${key}' 不适用于模型 '${card.modelId}'。`,
        [`MODEL_CARD:${card.modelId}`],
        "删除该参数或选择支持它的模型。",
      );
    }
  }
};

const validateRuntimePolicy = (
  input: ValidateTrainingPlanV2Input,
  card: ModelCapabilityCard,
  add: ReturnType<typeof findingWriter>,
): void => {
  if (
    input.offlineOnly &&
    card.capabilities.offlineExecution === "unsupported"
  ) {
    add(
      "error",
      "OFFLINE_EXECUTION_NOT_SUPPORTED",
      "$.resources.networkAllowed",
      `${card.displayName} 不支持离线执行。`,
      [`MODEL_CARD:${card.modelId}`],
      "允许网络访问或选择完全离线模型。",
    );
  }
  if (
    input.offlineOnly &&
    card.capabilities.offlineExecution === "conditional"
  ) {
    add(
      "blocking_warning",
      "OFFLINE_ASSET_AVAILABILITY_REQUIRED",
      "$.resources.networkAllowed",
      `${card.displayName} 只有在嵌入模型和权重已缓存时才能离线执行，Dry Run 必须验证本地资产。`,
      [`MODEL_CARD:${card.modelId}`],
      "配置本地模型路径并在 Dry Run 中确认，或允许网络访问。",
    );
  }
  if (
    input.device === "cpu" &&
    card.capabilities.cpuExecution === "unsupported"
  ) {
    add(
      "error",
      "CPU_EXECUTION_NOT_SUPPORTED",
      "$.resources.device",
      `${card.displayName} 不支持 CPU 执行。`,
      [`MODEL_CARD:${card.modelId}`],
      "改用 GPU 或其他模型。",
    );
  }
  if (
    input.device === "cpu" &&
    card.capabilities.cpuExecution === "conditional"
  ) {
    add(
      "warning",
      "CPU_EXECUTION_MAY_BE_SLOW",
      "$.resources.device",
      `${card.displayName} 可以尝试 CPU，但运行时间或内存压力可能较高。`,
      [`MODEL_CARD:${card.modelId}`],
      "在 Dry Run 中检查资源，优先使用较小模型或 GPU。",
    );
  }
};

const validateProfileRisks = (
  profile: Record<string, unknown> | undefined,
  add: ReturnType<typeof findingWriter>,
): void => {
  const rowCount = integerValue(profile?.rowCount);
  if (rowCount !== undefined && rowCount < 20) {
    add(
      "blocking_warning",
      "VERY_SMALL_CORPUS",
      "$.dataProfile.rowCount",
      `数据集只有 ${rowCount} 行，主题结构可能极不稳定。`,
      [],
      "增加样本，或将结果明确限定为探索性分析。",
    );
  }
};

const validateColumnExists = (
  column: string,
  jsonPath: string,
  profileColumns: Set<string>,
  add: ReturnType<typeof findingWriter>,
): void => {
  if (profileColumns.size > 0 && !profileColumns.has(column)) {
    add(
      "error",
      "COLUMN_NOT_IN_DATASET",
      jsonPath,
      `列 '${column}' 不存在于当前 Dataset Profile。`,
      [],
      "重新确认列绑定。",
    );
  }
};

const validateParameterValue = (
  value: unknown,
  parameter: CapabilityParameter,
): boolean => {
  if (value === null) return parameter.defaultValue === null;
  if (
    parameter.valueType === "integer" &&
    !(typeof value === "number" && Number.isInteger(value))
  ) {
    return false;
  }
  if (
    parameter.valueType === "number" &&
    !(typeof value === "number" && Number.isFinite(value))
  ) {
    return false;
  }
  if (parameter.valueType === "string" && typeof value !== "string") return false;
  if (parameter.valueType === "boolean" && typeof value !== "boolean") return false;
  if (
    typeof value === "number" &&
    parameter.minimum != null &&
    value < parameter.minimum
  ) {
    return false;
  }
  if (
    typeof value === "number" &&
    parameter.maximum != null &&
    value > parameter.maximum
  ) {
    return false;
  }
  return (
    parameter.choices.length === 0 ||
    parameter.choices.some((choice) => Object.is(choice, value))
  );
};

const validationResult = (
  findings: ValidatorFinding[],
  normalizedPlan: Record<string, unknown>,
): TrainingPlanValidationV2 => {
  const errors = findings
    .filter((finding) => finding.level === "error")
    .map((finding) => `${finding.code}: ${finding.message}`);
  const blockingWarnings = findings
    .filter((finding) => finding.level === "blocking_warning")
    .map((finding) => `${finding.code}: ${finding.message}`);
  const warnings = findings
    .filter((finding) =>
      ["blocking_warning", "warning", "informational"].includes(finding.level),
    )
    .map((finding) => `${finding.code}: ${finding.message}`);
  return {
    validatorVersion: PLAN_VALIDATOR_VERSION,
    valid: errors.length === 0,
    errors,
    blockingWarnings,
    warnings,
    findings,
    normalizedPlan,
    catalogSource: "theta-model-catalog",
  };
};

const findingWriter = (findings: ValidatorFinding[]) => {
  let sequence = 0;
  return (
    level: ValidatorFindingLevel,
    code: string,
    jsonPath: string,
    message: string,
    evidenceRefs: string[],
    suggestedFix: string,
    autoFixAllowed = false,
  ): void => {
    sequence += 1;
    findings.push({
      findingId: `VAL-${String(sequence).padStart(4, "0")}`,
      level,
      code,
      jsonPath,
      message,
      evidenceRefs,
      suggestedFix,
      autoFixAllowed,
    });
  };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const stringArray = (value: unknown): string[] =>
  array(value).filter((item): item is string => typeof item === "string");
const integerArray = (value: unknown): number[] =>
  array(value).filter(
    (item): item is number => typeof item === "number" && Number.isInteger(item),
  );
const integerValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;
