import { createHash } from 'node:crypto';
import type { PromptMessage } from '@codesoul-co/hypha-inference';
import { z } from 'zod';
import { createInferenceProviderFromEnv } from '@theta-agent/tools/support/providers/registry.js';
import {
  researchIntentSchema,
  type DatasetConfirmation,
  type ResearchIntent,
} from '@theta-agent/domain/dataset-understanding/contracts.js';
import {
  applyDecisionGapAnswer,
  explicitComparisonPurpose,
  explicitTemporalPurpose,
  interviewMemorySchema,
  reconcilePurposeUnknowns,
  type DecisionGap,
  type DecisionGapTurn,
  type InterviewMemory,
} from './decision-gap.js';
import {
  mergeResearchIntentPatches,
  normalizeResearchIntent,
  normalizeResearchIntentPatch,
  type ResearchIntentPatch,
} from './research-intent-normalizer.js';

const patchSchema = z.object({
  researchQuestion: z.string().min(1).max(2000).optional(),
  comparisonDimensions: z.array(z.string().min(1)).max(12).optional(),
  comparisonPurpose: z.enum(['unknown', 'display', 'model']).optional(),
  temporalAnalysis: z.boolean().optional(),
  temporalPurpose: z.enum(['unknown', 'display_trend', 'topic_evolution']).optional(),
  topicGranularity: z.enum(['coarse', 'medium', 'fine']).optional(),
  successCriteria: z.array(z.string().min(1)).max(12).optional(),
  constraints: z.array(z.string().min(1)).max(12).optional(),
  deliverables: z.array(z.string().min(1)).max(12).optional(),
  focusAreas: z.array(z.string().min(1)).max(12).optional(),
  resourceBudget: z.object({
    device: z.enum(['cpu', 'gpu', 'unknown']).optional(),
    memoryGb: z.number().positive().optional(),
    maxExperiments: z.number().int().min(1).max(20).optional(),
  }).optional(),
}).strict();

const resultSchema = z.object({
  patch: patchSchema,
  answeredDecisionIds: z.array(z.string().min(1)).max(12),
  acceptedDefaultIds: z.array(z.string().min(1)).max(12).default([]),
  evidenceSpans: z.array(z.string().min(1).max(300)).max(12).default([]),
  contradictions: z.array(z.string().min(1).max(500)).max(8).default([]),
  needsClarification: z.boolean().default(false),
}).strict();

export class ResearchIntentInterpreter {
  async interpret(input: {
    current: ResearchIntent;
    confirmation: DatasetConfirmation;
    gaps: DecisionGap[];
    currentGap: DecisionGap;
    memory: InterviewMemory;
    answer: string;
  }): Promise<DecisionGapTurn> {
    const explicitPatch = extractExplicitPatch(input.answer, input.confirmation);
    const fallback = applyPatchToTurn(applyDecisionGapAnswer(
      input.current,
      input.currentGap,
      input.answer,
      input.memory,
    ), explicitPatch, input.gaps);
    const provider = createInferenceProviderFromEnv({ timeoutMs: 90_000 });
    if (!provider) return fallback;
    try {
      const response = await provider.infer({
        runId: `theta-research-intent-${input.confirmation.datasetHash.slice(0, 16)}`,
        stepId: 'interpret-research-intent',
        modelAlias: provider.model,
        input: { messages: messages(input) },
        options: {
          temperature: 0,
          maxTokens: 1100,
          extra: { toolChoice: 'none', jsonObject: true },
        },
        trace: false,
        metadata: { purpose: 'interpret_research_intent' },
      });
      const parsed = resultSchema.parse(response.output);
      const safePatch = mergeResearchIntentPatches(
        sanitizePurposePatch(
          sanitizeLanguagePatch(parsed.patch, input.confirmation),
          input.answer,
        ),
        explicitPatch,
        input.current,
      );
      const validGapIds = new Set(input.gaps.map((gap) => gap.id));
      const answered = parsed.answeredDecisionIds.filter((id) => validGapIds.has(id));
      for (const id of resolvedGapIdsForPatch(safePatch, input.gaps)) {
        if (!answered.includes(id)) answered.push(id);
      }
      if (
        !answered.includes(input.currentGap.id) &&
        !parsed.needsClarification &&
        !['comparison_purpose', 'temporal_purpose'].includes(input.currentGap.category)
      ) {
        answered.push(input.currentGap.id);
      }
      const resolvedGapIds = unique([...input.memory.resolvedGapIds, ...answered]);
      const defaultedGapIds = unique([
        ...input.memory.defaultedGapIds,
        ...parsed.acceptedDefaultIds.filter((id) => validGapIds.has(id)),
      ]);
      const draftIntent = researchIntentSchema.parse({
        ...input.current,
        ...safePatch,
        resourceBudget: {
          ...input.current.resourceBudget,
          ...(safePatch.resourceBudget ?? {}),
        },
      });
      const unknowns = reconcilePurposeUnknowns(
        draftIntent,
        input.current.unknowns.filter((id) => !resolvedGapIds.includes(id)),
      );
      const intent = researchIntentSchema.parse({
        ...draftIntent,
        unknowns,
      });
      const memory = interviewMemorySchema.parse({
        ...input.memory,
        askedQuestionHashes: answered.includes(input.currentGap.id)
          ? unique([
              ...input.memory.askedQuestionHashes,
              questionHash(input.currentGap.question),
            ])
          : input.memory.askedQuestionHashes,
        resolvedGapIds,
        defaultedGapIds,
        lastQuestionByGap: answered.includes(input.currentGap.id)
          ? {
              ...input.memory.lastQuestionByGap,
              [input.currentGap.id]: input.currentGap.question,
            }
          : input.memory.lastQuestionByGap,
      });
      return {
        intent,
        memory,
        nextGap: undefined,
        appliedDefaults: input.gaps
          .filter((gap) => parsed.acceptedDefaultIds.includes(gap.id))
          .map((gap) => gap.defaultResolution),
        extractedFields: Object.keys(safePatch),
      };
    } catch {
      return fallback;
    }
  }

