import type {
  PlannerDecisionV2,
  PlannerInputV2,
  PlannerValidationResultV2,
} from './v2-contracts.js';

type Scalar = string | number | boolean | null;

export interface PresentedPlanV2 {
  title: string;
  summary: string;
  researchGoal: string;
  model: string;
  primaryModel: { modelId: string; rationale: string };
  baselineModel: { modelId: string; rationale: string } | null;
  dataBasis: string[];
  keyParameters: Array<{
    field: string;
    value: Scalar;
    rationale: string;
    source: 'user_override' | 'planner_recommendation' | 'validated_default';
  }>;
  experiment: PlannerDecisionV2['experiment'];
  preprocessing: Array<{ choice: string; rationale: string }>;
  evaluation: string[];
  visualizations: string[];
  outputs: string[];
  cautions: string[];
  assumptions: string[];
  openQuestions: string[];
  evidenceRefs: string[];
  evidenceSelectionReceipts: NonNullable<PlannerDecisionV2['evidenceSelectionReceipts']>;
  plannerSource: 'minimax';
  approvalRequired: boolean;
}

export const presentPlanV2 = (
  input: PlannerInputV2,
  decision: PlannerDecisionV2,
  validation: PlannerValidationResultV2,
): PresentedPlanV2 => ({
  title: validation.valid ? 'MiniMax 研究方案已通过硬约束校验' : 'MiniMax 研究方案需要修正',
  summary: validation.valid
    ? `建议使用 ${decision.modelId} 完成“${input.intent.researchQuestion}”；批准前不会启动训练。`
    : `当前方案存在 ${validation.errors.length} 项阻塞问题。`,
  researchGoal: input.intent.researchQuestion,
  model: decision.modelId,
  primaryModel: { modelId: decision.modelId, rationale: decision.rationale },
  baselineModel: decision.baselineModelId
    ? { modelId: decision.baselineModelId, rationale: decision.experiment.rationale }
    : null,
  dataBasis: [
    `${input.facts.rowCount} 行、${input.facts.columns.length} 列`,
    `正文列：${input.confirmation.textColumns.join('、')}`,
    input.intent.temporalAnalysis
      ? `时间列：${input.confirmation.timeColumns.join('、') || '缺失'}`
      : '本轮不要求原生时间建模',
    input.confirmation.groupColumns?.length
      ? `展示分组：${input.confirmation.groupColumns.join('、')}`
      : '本轮没有展示分组',
  ],
  keyParameters: Object.entries(decision.parameters).map(([field, value]) => ({
    field,
    value,
    rationale: '该值由 MiniMax 在能力目录和 RAG 证据约束下提出。',
    source: Object.prototype.hasOwnProperty.call(input.userOverrides, field)
      ? 'user_override'
      : 'planner_recommendation',
  })),
  experiment: decision.experiment,
  preprocessing: decision.preprocessing.map((choice) => ({
    choice,
    rationale: '与当前数据事实和训练模型保持一致。',
  })),
  evaluation: decision.evaluation,
  visualizations: decision.visualizations,
  outputs: unique([...decision.evaluation, ...decision.visualizations]),
  cautions: unique([...validation.errors, ...validation.warnings, ...decision.warnings]),
  assumptions: decision.assumptions,
  openQuestions: [],
  evidenceRefs: decision.evidenceRefs,
  evidenceSelectionReceipts: decision.evidenceSelectionReceipts ?? [],
  plannerSource: 'minimax',
  approvalRequired: validation.valid,
});

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
