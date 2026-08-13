import type {
  DatasetConfirmationDraft,
  DatasetFacts,
  DatasetUnderstandingDraft,
} from '@theta-agent/domain/dataset-understanding/contracts.js';

export interface DatasetUnderstandingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const validateDatasetUnderstanding = (
  draft: DatasetUnderstandingDraft,
  facts: DatasetFacts,
): DatasetUnderstandingValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (draft.datasetRef !== facts.datasetRef || draft.datasetHash !== facts.datasetHash) {
    errors.push('数据理解与当前数据集版本不一致。');
  }
  const available = new Set(facts.columns.map((column) => column.name));
  const roleEntries = [
    ...draft.textColumns,
    ...draft.timeColumns,
    ...draft.idColumns,
    ...draft.metadataColumns,
    ...draft.groupColumns,
    ...draft.covariateColumns,
    ...draft.evaluationColumns,
    ...draft.ignoredColumns,
  ];
  const unknown = roleEntries
    .map((entry) => entry.column)
    .filter((column) => !available.has(column));
  if (unknown.length > 0) {
    errors.push(`数据理解引用了不存在的列：${unique(unknown).join('、')}。`);
  }
  for (const reference of draft.evidenceReferences) {
    if (reference.column && !available.has(reference.column)) {
      errors.push(`证据引用了不存在的列：${reference.column}。`);
    }
    if (
      reference.kind === 'sample_row' &&
      (reference.sampleIndex === undefined ||
        reference.sampleIndex >= facts.samplePolicy.returnedRows)
    ) {
      errors.push(`样本证据索引超出受控样本范围：${String(reference.sampleIndex)}。`);
    }
  }
  validateTimeColumns(
    draft.timeColumns.map((entry) => entry.column),
    facts,
    errors,
  );
  validateTextColumns(
    draft.textColumns.map((entry) => entry.column),
    facts,
    errors,
  );
  if (draft.textColumns.length === 0) {
    warnings.push('尚未确定正文列，需要用户确认后才能生成训练方案。');
  }
  validateExclusiveRoles({
    text: draft.textColumns.map((entry) => entry.column),
    time: draft.timeColumns.map((entry) => entry.column),
    id: draft.idColumns.map((entry) => entry.column),
    evaluation: draft.evaluationColumns.map((entry) => entry.column),
    ignored: draft.ignoredColumns.map((entry) => entry.column),
  }, errors);
  return { valid: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
};

export const validateDatasetConfirmation = (
  confirmation: DatasetConfirmationDraft,
  facts: DatasetFacts,
): DatasetUnderstandingValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const roles = {
    text: confirmation.textColumns,
    time: confirmation.timeColumns,
    id: confirmation.idColumns,
    metadata: confirmation.metadataColumns,
    group: confirmation.groupColumns ?? [],
    covariate: confirmation.covariateColumns ?? [],
    evaluation: confirmation.evaluationColumns ?? [],
    ignored: confirmation.ignoredColumns ?? [],
  };
  const available = new Set(facts.columns.map((column) => column.name));
  const unknown = Object.values(roles).flat().filter((column) => !available.has(column));
  if (unknown.length > 0) {
    errors.push(`数据确认引用了不存在的列：${unique(unknown).join('、')}。`);
  }
  validateTextColumns(roles.text, facts, errors);
  validateTimeColumns(roles.time, facts, errors);
  validateExclusiveRoles({
    text: roles.text,
    time: roles.time,
    id: roles.id,
    evaluation: roles.evaluation,
    ignored: roles.ignored,
  }, errors);
  const evaluationTrainingOverlap = roles.evaluation.filter((column) =>
    roles.text.includes(column) || roles.covariate.includes(column));
  if (evaluationTrainingOverlap.length > 0) {
    errors.push(
      `评价标签默认不能作为训练输入：${unique(evaluationTrainingOverlap).join('、')}。`,
    );
  }
  if (
    roles.group.length > 0 &&
    sameSet(roles.group, roles.covariate) &&
    confirmation.status !== 'corrected'
  ) {
    errors.push('分组展示列不能未经用户纠正就自动等同于训练协变量。');
  }
  if (facts.sensitiveDataRisk === 'requires_confirmation') {
    warnings.push('检测到潜在敏感数据，远程样本授权必须单独确认。');
  }
  return { valid: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
};

export const assertDatasetConfirmation = (
  confirmation: DatasetConfirmationDraft,
  facts: DatasetFacts,
): void => {
  const result = validateDatasetConfirmation(confirmation, facts);
  if (!result.valid) {
    throw new Error(result.errors.join(' '));
  }
};

const validateTextColumns = (
  columns: string[],
  facts: DatasetFacts,
  errors: string[],
): void => {
  const byName = new Map(facts.columns.map((column) => [column.name, column]));
  for (const name of columns) {
    const column = byName.get(name);
    if (!column) continue;
    const highUniqueShortValue = column.uniqueRatio >= 0.95 && column.averageLength <= 20;
    if (column.inferredType === 'number' || highUniqueShortValue) {
      errors.push(`列 ${name} 更像标识符或短数值，不能未经纠正直接作为正文列。`);
    }
  }
};

const validateTimeColumns = (
  columns: string[],
  facts: DatasetFacts,
  errors: string[],
): void => {
  const byName = new Map(facts.columns.map((column) => [column.name, column]));
  for (const name of columns) {
    const column = byName.get(name);
    if (!column) continue;
    if (column.inferredType !== 'datetime' && column.parseSuccessRatio < 0.6) {
      errors.push(`列 ${name} 的日期解析成功率不足，不能作为时间列。`);
    }
  }
};

const validateExclusiveRoles = (
  roles: Record<string, string[]>,
  errors: string[],
): void => {
  const owners = new Map<string, string[]>();
  for (const [role, columns] of Object.entries(roles)) {
    for (const column of columns) {
      owners.set(column, [...(owners.get(column) ?? []), role]);
    }
  }
  for (const [column, assigned] of owners) {
    if (assigned.length > 1) {
      errors.push(`列 ${column} 同时被分配到互斥角色：${assigned.join('、')}。`);
    }
  }
};

const sameSet = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

const unique = <T>(values: T[]): T[] => [...new Set(values)];
