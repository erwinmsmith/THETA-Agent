import { CapabilityRegistry } from '../capabilities/registry.js';
import type {
  DatasetConfirmation,
  DatasetFacts,
  ResearchIntent,
} from '../dataset-understanding/contracts.js';
import {
  plannerInputV2Schema,
  type PlannerInputV2,
} from './v2-contracts.js';

type Scalar = string | number | boolean | null;

export interface PlannerRuntimeV2Context {
  facts: DatasetFacts;
  confirmation: DatasetConfirmation;
  intent: ResearchIntent;
  evidenceRefs?: string[];
  constraints?: Record<string, unknown>;
  userOverrides?: Record<string, unknown>;
  catalog?: {
    source?: string;
    runnableSource?: string;
    models?: Array<{ id: string; runnable?: boolean }>;
  };
}

export const buildPlannerInputV2 = (
  context: PlannerRuntimeV2Context,
): PlannerInputV2 => {
  const registry = new CapabilityRegistry();
  const eligible = new Set(registry.plannerEligibleModelIds());
  const catalogModels = new Map(
    (context.catalog?.models ?? []).map((model) => [model.id.toLowerCase(), model] as const),
  );
  const hasRuntimeCatalog = catalogModels.size > 0;
  const constrainedDevice = context.constraints?.device;
  const device = constrainedDevice === 'cpu' || constrainedDevice === 'gpu' || constrainedDevice === 'unknown'
    ? constrainedDevice
    : context.intent.resourceBudget.device;
  const constrainedMemory = context.constraints?.memoryGb;
  const memoryGb = typeof constrainedMemory === 'number' && constrainedMemory > 0
    ? constrainedMemory
    : context.intent.resourceBudget.memoryGb;
  const offlineOnly = typeof context.constraints?.offlineOnly === 'boolean'
    ? context.constraints.offlineOnly
    : !context.intent.constraints.some((item) => /允许联网|network allowed/iu.test(item));
  const forbidden = new Set(stringList(context.constraints?.forbiddenModelIds));
  const effectiveCovariates = context.intent.comparisonPurpose === 'model'
    ? unique([
        ...(context.confirmation.covariateColumns ?? []),
        ...context.intent.comparisonDimensions,
      ])
    : context.confirmation.covariateColumns ?? [];
  const eligibleCards = registry.cards
    .filter((card) => eligible.has(card.modelId) && !forbidden.has(card.modelId))
    .filter((card) => !hasRuntimeCatalog || catalogModels.get(card.modelId)?.runnable === true)
    .filter((card) => context.intent.temporalPurpose !== 'topic_evolution' || card.capabilities.temporalTopics)
    .filter((card) => effectiveCovariates.length === 0 || card.capabilities.metadataEffects)
    .filter((card) => !card.catalog.requires.includes('time') || context.confirmation.timeColumns.length > 0)
    .filter((card) => !card.catalog.requires.includes('covariates') || effectiveCovariates.length > 0)
    .filter((card) => !offlineOnly || card.capabilities.offlineExecution !== 'unsupported')
    .filter((card) => device !== 'cpu' || card.capabilities.cpuExecution !== 'unsupported');
  return plannerInputV2Schema.parse({
    schemaVersion: '2.0.0',
    facts: context.facts,
    confirmation: {
      ...context.confirmation,
      covariateColumns: effectiveCovariates,
    },
    intent: context.intent,
    hardware: {
      device,
      ...(memoryGb
        ? { memoryGb }
        : {}),
      offlineOnly,
    },
    catalogVersion: [
      'theta-capability-cards@1.0.0',
      context.catalog?.source,
      context.catalog?.runnableSource,
    ].filter(Boolean).join('+'),
    candidates: eligibleCards.map((card) => ({
      modelId: card.modelId,
      runnable: hasRuntimeCatalog
        ? catalogModels.get(card.modelId)?.runnable === true
        : true,
      capabilities: unique([
        ...(card.capabilities.temporalTopics ? ['temporal_topics'] : []),
        ...(card.capabilities.metadataEffects ? ['metadata_effects'] : []),
        ...(card.capabilities.shortTextOptimized ? ['short_text_optimized'] : []),
        ...(card.capabilities.offlineExecution !== 'unsupported' ? ['offline_execution'] : []),
        ...(card.capabilities.cpuExecution !== 'unsupported' ? ['cpu_execution'] : []),
        ...card.capabilities.nativeOutputs,
      ]),
      parameterDefaults: Object.fromEntries(
        card.parameters
          .filter((parameter) => parameter.planField)
          .map((parameter) => [parameter.planField!, parameter.defaultValue]),
      ),
      parameterConstraints: card.parameters
        .filter((parameter) => parameter.planField)
        .map((parameter) => ({
          parameterId: parameter.planField!,
          minimum: parameter.minimum ?? null,
          maximum: parameter.maximum ?? null,
          choices: parameter.choices,
        })),
    })),
    evidenceRefs: unique(context.evidenceRefs ?? []).slice(0, 20),
    userOverrides: scalarRecord(context.userOverrides),
  });
};

const scalarRecord = (
  value: Record<string, unknown> | undefined,
): Record<string, Scalar> => Object.fromEntries(
  Object.entries(value ?? {}).filter(
    (entry): entry is [string, Scalar] => isScalar(entry[1]),
  ),
);

const isScalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const unique = (values: readonly string[]): string[] => [...new Set(values)];
const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim().toLowerCase())
  : [];
