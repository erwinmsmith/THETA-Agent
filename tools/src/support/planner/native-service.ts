import type { InferenceProvider, PromptMessage } from '@codesoul-co/hypha-inference';
import { THETA_AGENT_MISSION_PROMPT } from '../language/agent-identity.js';
import { z } from 'zod';
import type { EvidenceBundle } from '../rag/evidence-bundle.js';
import {
  executeSelectEvidence,
  EvidenceSelectionError,
  selectEvidenceToolDescriptor,
  type EvidenceSelectionTarget,
} from './select-evidence-tool.js';
import {
  plannerDecisionV2Schema,
  plannerInputV2Hash,
  plannerInputV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
} from '@theta-agent/domain/planner/v2-contracts.js';
import { validatePlannerDecisionV2 } from './v2-validator.js';

const decisionDraftSchema = plannerDecisionV2Schema.omit({
  schemaVersion: true,
  inputHash: true,
  evidenceRefs: true,
  evidenceSelectionReceipts: true,
});

export class NativePlannerV2Service {
  constructor(private readonly provider: InferenceProvider) {}

  async propose(inputValue: PlannerInputV2, bundle: EvidenceBundle): Promise<PlannerDecisionV2> {
    const input = plannerInputV2Schema.parse(inputValue);
    let validationErrors: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.provider.infer({
          runId: `theta-planner-v2-${plannerInputV2Hash(input).slice(0, 16)}`,
          stepId: attempt === 0 ? 'create-native-plan' : `repair-native-plan-${attempt}`,
          modelAlias: providerModel(this.provider),
          input: { messages: plannerMessages(input, bundle, validationErrors) },
          options: {
            temperature: attempt === 0 ? 0.1 : 0,
            maxTokens: 1800,
            extra: { toolChoice: 'none', jsonObject: true },
          },
          trace: true,
          metadata: { purpose: 'native_planner_v2', inputHash: plannerInputV2Hash(input) },
        });
        const draft = decisionDraftSchema.parse(normalizePlannerDraft(response.output));
        const selectedCandidate = input.candidates.find(
          (candidate) => candidate.modelId === draft.modelId,
        );
        const parameters = {
          ...(selectedCandidate?.parameterDefaults ?? {}),
          ...draft.parameters,
          ...Object.fromEntries(
            Object.entries(input.userOverrides).filter(
              ([field]) => field !== 'modelId' && field !== 'baselineModelId',
            ),
          ),
        };
        const withoutEvidence = plannerDecisionV2Schema.parse({
          ...draft,
          parameters,
          schemaVersion: '2.0.0',
          inputHash: plannerInputV2Hash(input),
          evidenceRefs: [],
        });
        const validation = validatePlannerDecisionV2(input, withoutEvidence);
        if (!validation.valid) {
          validationErrors = validation.errors;
          continue;
        }
        const selection = await this.selectEvidence(input, bundle, withoutEvidence);
        const decision = plannerDecisionV2Schema.parse({
          ...withoutEvidence,
          evidenceRefs: selection.evidenceRefs,
          evidenceSelectionReceipts: selection.receipts,
        });
        const finalValidation = validatePlannerDecisionV2(input, decision);
        if (!finalValidation.valid) {
          validationErrors = finalValidation.errors;
          continue;
        }
        return decision;
      } catch (error) {
        validationErrors = error instanceof z.ZodError
          ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          : [error instanceof Error ? error.message : String(error)];
      }
    }
    throw new Error(`Provider Planner V2 failed validation: ${validationErrors.join('; ')}`);
  }

  private async selectEvidence(
    input: PlannerInputV2,
    bundle: EvidenceBundle,
    decision: PlannerDecisionV2,
  ): Promise<{
    evidenceRefs: string[];
    receipts: NonNullable<PlannerDecisionV2['evidenceSelectionReceipts']>;
  }> {
    if (bundle.evidence.length === 0) return { evidenceRefs: [], receipts: [] };
    const aliases = new Map(
      bundle.evidence.map((evidence, index) => [`E${index + 1}`, evidence.evidenceId]),
    );
    const targets: EvidenceSelectionTarget[] = [
      { targetId: 'primary-model', claim: decision.rationale, provisionalAliases: [], kind: 'model', modelId: decision.modelId },
      { targetId: 'parameters', claim: JSON.stringify(decision.parameters), provisionalAliases: [], kind: 'parameter', modelId: decision.modelId },
      { targetId: 'evaluation', claim: decision.evaluation.join('；'), provisionalAliases: [], kind: 'evaluation', modelId: decision.modelId },
      { targetId: 'experiment', claim: decision.experiment.rationale, provisionalAliases: [], kind: 'experiment_protocol', modelId: decision.modelId },
    ];
    const evidenceSummary = bundle.evidence.map((evidence, index) => ({
      alias: `E${index + 1}`,
      title: evidence.title,
      modelIds: evidence.modelIds,
      parameterIds: evidence.parameterIds,
      excerpt: evidence.excerpt,
    }));
    let priorError = '';
    const receipts: NonNullable<PlannerDecisionV2['evidenceSelectionReceipts']> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.provider.infer({
          runId: `theta-planner-v2-${plannerInputV2Hash(input).slice(0, 16)}`,
          stepId: attempt === 0 ? 'select-evidence' : 'select-evidence-repair',
          modelAlias: providerModel(this.provider),
          input: { messages: evidenceMessages(decision, evidenceSummary, targets, priorError) },
          tools: [selectEvidenceToolDescriptor(aliases, targets)],
          options: { temperature: 0, maxTokens: 1200, extra: { toolChoice: 'auto' } },
          trace: true,
          metadata: { purpose: 'native_planner_v2_select_evidence', bundleHash: bundle.bundleHash },
        });
        const selections = executeSelectEvidence(response.output, aliases, targets);
        const primary = selections.find((item) => item.targetId === 'primary-model');
        if (!primary || primary.evidenceIds.length === 0) {
          throw new Error('select_evidence must ground the primary model when the Evidence Bundle is non-empty.');
        }
        receipts.push({
          attempt: attempt + 1,
          outcome: 'accepted',
          errorCode: null,
          targetId: null,
          evidenceId: null,
          message: `select_evidence accepted ${selections.length} decision targets.`,
        });
        return {
          evidenceRefs: unique(selections.flatMap((item) => item.evidenceIds)),
          receipts,
        };
      } catch (error) {
        priorError = error instanceof Error ? error.message : String(error);
        receipts.push({
          attempt: attempt + 1,
          outcome: 'rejected',
          errorCode: error instanceof EvidenceSelectionError ? error.receiptCode : 'EVIDENCE_INSUFFICIENT_SUPPORT',
          targetId: error instanceof EvidenceSelectionError ? error.targetId : null,
          evidenceId: error instanceof EvidenceSelectionError ? error.evidenceId : null,
          message: priorError,
        });
      }
    }
    throw new Error(`select_evidence failed: ${priorError}`);
  }
}