  async revise(input: {
    current: ResearchIntent;
    confirmation: DatasetConfirmation;
    answer: string;
  }): Promise<ResearchIntent> {
    const explicitPatch = extractExplicitPatch(input.answer, input.confirmation);
    const provider = createInferenceProviderFromEnv({ timeoutMs: 90_000 });
    let languagePatch: ResearchIntentPatch = {};
    if (provider) {
      try {
        const response = await provider.infer({
          runId: `theta-research-intent-revision-${input.confirmation.datasetHash.slice(0, 16)}`,
          stepId: 'revise-research-intent',
          modelAlias: provider.model,
          input: { messages: revisionMessages(input) },
          options: {
            temperature: 0,
            maxTokens: 900,
            extra: { toolChoice: 'none', jsonObject: true },
          },
          trace: false,
          metadata: { purpose: 'revise_research_intent' },
        });
        languagePatch = sanitizePurposePatch(
          sanitizeLanguagePatch(patchSchema.parse(response.output), input.confirmation),
          input.answer,
        );
      } catch {
        languagePatch = {};
      }
    }
    const patch = mergeResearchIntentPatches(languagePatch, explicitPatch, input.current);
    const draft = researchIntentSchema.parse({
      ...input.current,
      ...patch,
      resourceBudget: {
        ...input.current.resourceBudget,
        ...(patch.resourceBudget ?? {}),
      },
    });
    return researchIntentSchema.parse({
      ...draft,
      unknowns: reconcilePurposeUnknowns(draft),
    });
  }
}

const messages = (input: {
  current: ResearchIntent;
  confirmation: DatasetConfirmation;
  gaps: DecisionGap[];
  currentGap: DecisionGap;
  answer: string;
}): PromptMessage[] => [{
  role: 'system',
  content: [
    'Interpret the complete user answer into one THETA ResearchIntent patch.',
    'Extract every explicit intent, not only the currently asked decision.',
    'Return JSON only with patch, answeredDecisionIds, acceptedDefaultIds, evidenceSpans, contradictions, and needsClarification.',
    'Do not infer dataset columns outside the confirmed roles. Empty comparisonDimensions means no comparison.',
    'comparisonPurpose is display only when groups are post-training output, or model only when the user explicitly wants training covariates.',
    'temporalPurpose is display_trend for post-training charts, or topic_evolution only when the model must learn topic evolution.',
    'successCriteria, constraints, deliverables, focusAreas, and comparisonDimensions are arrays of short strings. resourceBudget is an object.',
  ].join(' '),
}, {
  role: 'user',
  content: JSON.stringify({
    currentIntent: input.current,
    confirmedData: input.confirmation,
    currentDecision: input.currentGap,
    openDecisions: input.gaps,
    answer: input.answer,
  }),
}];

