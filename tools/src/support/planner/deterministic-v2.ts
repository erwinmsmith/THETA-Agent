import {
  plannerDecisionV2Schema,
  plannerInputV2Hash,
  plannerInputV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
} from '@theta-agent/domain/planner/v2-contracts.js';
import type { EvidenceBundle } from '../rag/evidence-bundle.js';
import { validatePlannerDecisionV2 } from './v2-validator.js';

/**
 * Deterministic Planner V2 proposal: honors the documented offline contract
 * ("the deterministic agent works without an API key"). Selects the first
 * runnable capability-registry candidate with its audited defaults, keeps
 * RAG evidence references, and runs the same V2 validation as the provider
 * planner before returning.
 */
export const buildDeterministicPlannerDecisionV2 = (
  rawInput: PlannerInputV2,
  bundle: EvidenceBundle,
): PlannerDecisionV2 => {
  const input = plannerInputV2Schema.parse(rawInput);
  const primary = input.candidates.find((candidate) => candidate.runnable);
  if (!primary) {
    throw new Error('Deterministic planner requires at least one runnable candidate.');
  }
  const parameters = {
    ...primary.parameterDefaults,
    ...Object.fromEntries(
      Object.entries(input.userOverrides).filter(
        ([field]) => field !== 'modelId' && field !== 'baselineModelId',
      ),
    ),
  };
  const bundleIds = new Set(bundle.evidence.map((item) => item.evidenceId));
  const evidenceRefs = input.evidenceRefs
    .filter((evidenceId) => bundleIds.has(evidenceId))
    .slice(0, 10);
  const decision = plannerDecisionV2Schema.parse({
    schemaVersion: '2.0.0',
    inputHash: plannerInputV2Hash(input),
    modelId: primary.modelId,
    baselineModelId: null,
    rationale:
      `确定性规划：采用能力目录候选 ${primary.modelId} 的已审计默认参数，` +
      '并保留 RAG 证据引用与人工复核建议；不自动增加基线或随机种子成本。',
    parameters,
    evidenceRefs,
    experiment: {
      mode: 'quick',
      primarySeeds: [42],
      baselineSeeds: [],
      rationale: '确定性后备采用一次主模型快速运行。',
    },
    preprocessing: ['训练前检查空文本、重复、语言与词表/嵌入可用性。'],
    evaluation: ['联合比较主题连贯性、多样性、稳定性与人工可解释性。'],
    visualizations: ['主题关键词与代表文本', '文档—主题分布', '候选模型指标对比'],
    warnings:
      input.facts.rowCount < 100
        ? ['样本量较小，结果应作为探索性结论并进行人工复核。']
        : [],
    assumptions: ['数据画像和用户确认的列角色准确。'],
  });
  const validation = validatePlannerDecisionV2(input, decision);
  if (!validation.valid) {
    throw new Error(
      `Deterministic Planner V2 failed validation: ${validation.errors.join('; ')}`,
    );
  }
  return decision;
};