const plannerMessages = (
  input: PlannerInputV2,
  bundle: EvidenceBundle,
  errors: string[],
): PromptMessage[] => [{
  role: 'system',
  content: [
    THETA_AGENT_MISSION_PROMPT,
    'You are the native THETA Planner V2. Create a complete executable topic-modeling and analysis plan; do not choose from a pre-generated plan.',
    'Write the FINAL JSON answer in your response content body; never end your turn with only reasoning and an empty content field.',
    'Select only runnable candidates and obey parameterConstraints, confirmed columns, hardware, and user overrides.',
    'Treat comparisonPurpose=display as post-training grouping, never as a training covariate. Only comparisonPurpose=model may require metadata effects.',
    'Treat temporalPurpose=display_trend as post-training aggregation and charts; it does not require a temporal topic model. Only temporalPurpose=topic_evolution requires native temporal_topics.',
    'Return one JSON object matching: modelId, baselineModelId, rationale, parameters, experiment, preprocessing, evaluation, visualizations, warnings, assumptions.',
    'preprocessing, evaluation, visualizations, warnings, and assumptions MUST each be arrays of strings, never arrays of objects.',
    'experiment MUST be {"mode":"quick|comparative|stability","primarySeeds":[integer],"baselineSeeds":[integer],"rationale":"string"}. baselineModelId is a string or null.',
    'Exact shape example: {"modelId":"lda","baselineModelId":null,"rationale":"...","parameters":{"num_topics":10},"experiment":{"mode":"stability","primarySeeds":[17,42,73],"baselineSeeds":[],"rationale":"..."},"preprocessing":["tokenize text"],"evaluation":["topic coherence"],"visualizations":["topic keywords"],"warnings":[],"assumptions":[]}.',
    'parameters contains scalar model/training parameters only. Use userOverrides exactly.',
    'Use comparative mode only with a baseline; stability requires at least three primarySeeds.',
    errors.length ? `Repair these errors: ${errors.join(' | ')}` : '',
  ].filter(Boolean).join(' '),
}, {
  role: 'user',
  content: JSON.stringify({
    plannerInput: input,
    evidence: bundle.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      title: item.title,
      modelIds: item.modelIds,
      parameterIds: item.parameterIds,
      excerpt: item.excerpt,
    })),
  }),
}];

