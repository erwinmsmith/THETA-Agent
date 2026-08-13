import {
  plannerDecisionV2Schema,
  plannerInputV2Hash,
  plannerInputV2Schema,
  plannerValidationResultV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
  type PlannerValidationResultV2,
} from './v2-contracts.js';

export const validatePlannerDecisionV2 = (
  rawInput: PlannerInputV2,
  rawDecision: PlannerDecisionV2,
): PlannerValidationResultV2 => {
  const input = plannerInputV2Schema.parse(rawInput);
  const decision = plannerDecisionV2Schema.parse(rawDecision);
  const errors: string[] = [];
  const warnings: string[] = [...decision.warnings];
  if (decision.inputHash !== plannerInputV2Hash(input)) {
    errors.push('计划使用的输入快照已经变化，必须重新生成并重新审批。');
  }
  if (input.facts.datasetHash !== input.confirmation.datasetHash) {
    errors.push('数据事实与用户确认指向不同的数据版本。');
  }
  const columnNames = new Set(input.facts.columns.map((item) => item.name));
  for (const column of input.confirmation.textColumns) {
    if (!columnNames.has(column)) errors.push(`正文列不存在：${column}`);
  }
  for (const column of input.confirmation.timeColumns) {
    if (!columnNames.has(column)) errors.push(`时间列不存在：${column}`);
  }
  const candidate = input.candidates.find((item) => item.modelId === decision.modelId);
  if (!candidate) errors.push(`模型不在当前候选目录中：${decision.modelId}`);
  else {
    if (!candidate.runnable) errors.push(`模型当前不可运行：${decision.modelId}`);
    if (input.intent.temporalPurpose === 'topic_evolution' && !candidate.capabilities.includes('temporal_topics')) {
      errors.push('研究要求模型直接学习主题演化，但所选模型不支持 temporal_topics。');
    }
    if (
      (input.confirmation.covariateColumns?.length ?? 0) > 0 &&
      !candidate.capabilities.includes('metadata_effects')
    ) {
      errors.push('已确认训练协变量，但所选模型不支持 metadata_effects。');
    }
    if (candidate.estimatedMemoryGb && input.hardware.memoryGb && candidate.estimatedMemoryGb > input.hardware.memoryGb) {
      errors.push(`模型预计需要 ${candidate.estimatedMemoryGb}GB 内存，超过可用 ${input.hardware.memoryGb}GB。`);
    }
    validateParameters(candidate, decision.parameters, errors);
  }
  if (decision.baselineModelId) {
    const baseline = input.candidates.find((item) => item.modelId === decision.baselineModelId);
    if (!baseline?.runnable) errors.push(`基线模型不在可运行候选中：${decision.baselineModelId}`);
    if (decision.experiment.mode !== 'comparative') {
      errors.push('设置基线模型时实验模式必须为 comparative。');
    }
    if (decision.baselineModelId === decision.modelId) {
      errors.push('基线模型不能与主模型相同；同模型复验应使用 stability。');
    }
  }
  if (decision.experiment.mode === 'comparative' && !decision.baselineModelId) {
    errors.push('comparative 实验必须指定基线模型。');
  }
  if (decision.experiment.mode === 'stability' && decision.experiment.primarySeeds.length < 3) {
    errors.push('stability 实验至少需要三个随机种子。');
  }
  if (
    decision.experiment.primarySeeds.length + decision.experiment.baselineSeeds.length >
    input.intent.resourceBudget.maxExperiments
  ) {
    errors.push(`实验次数超过用户预算上限 ${input.intent.resourceBudget.maxExperiments}。`);
  }
  if (new Set(decision.experiment.primarySeeds).size !== decision.experiment.primarySeeds.length) {
    errors.push('主模型随机种子必须互不重复。');
  }
  if (new Set(decision.experiment.baselineSeeds).size !== decision.experiment.baselineSeeds.length) {
    errors.push('基线随机种子必须互不重复。');
  }
  if (!decision.baselineModelId && decision.experiment.baselineSeeds.length > 0) {
    errors.push('未指定基线模型时不能设置基线随机种子。');
  }
  validateUserOverrides(input, decision, errors);
  const allowedEvidence = new Set(input.evidenceRefs);
  for (const evidenceId of decision.evidenceRefs) {
    if (!allowedEvidence.has(evidenceId)) errors.push(`Planner 引用了检索包之外的证据：${evidenceId}`);
  }
  if (input.intent.temporalAnalysis && input.confirmation.timeColumns.length === 0) {
    errors.push('研究要求时间趋势，但没有确认可用的时间列。');
  }
  if (input.facts.rowCount < 100) warnings.push('样本量较小，结果应作为探索性结论并进行人工复核。');
  return plannerValidationResultV2Schema.parse({ valid: errors.length === 0, errors, warnings: [...new Set(warnings)] });
};

const validateParameters = (
  candidate: PlannerInputV2['candidates'][number],
  parameters: PlannerDecisionV2['parameters'],
  errors: string[],
): void => {
  const constraints = new Map(
    candidate.parameterConstraints.map((constraint) => [constraint.parameterId, constraint] as const),
  );
  const known = new Set([
    ...Object.keys(candidate.parameterDefaults),
    ...constraints.keys(),
    'mode', 'topicCountMode', 'numTopics', 'maxTopics',
  ]);
  for (const [parameterId, value] of Object.entries(parameters)) {
    if (!known.has(parameterId)) {
      errors.push(`模型 ${candidate.modelId} 不支持参数：${parameterId}`);
      continue;
    }
    const constraint = constraints.get(parameterId);
    if (!constraint || value === null) continue;
    if (
      constraint.choices.length > 0 &&
      !constraint.choices.some((choice) => choice === value)
    ) {
      errors.push(`参数 ${parameterId}=${String(value)} 不在允许选项中。`);
    }
    if (typeof value === 'number') {
      if (constraint.minimum !== null && constraint.minimum !== undefined && value < constraint.minimum) {
        errors.push(`参数 ${parameterId} 不能小于 ${constraint.minimum}。`);
      }
      if (constraint.maximum !== null && constraint.maximum !== undefined && value > constraint.maximum) {
        errors.push(`参数 ${parameterId} 不能大于 ${constraint.maximum}。`);
      }
    }
  }
};

const validateUserOverrides = (
  input: PlannerInputV2,
  decision: PlannerDecisionV2,
  errors: string[],
): void => {
  for (const [field, expected] of Object.entries(input.userOverrides)) {
    const actual = field === 'modelId'
      ? decision.modelId
      : field === 'baselineModelId'
        ? decision.baselineModelId
        : decision.parameters[field];
    if (actual !== expected) {
      errors.push(`Planner 未严格采用用户覆盖值：${field} 应为 ${String(expected)}，实际为 ${String(actual)}。`);
    }
  }
};
