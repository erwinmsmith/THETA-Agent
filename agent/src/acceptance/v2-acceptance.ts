import { z } from 'zod';

export const DEFAULT_NEW_WORKFLOW_VERSION = '2.0.0' as const;

export const workflowVersionSchema = z.enum(['1.0.0', '2.0.0']);
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;

export interface WorkflowVersionResolutionInput {
  isNewRun: boolean;
  requestedVersion?: WorkflowVersion;
  storedVersion?: WorkflowVersion;
}

export const resolveWorkflowVersion = (
  input: WorkflowVersionResolutionInput,
): WorkflowVersion => {
  if (input.storedVersion) return input.storedVersion;
  if (!input.isNewRun) return '1.0.0';
  return input.requestedVersion ?? DEFAULT_NEW_WORKFLOW_VERSION;
};

export const workflowMetricsV2Schema = z.object({
  schemaVersion: z.literal('2.0.0'),
  workflowVersion: workflowVersionSchema,
  datasetInspectionDurationMs: z.number().int().nonnegative(),
  datasetExploreToolCalls: z.number().int().nonnegative(),
  datasetUnderstandingDurationMs: z.number().int().nonnegative(),
  datasetUnderstandingSource: z.enum([
    'deterministic',
    'provider',
    'user',
    'hybrid',
    'unavailable',
  ]),
  datasetUnderstandingValidationFailures: z.number().int().nonnegative(),
  providerFallbackCount: z.number().int().nonnegative(),
  /** @deprecated Use providerFallbackCount. */
  minimaxFallbackCount: z.number().int().nonnegative(),
  userDatasetCorrectionCount: z.number().int().nonnegative(),
  textColumnCorrectionCount: z.number().int().nonnegative(),
  grillingTurnCount: z.number().int().nonnegative(),
  repeatedQuestionBlockCount: z.number().int().nonnegative(),
  acceptedDefaultCount: z.number().int().nonnegative(),
  plannerDurationMs: z.number().int().nonnegative(),
  plannerRepairCount: z.number().int().nonnegative(),
  plannerFallbackCount: z.number().int().nonnegative(),
  planAdjustmentCount: z.number().int().nonnegative(),
  timeToTrainingApprovalMs: z.number().int().nonnegative(),
});

export type WorkflowMetricsV2 = z.infer<typeof workflowMetricsV2Schema>;

interface MetricEvent {
  type: string;
  timestamp: string;
  payload?: unknown;
}

export interface DeriveWorkflowMetricsInput {
  workflowVersion: WorkflowVersion;
  events: readonly MetricEvent[];
  variables: Readonly<Record<string, unknown>>;
}

export const deriveWorkflowMetricsV2 = (
  input: DeriveWorkflowMetricsInput,
): WorkflowMetricsV2 => {
  const understanding = record(input.variables.datasetUnderstanding);
  const provenance = record(understanding?.provenance);
  const confirmation = record(input.variables.datasetConfirmation);
  const memory = record(input.variables.interviewMemory);
  const planProposal = record(input.variables.planProposal);
  return workflowMetricsV2Schema.parse({
    schemaVersion: '2.0.0',
    workflowVersion: input.workflowVersion,
    datasetInspectionDurationMs: stateDuration(input.events, 'InspectDataset'),
    datasetExploreToolCalls: input.variables.datasetFacts ? 1 : 0,
    datasetUnderstandingDurationMs: stateDuration(input.events, 'AnalyzeDataset'),
    datasetUnderstandingSource: understandingSource(provenance?.source),
    datasetUnderstandingValidationFailures: countEvents(
      input.events,
      'theta.dataset-understanding.validation.failed',
    ),
    providerFallbackCount: providerFallbackCount(input.events),
    minimaxFallbackCount: providerFallbackCount(input.events),
    userDatasetCorrectionCount: confirmation?.status === 'corrected' ? 1 : 0,
    textColumnCorrectionCount: correctionCount(
      understanding?.textColumns,
      confirmation?.textColumns,
    ),
    grillingTurnCount: stringArray(memory?.resolvedGapIds).length,
    repeatedQuestionBlockCount: countEvents(
      input.events,
      'theta.research.question.repeated.blocked',
    ),
    acceptedDefaultCount: stringArray(memory?.defaultedGapIds).length,
    plannerDurationMs: stateDuration(input.events, 'RecommendModel'),
    plannerRepairCount: countEvents(input.events, 'theta.planner.repaired'),
    plannerFallbackCount: planProposal?.source === 'fallback' ? 1 : 0,
    planAdjustmentCount: countStructuredInputs(input.events, 'planAdjustment'),
    timeToTrainingApprovalMs: elapsedBetween(
      input.events,
      'run.started',
      'AwaitTrainingStartApproval',
    ),
  });
};

const providerFallbackCount = (events: readonly MetricEvent[]): number =>
  countEvents(events, 'theta.provider.fallback') +
  countEvents(events, 'theta.minimax.fallback');

