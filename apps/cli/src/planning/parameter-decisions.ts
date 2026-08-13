import {
  parameterDecisionMapSchema,
  type ParameterDecision,
  type ParameterDecisionMap,
} from './contracts.js';

const trackedFields = [
  'modelId',
  'mode',
  'topicCountMode',
  'numTopics',
  'maxTopics',
  'batchSize',
  'epochs',
  'nNeighbors',
  'nComponents',
  'minClusterSize',
  'minSamples',
  'topNWords',
  'randomState',
  'covariateColumns',
] as const;

export interface BuildParameterDecisionsInput {
  recommendedPlan: Record<string, unknown>;
  effectivePlan: Record<string, unknown>;
  rationales?: Record<string, string>;
  source?: ParameterDecision['source'];
  changedAt?: string;
}

export const buildParameterDecisions = (
  input: BuildParameterDecisionsInput,
): ParameterDecisionMap => {
  const output: ParameterDecisionMap = {};
  for (const field of trackedFields) {
    const recommendedValue = decisionValue(
      input.recommendedPlan[field] ?? input.effectivePlan[field],
    );
    const effectiveValue = decisionValue(
      input.effectivePlan[field] ?? input.recommendedPlan[field],
    );
    if (recommendedValue === undefined || effectiveValue === undefined) continue;
    output[field] = {
      recommendedValue,
      effectiveValue,
      source: input.source ?? 'system_recommendation',
      ...(input.rationales?.[field]
        ? { rationale: input.rationales[field] }
        : {}),
      ...(input.changedAt ? { overriddenAt: input.changedAt } : {}),
    };
  }
  return parameterDecisionMapSchema.parse(output);
};

export const applyUserParameterOverrides = (
  current: unknown,
  adjustment: Record<string, unknown>,
  effectivePlan: Record<string, unknown>,
  changedAt: string,
): ParameterDecisionMap => {
  const output = parseDecisions(current);
  for (const field of trackedFields) {
    if (!(field in adjustment)) continue;
    const effectiveValue = decisionValue(effectivePlan[field]);
    if (effectiveValue === undefined) continue;
    const existing = output[field];
    output[field] = {
      recommendedValue:
        existing?.recommendedValue ?? effectiveValue,
      effectiveValue,
      source: 'user_override',
      ...(existing?.rationale ? { rationale: existing.rationale } : {}),
      overriddenAt: changedAt,
    };
  }
  return parameterDecisionMapSchema.parse(output);
};

export const applyValidatorParameterCorrections = (
  current: unknown,
  candidatePlan: Record<string, unknown>,
  normalizedPlan: Record<string, unknown>,
  changedAt: string,
): ParameterDecisionMap => {
  const output = parseDecisions(current);
  for (const field of trackedFields) {
    const normalizedValue = decisionValue(normalizedPlan[field]);
    if (normalizedValue === undefined) continue;
    const candidateValue = decisionValue(candidatePlan[field]);
    const existing = output[field];
    if (!sameValue(candidateValue, normalizedValue)) {
      output[field] = {
        recommendedValue:
          existing?.recommendedValue ?? candidateValue ?? normalizedValue,
        effectiveValue: normalizedValue,
        source: 'validator_correction',
        rationale: `Validator 将 ${field} 修正为可执行值。`,
        overriddenAt: changedAt,
      };
    } else if (existing) {
      output[field] = { ...existing, effectiveValue: normalizedValue };
    }
  }
  return parameterDecisionMapSchema.parse(output);
};

export const parameterDecisionsFromResolution = (
  resolution: unknown,
): ParameterDecisionMap =>
  parseDecisions(asRecord(resolution)?.parameterDecisions);

const parseDecisions = (value: unknown): ParameterDecisionMap => {
  const parsed = parameterDecisionMapSchema.safeParse(value);
  return parsed.success ? { ...parsed.data } : {};
};

const decisionValue = (
  value: unknown,
): string | number | boolean | null | Array<string | number | boolean | null> | undefined => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item === null ||
        typeof item === 'string' ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)),
    )
  ) {
    return [...value] as Array<string | number | boolean | null>;
  }
  return undefined;
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