const revisionMessages = (input: {
  current: ResearchIntent;
  confirmation: DatasetConfirmation;
  answer: string;
}): PromptMessage[] => [{
  role: 'system',
  content: [
    'Convert the user correction into a partial THETA ResearchIntent JSON object.',
    'Return only fields that the user explicitly changes and return JSON only.',
    'Never mix researchQuestion, deliverables, successCriteria, constraints, or resourceBudget.',
    'Use only confirmed dataset columns. Do not guess comparisonPurpose or temporalPurpose.',
  ].join(' '),
}, {
  role: 'user',
  content: JSON.stringify({
    currentIntent: input.current,
    confirmedData: input.confirmation,
    correction: input.answer,
  }),
}];

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const questionHash = (value: string): string =>
  createHash('sha256').update(value.trim()).digest('hex');

const extractExplicitPatch = (
  answer: string,
  confirmation: DatasetConfirmation,
): z.infer<typeof patchSchema> => {
  const patch: z.infer<typeof patchSchema> = {};
  const columns = unique([
    ...confirmation.metadataColumns,
    ...(confirmation.groupColumns ?? []),
    ...(confirmation.covariateColumns ?? []),
    ...(confirmation.evaluationColumns ?? []),
  ]);
  const mentionedColumns = columns.filter((column) =>
    new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(column)}([^A-Za-z0-9_]|$)`, 'iu').test(answer),
  );
  const researchQuestion = clauseAfter(
    answer,
    /(?:研究问题|研究目标)(?:改为|调整为|是|为|包括)?\s*/u,
    /(?:成功标准|最终需要|交付|输出|约束|限制|只使用|使用本地)/u,
  );
  if (researchQuestion) patch.researchQuestion = researchQuestion;
  if (/不比较|无需比较|不做.{0,4}(?:比较|对比)/u.test(answer)) {
    patch.comparisonDimensions = [];
  } else if (mentionedColumns.length > 0 && /比较|对比|分组|维度|按照|按/u.test(answer)) {
    patch.comparisonDimensions = mentionedColumns;
  }
  const comparisonPurpose = explicitComparisonPurpose(answer);
  if (comparisonPurpose) patch.comparisonPurpose = comparisonPurpose;
  if (/不(?:需要|做|分析|考虑).{0,6}(?:时间|趋势)|无需.{0,6}(?:时间|趋势)/u.test(answer)) {
    patch.temporalAnalysis = false;
  } else if (/时间|日期|年度|月份|季度|趋势|时序/u.test(answer)) {
    patch.temporalAnalysis = true;
  }
  const temporalPurpose = explicitTemporalPurpose(answer);
  if (temporalPurpose) patch.temporalPurpose = temporalPurpose;
  if (/细粒度|更多主题|15个以上/u.test(answer)) patch.topicGranularity = 'fine';
  else if (/宽泛|少量主题|5\s*[-到至]\s*8/u.test(answer)) patch.topicGranularity = 'coarse';
  else if (/中等|8\s*[-到至]\s*1[02]|10\s*[-到至]\s*15/u.test(answer)) patch.topicGranularity = 'medium';

  const success = clauseAfter(answer, /成功标准(?:改为|调整为|是|为|包括)?\s*/u, /(?:只使用|限制|约束|最终需要|交付|输出)/u);
  if (success) patch.successCriteria = splitSemanticItems(success);
  const deliverables = clauseAfter(answer, /(?:最终需要|交付(?:内容)?(?:改为|调整为|是|为|包括)?|输出(?:内容)?(?:改为|调整为|是|为|包括)?)\s*/u);
  if (deliverables) patch.deliverables = splitSemanticItems(deliverables);
  const constraints: string[] = [];
  for (const pattern of [
    /(?:只使用|使用)\s*(?:CPU|GPU)/giu,
    /(?:不|不要|禁止|无需)下载[^，,；;。]*/gu,
    /(?:离线|本地)(?:运行|执行|环境)?/gu,
    /最多\s*\d+\s*(?:次|组)?实验/gu,
    /内存[^，,；;。]*/gu,
    /显存[^，,；;。]*/gu,
  ]) {
    constraints.push(...[...answer.matchAll(pattern)].map((match) => match[0].trim()));
  }
  if (constraints.length > 0) patch.constraints = unique(constraints);
  const device = /\bGPU\b/iu.test(answer) ? 'gpu' : /\bCPU\b/iu.test(answer) ? 'cpu' : undefined;
  const maxExperiments = Number(answer.match(/最多\s*(\d+)\s*(?:次|组)?实验/u)?.[1]);
  if (device || (Number.isInteger(maxExperiments) && maxExperiments >= 1 && maxExperiments <= 20)) {
    patch.resourceBudget = {
      ...(device ? { device } : {}),
      ...(Number.isInteger(maxExperiments) && maxExperiments >= 1 && maxExperiments <= 20
        ? { maxExperiments }
        : {}),
    };
  }
  return patchSchema.parse(normalizeResearchIntentPatch(patch));
};

const sanitizeLanguagePatch = (
  patch: z.infer<typeof patchSchema>,
  confirmation: DatasetConfirmation,
): z.infer<typeof patchSchema> => {
  if (!patch.comparisonDimensions) return patch;
  const allowed = new Set([
    ...confirmation.metadataColumns,
    ...(confirmation.groupColumns ?? []),
    ...(confirmation.covariateColumns ?? []),
  ]);
  return {
    ...patch,
    comparisonDimensions: patch.comparisonDimensions.filter((column) => allowed.has(column)),
  };
};

const sanitizePurposePatch = (
  patch: z.infer<typeof patchSchema>,
  answer: string,
): z.infer<typeof patchSchema> => {
  const comparisonPurpose = explicitComparisonPurpose(answer);
  const temporalPurpose = explicitTemporalPurpose(answer);
  const {
    comparisonPurpose: _ignoredComparisonPurpose,
    temporalPurpose: _ignoredTemporalPurpose,
    ...safe
  } = patch;
  return patchSchema.parse({
    ...safe,
    ...(comparisonPurpose ? { comparisonPurpose } : {}),
    ...(temporalPurpose ? { temporalPurpose } : {}),
  });
};

const applyPatchToTurn = (
  turn: DecisionGapTurn,
  patch: z.infer<typeof patchSchema>,
  gaps: DecisionGap[],
): DecisionGapTurn => {
  if (Object.keys(patch).length === 0) return turn;
  const newlyResolved = resolvedGapIdsForPatch(patch, gaps);
  const resolvedGapIds = unique([...turn.memory.resolvedGapIds, ...newlyResolved]);
  const draft = normalizeResearchIntent(researchIntentSchema.parse({
    ...turn.intent,
    ...patch,
    resourceBudget: {
      ...turn.intent.resourceBudget,
      ...(patch.resourceBudget ?? {}),
    },
  }));
  return {
    ...turn,
    intent: researchIntentSchema.parse({
      ...draft,
      unknowns: reconcilePurposeUnknowns(
        draft,
        turn.intent.unknowns.filter((id) => !resolvedGapIds.includes(id)),
      ),
    }),
    memory: interviewMemorySchema.parse({ ...turn.memory, resolvedGapIds }),
    extractedFields: unique([...turn.extractedFields, ...Object.keys(patch)]),
  };
};

const resolvedGapIdsForPatch = (
  patch: z.infer<typeof patchSchema>,
  gaps: DecisionGap[],
): string[] => gaps.filter((gap) => {
  if (gap.category === 'research_goal') return patch.researchQuestion !== undefined;
  if (gap.category === 'comparison') return patch.comparisonDimensions !== undefined;
  if (gap.category === 'comparison_purpose') return patch.comparisonPurpose !== undefined && patch.comparisonPurpose !== 'unknown';
  if (gap.category === 'temporal') return patch.temporalAnalysis !== undefined;
  if (gap.category === 'temporal_purpose') return patch.temporalPurpose !== undefined && patch.temporalPurpose !== 'unknown';
  if (gap.category === 'granularity') return patch.topicGranularity !== undefined;
  if (gap.category === 'success') return patch.successCriteria !== undefined;
  return patch.constraints !== undefined || patch.resourceBudget !== undefined;
}).map((gap) => gap.id);

const clauseAfter = (value: string, start: RegExp, end?: RegExp): string => {
  const match = start.exec(value);
  if (!match) return '';
  const rest = value.slice((match.index ?? 0) + match[0].length);
  if (!end) return rest.trim();
  const endMatch = end.exec(rest);
  return rest.slice(0, endMatch?.index ?? rest.length).trim().replace(/[；;。，,]+$/u, '');
};

const splitSemanticItems = (value: string): string[] => value
  .split(/[，,；;、\n]|以及|并且|同时/u)
  .map((item) => item.trim())
  .filter(Boolean)
  .slice(0, 12);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