export const goldenTranscriptSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  scenarioId: z.string().min(1),
  title: z.string().min(1),
  dataset: z.object({
    format: z.enum(['csv', 'txt']),
    rowCount: z.number().int().positive(),
    columns: z.array(z.string().min(1)).min(1),
    inferredDomain: z.string().min(1),
  }),
  toolCalls: z.array(z.string().min(1)).min(1),
  factsDigest: z.string().min(1),
  initialUnderstanding: z.string().min(1),
  userConfirmation: z.object({
    status: z.enum(['confirmed', 'corrected']),
    summary: z.string().min(1),
  }),
  turns: z.array(z.object({
    gapId: z.string().min(1),
    question: z.string().min(1),
    answerMode: z.enum(['explicit', 'unknown', 'default']),
    informationGain: z.number().min(0).max(100),
  })).max(4),
  researchIntentRevisions: z.array(z.string().min(1)).min(1),
  finalPlan: z.object({
    modelId: z.string().min(1),
    parameters: z.record(z.union([z.string(), z.number(), z.boolean()])),
    evaluation: z.array(z.string().min(1)).min(1),
    visualizations: z.array(z.string().min(1)).min(1),
  }),
  validatorReceipt: z.object({
    valid: z.literal(true),
    evidenceRefsValid: z.literal(true),
    columnRolesValid: z.literal(true),
  }),
  ux: z.object({
    automaticTextSelection: z.boolean(),
    naturalQuestions: z.literal(true),
    noMeaninglessQuestions: z.literal(true),
    clearNextStep: z.literal(true),
    progressVisible: z.literal(true),
  }),
  metrics: workflowMetricsV2Schema,
});

export type GoldenTranscript = z.infer<typeof goldenTranscriptSchema>;

export interface GoldenAcceptanceSummary {
  scenarioCount: number;
  automaticTextSelectionRate: number;
  medianGrillingTurns: number;
  repeatedQuestionRate: number;
  invalidEvidenceCount: number;
  passed: boolean;
}

export const evaluateGoldenTranscripts = (
  values: readonly GoldenTranscript[],
): GoldenAcceptanceSummary => {
  const transcripts = values.map((value) => goldenTranscriptSchema.parse(value));
  if (transcripts.length < 10) {
    throw new Error('Planner V2 acceptance requires at least 10 Golden Transcripts.');
  }
  const automatic = rate(transcripts.filter((item) => item.ux.automaticTextSelection).length, transcripts.length);
  const grilling = transcripts
    .map((item) => item.metrics.grillingTurnCount)
    .sort((left, right) => left - right);
  const median = grilling[Math.floor(grilling.length / 2)] ?? 0;
  const repeats = transcripts.reduce(
    (sum, item) => sum + item.metrics.repeatedQuestionBlockCount,
    0,
  );
  const totalTurns = transcripts.reduce((sum, item) => sum + item.turns.length, 0);
  const invalidEvidenceCount = transcripts.filter(
    (item) => !item.validatorReceipt.evidenceRefsValid,
  ).length;
  return {
    scenarioCount: transcripts.length,
    automaticTextSelectionRate: automatic,
    medianGrillingTurns: median,
    repeatedQuestionRate: rate(repeats, Math.max(1, totalTurns)),
    invalidEvidenceCount,
    passed:
      automatic > 0.9 &&
      median <= 4 &&
      repeats === 0 &&
      invalidEvidenceCount === 0 &&
      transcripts.every(
        (item) =>
          item.validatorReceipt.valid &&
          item.validatorReceipt.columnRolesValid &&
          item.ux.clearNextStep &&
          item.ux.progressVisible,
      ),
  };
};

const stateDuration = (events: readonly MetricEvent[], stateId: string): number => {
  const enteredIndex = events.findIndex(
    (event) =>
      event.type === 'fsm.state.entered' &&
      stringProperty(event.payload, 'stateId') === stateId,
  );
  if (enteredIndex < 0) return 0;
  const start = timestamp(events[enteredIndex]?.timestamp);
  const next = events.slice(enteredIndex + 1).find(
    (event) => event.type === 'fsm.state.entered',
  );
  return Math.max(0, timestamp(next?.timestamp) - start);
};

const elapsedBetween = (
  events: readonly MetricEvent[],
  startType: string,
  endState: string,
): number => {
  const start = events.find((event) => event.type === startType);
  const end = events.find(
    (event) =>
      event.type === 'fsm.state.entered' &&
      stringProperty(event.payload, 'stateId') === endState,
  );
  return Math.max(0, timestamp(end?.timestamp) - timestamp(start?.timestamp));
};

const countEvents = (events: readonly MetricEvent[], type: string): number =>
  events.filter((event) => event.type === type).length;

const countStructuredInputs = (
  events: readonly MetricEvent[],
  key: string,
): number => events.filter(
  (event) =>
    event.type === 'reasoning.decision.recorded' &&
    record(event.payload)?.[key] !== undefined,
).length;

const correctionCount = (suggested: unknown, confirmed: unknown): number => {
  const suggestedColumns = Array.isArray(suggested)
    ? suggested.map((item) => record(item)?.column).filter((item): item is string => typeof item === 'string')
    : [];
  const confirmedColumns = stringArray(confirmed);
  return confirmedColumns.length > 0 &&
    suggestedColumns.join('\u0000') !== confirmedColumns.join('\u0000')
    ? 1
    : 0;
};

const understandingSource = (
  value: unknown,
): WorkflowMetricsV2['datasetUnderstandingSource'] =>
  value === 'deterministic' || value === 'provider' || value === 'user' || value === 'hybrid'
    ? value
    : 'unavailable';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const stringProperty = (value: unknown, key: string): string | undefined => {
  const nested = record(value)?.[key];
  return typeof nested === 'string' ? nested : undefined;
};

const timestamp = (value: string | undefined): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const rate = (numerator: number, denominator: number): number =>
  denominator > 0 ? numerator / denominator : 0;