const evidenceMessages = (
  decision: PlannerDecisionV2,
  evidence: unknown[],
  targets: EvidenceSelectionTarget[],
  priorError: string,
): PromptMessage[] => [{
  role: 'system',
  content: [
    THETA_AGENT_MISSION_PROMPT,
    'You are binding evidence to a governed topic-modeling and analysis plan. Call select_evidence exactly once and bind every target using only supplied E aliases.',
    'Use an empty aliases array when evidence does not support a target.',
    priorError ? `Repair: ${priorError}` : '',
  ].filter(Boolean).join(' '),
}, {
  role: 'user',
  content: JSON.stringify({ decision, targets, evidence }),
}];

const unique = (values: string[]): string[] => [...new Set(values)];

const providerModel = (provider: InferenceProvider): string =>
  typeof (provider as InferenceProvider & { model?: unknown }).model === 'string'
    ? String((provider as InferenceProvider & { model: string }).model)
    : 'configured-planner-model';

const normalizePlannerDraft = (value: unknown): Record<string, unknown> => {
  const root = record(value);
  const experiment = record(root.experiment);
  const scalarParameters = Object.fromEntries(
    Object.entries(record(root.parameters)).filter(([, item]) =>
      item === null || ['string', 'number', 'boolean'].includes(typeof item),
    ),
  );
  const baseline = textValue(root.baselineModelId);
  const mode = experiment.mode === 'comparative' || experiment.mode === 'stability'
    ? experiment.mode
    : 'quick';
  return {
    modelId: textValue(root.modelId),
    baselineModelId: baseline || null,
    rationale: textValue(root.rationale, root.reason, root.explanation),
    parameters: scalarParameters,
    experiment: {
      mode,
      primarySeeds: integerArray(experiment.primarySeeds ?? experiment.seeds),
      baselineSeeds: integerArray(experiment.baselineSeeds),
      rationale: textValue(experiment.rationale, experiment.reason, root.rationale),
    },
    preprocessing: normalizedStringArray(root.preprocessing),
    evaluation: normalizedStringArray(root.evaluation),
    visualizations: normalizedStringArray(root.visualizations),
    warnings: normalizedStringArray(root.warnings),
    assumptions: normalizedStringArray(root.assumptions),
  };
};

const normalizedStringArray = (value: unknown): string[] => {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return source.flatMap((item) => {
    const text = typeof item === 'string'
      ? item.trim()
      : textValue(
          record(item).label,
          record(item).name,
          record(item).id,
          record(item).description,
          record(item).metric,
          record(item).type,
          record(item).reason,
        );
    return text ? [text] : [];
  });
};

const integerArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((item) => Number.isInteger(item) && item >= 0))]
    .slice(0, 5);
};

const textValue = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
