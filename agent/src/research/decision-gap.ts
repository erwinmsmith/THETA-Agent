import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  researchIntentSchema,
  type DatasetConfirmation,
  type DatasetUnderstandingDraft,
  type ResearchIntent,
} from '@theta-agent/domain/dataset-understanding/contracts.js';

export const decisionGapSchema = z.object({
  id: z.string().min(1),
  category: z.enum([
    'research_goal', 'comparison', 'comparison_purpose', 'temporal',
    'temporal_purpose', 'granularity', 'success', 'constraint',
  ]),
  question: z.string().min(1),
  whyItMatters: z.string().min(1),
  planImpact: z.string().min(1),
  blocking: z.boolean(),
  defaultResolution: z.string().min(1),
  evidence: z.array(z.string().min(1)).max(8),
});

export const interviewMemorySchema = z.object({
  askedQuestionHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  resolvedGapIds: z.array(z.string().min(1)),
  defaultedGapIds: z.array(z.string().min(1)),
  lastQuestionByGap: z.record(z.string()),
});

export type DecisionGap = z.infer<typeof decisionGapSchema>;
export type InterviewMemory = z.infer<typeof interviewMemorySchema>;

export interface DecisionGapTurn {
  intent: ResearchIntent;
  memory: InterviewMemory;
  nextGap?: DecisionGap;
  appliedDefaults: string[];
  extractedFields: string[];
}

export const isAutonomousDelegationAnswer = (value: string): boolean =>
  /(?:后续|接下来|剩下|全部|都).{0,8}(?:交给|由|让).{0,4}(?:你|THETA|系统).{0,8}(?:安排|判断|决定|处理|分析|完成)|(?:你|THETA|系统).{0,6}(?:看着安排|看着办|自行安排|自行判断|自行分析|自动完成|全权处理)|按(?:照)?(?:你的|系统|THETA).{0,5}(?:建议|判断|方案).{0,5}(?:继续|执行|处理)|无需再问|不用再问/iu.test(value.trim());

export const applyDecisionGapDefaults = (
  current: ResearchIntent,
  gaps: readonly DecisionGap[],
  memory: InterviewMemory,
): DecisionGapTurn => {
  let intent = current;
  let nextMemory = memory;
  const appliedDefaults: string[] = [];
  const extractedFields: string[] = [];
  for (const gap of gaps) {
    if (nextMemory.resolvedGapIds.includes(gap.id)) continue;
    const turn = applyDecisionGapAnswer(intent, gap, '采用系统建议', nextMemory);
    intent = turn.intent;
    nextMemory = turn.memory;
    appliedDefaults.push(...turn.appliedDefaults);
    extractedFields.push(...turn.extractedFields);
  }
  if (intent.comparisonDimensions.length > 0 && intent.comparisonPurpose === 'unknown') {
    intent = researchIntentSchema.parse({
      ...intent,
      comparisonPurpose: 'display',
      unknowns: intent.unknowns.filter((id) => id !== 'comparison_purpose'),
    });
    nextMemory = interviewMemorySchema.parse({
      ...nextMemory,
      resolvedGapIds: unique([...nextMemory.resolvedGapIds, 'comparison_purpose']),
      defaultedGapIds: unique([...nextMemory.defaultedGapIds, 'comparison_purpose']),
    });
    appliedDefaults.push('比较列只用于结果展示，不进入模型训练。');
    extractedFields.push('comparisonPurpose');
  }
  if (intent.temporalAnalysis && intent.temporalPurpose === 'unknown') {
    intent = researchIntentSchema.parse({
      ...intent,
      temporalPurpose: 'display_trend',
      unknowns: intent.unknowns.filter((id) => id !== 'temporal_purpose'),
    });
    nextMemory = interviewMemorySchema.parse({
      ...nextMemory,
      resolvedGapIds: unique([...nextMemory.resolvedGapIds, 'temporal_purpose']),
      defaultedGapIds: unique([...nextMemory.defaultedGapIds, 'temporal_purpose']),
    });
    appliedDefaults.push('时间列只用于训练后趋势展示，不要求模型学习主题演化。');
    extractedFields.push('temporalPurpose');
  }
  return {
    intent,
    memory: nextMemory,
    appliedDefaults: unique(appliedDefaults),
    extractedFields: unique(extractedFields),
  };
};

export const emptyInterviewMemory = (): InterviewMemory => ({
  askedQuestionHashes: [],
  resolvedGapIds: [],
  defaultedGapIds: [],
  lastQuestionByGap: {},
});

export const createInitialResearchIntent = (): ResearchIntent =>
  researchIntentSchema.parse({
    schemaVersion: '2.0.0',
    researchQuestion: '探索数据中的主要结构与可解释模式',
    comparisonDimensions: [],
    comparisonPurpose: 'unknown',
    temporalAnalysis: false,
    temporalPurpose: 'unknown',
    topicGranularity: 'medium',
    successCriteria: [],
    constraints: [],
    unknowns: ['research_goal', 'comparison', 'temporal', 'success'],
  });

export const deriveDecisionGaps = (
  understanding: DatasetUnderstandingDraft,
  confirmation: DatasetConfirmation,
  intent: ResearchIntent,
): DecisionGap[] => {
  const gaps: DecisionGap[] = [];
  const hasUnknown = (id: string): boolean => intent.unknowns.includes(id);
  if (hasUnknown('research_goal')) {
    const topicHints = understanding.contentSummary.candidateTopics
      .slice(0, 3)
      .map((topic) => topic.label);
    gaps.push(gap('research_goal', 'research_goal',
      `我已确认主要分析 ${confirmation.textColumns.join('、')}。${topicHints.length > 0 ? `原始样本初步出现了 ${topicHints.join('、')} 等内容方向；` : ''}你最希望从这些记录中得到什么结论？`,
      '研究目标决定模型、评价方式和最终结果结构。',
      '影响模型候选、指标和图表。', true,
      '识别主要主题、关键词与代表文本。', [understanding.domain.label, ...topicHints]));
  }
  if (hasUnknown('comparison')) {
    const candidates = confirmation.metadataColumns.join('、');
    gaps.push(gap('comparison', 'comparison',
      candidates
        ? `数据中可用于分组的列包括 ${candidates}。需要比较哪些来源、群体或阶段？不需要比较也可以直接说明。`
        : '你需要比较不同来源、群体或阶段吗？不需要时可以直接说“不比较”。',
      '比较需求决定是否需要协变量、分组评价或额外图表。',
      '影响模型能力约束和分组输出。', false,
      '本轮不做分组比较。', confirmation.metadataColumns));
  }
  if (intent.comparisonDimensions.length > 0 && intent.comparisonPurpose === 'unknown') {
    gaps.push(gap('comparison_purpose', 'comparison_purpose',
      `你希望 ${intent.comparisonDimensions.join('、')} 只用于结果中的分组对比，还是作为训练协变量让模型估计它们与主题的关系？`,
      '展示分组和训练协变量是两种不同用途，不能仅凭出现了比较列自动决定。',
      '影响是否要求模型支持 metadata effects，以及列是否进入训练。', true,
      '只用于结果中的分组展示，不进入模型训练。', intent.comparisonDimensions));
  }
  if (hasUnknown('temporal')) {
    const candidates = confirmation.timeColumns.join('、');
    gaps.push(gap('temporal', 'temporal',
      candidates
        ? `我检测到时间列 ${candidates}。这次需要观察主题随时间变化吗？`
        : '当前没有可靠时间列。这次是否仍把时间趋势作为硬性目标？',
      '时间趋势要求可用时间列和支持时间建模的方案。',
      '影响 DTM 等模型候选与时间切片。', false,
      candidates ? '启用时间趋势分析。' : '不启用原生时间趋势分析。', confirmation.timeColumns));
  }
  if (intent.temporalAnalysis && intent.temporalPurpose === 'unknown') {
    gaps.push(gap('temporal_purpose', 'temporal_purpose',
      `时间列 ${confirmation.timeColumns.join('、') || '尚未确认'} 是只用于训练后绘制趋势，还是要求模型直接学习主题随时间的演化？`,
      '后处理趋势图不要求动态主题模型，原生主题演化才要求 DTM 等时间模型。',
      '影响候选模型过滤、时间切片和评价方式。', true,
      '只在训练后按时间聚合并绘制趋势，不要求模型学习主题演化。', confirmation.timeColumns));
  }
  if (hasUnknown('success')) {
    gaps.push(gap('success', 'success',
      '什么样的结果会让你认为这次分析是成功的？例如主题清晰、代表文本可信，或趋势能够解释。',
      '成功标准用于选择评价指标和人工审核点。',
      '影响评价门槛和交付内容。', false,
      '主题含义清晰、关键词和代表文本可解释。', []));
  }
  return gaps;
};

export const applyDecisionGapAnswer = (
  current: ResearchIntent,
  gap: DecisionGap,
  answer: string,
  memory: InterviewMemory,
): DecisionGapTurn => {
  const normalized = answer.trim();
  const useDefault = isUnknownAnswer(normalized) || requestsProposalFirst(normalized);
  const extraction = useDefault
    ? { patch: defaultPatch(gap), resolvedGapIds: [gap.id] }
    : extractAnswerPatch(current, gap, normalized);
  const patch = extraction.patch;
  const resolved = new Set([
    ...memory.resolvedGapIds,
    ...extraction.resolvedGapIds,
  ]);
  const defaulted = new Set(memory.defaultedGapIds);
  if (useDefault) defaulted.add(gap.id);
  const unknowns = reconcilePurposeUnknowns(
    researchIntentSchema.parse({ ...current, ...patch }),
    current.unknowns.filter((item) => !resolved.has(item)),
  );
  const intent = researchIntentSchema.parse({ ...current, ...patch, unknowns });
  const updatedMemory = interviewMemorySchema.parse({
    ...memory,
    askedQuestionHashes: unique([...memory.askedQuestionHashes, questionHash(gap.question)]),
    resolvedGapIds: [...resolved],
    defaultedGapIds: [...defaulted],
    lastQuestionByGap: { ...memory.lastQuestionByGap, [gap.id]: gap.question },
  });
  return {
    intent,
    memory: updatedMemory,
    appliedDefaults: useDefault ? [gap.defaultResolution] : [],
    extractedFields: Object.keys(patch),
  };
};

export const selectNextDecisionGap = (
  gaps: readonly DecisionGap[],
  memory: InterviewMemory,
): DecisionGap | undefined =>
  gaps.find((item) =>
    !memory.resolvedGapIds.includes(item.id) &&
    !memory.askedQuestionHashes.includes(questionHash(item.question)));

const answerPatch = (gap: DecisionGap, answer: string): Partial<ResearchIntent> => {
  switch (gap.category) {
    case 'research_goal':
      return { researchQuestion: answer };
    case 'comparison':
      return { comparisonDimensions: isNoComparison(answer) ? [] : splitValues(answer) };
    case 'comparison_purpose':
      return { comparisonPurpose: explicitComparisonPurpose(answer) ?? 'display' };
    case 'temporal':
      return { temporalAnalysis: isAffirmative(answer) };
    case 'temporal_purpose':
      return { temporalPurpose: explicitTemporalPurpose(answer) ?? 'display_trend' };
    case 'granularity':
      return { topicGranularity: /细|具体|fine/iu.test(answer) ? 'fine' : /粗|概括|coarse/iu.test(answer) ? 'coarse' : 'medium' };
    case 'success':
      return { successCriteria: splitValues(answer) };
    case 'constraint':
      return { constraints: splitValues(answer) };
  }
};

const extractAnswerPatch = (
  current: ResearchIntent,
  gap: DecisionGap,
  answer: string,
): { patch: Partial<ResearchIntent>; resolvedGapIds: string[] } => {
  const patch: Partial<ResearchIntent> = answerPatch(gap, answer);
  const resolvedGapIds = new Set([gap.id]);
  if (current.unknowns.includes('temporal') && hasTemporalDecision(answer)) {
    patch.temporalAnalysis = !isNegativeTemporal(answer);
    resolvedGapIds.add('temporal');
  }
  if (current.unknowns.includes('comparison') && hasComparisonDecision(answer)) {
    patch.comparisonDimensions = isNoComparison(answer)
      ? []
      : extractComparisonDimensions(answer);
    resolvedGapIds.add('comparison');
  }
  const comparisonPurpose = explicitComparisonPurpose(answer);
  if (comparisonPurpose) {
    patch.comparisonPurpose = comparisonPurpose;
    resolvedGapIds.add('comparison_purpose');
  }
  if (current.unknowns.includes('success') && hasSuccessDecision(answer)) {
    patch.successCriteria = splitValues(answer);
    resolvedGapIds.add('success');
  }
  const temporalPurpose = explicitTemporalPurpose(answer);
  if (temporalPurpose) {
    patch.temporalPurpose = temporalPurpose;
    resolvedGapIds.add('temporal_purpose');
  }
  if (/\bCPU\b|\bGPU\b|显存|内存|离线|实验/iu.test(answer)) {
    patch.constraints = unique([...current.constraints, ...splitValues(answer)]);
  }
  return { patch, resolvedGapIds: [...resolvedGapIds] };
};

const defaultPatch = (gap: DecisionGap): Partial<ResearchIntent> => {
  switch (gap.category) {
    case 'research_goal': return { researchQuestion: gap.defaultResolution };
    case 'comparison': return { comparisonDimensions: [] };
    case 'comparison_purpose': return { comparisonPurpose: 'display' };
    case 'temporal': return { temporalAnalysis: /启用/iu.test(gap.defaultResolution) };
    case 'temporal_purpose': return { temporalPurpose: 'display_trend' };
    case 'granularity': return { topicGranularity: 'medium' };
    case 'success': return { successCriteria: [gap.defaultResolution] };
    case 'constraint': return { constraints: [gap.defaultResolution] };
  }
};

const gap = (
  id: string,
  category: DecisionGap['category'],
  question: string,
  whyItMatters: string,
  planImpact: string,
  blocking: boolean,
  defaultResolution: string,
  evidence: string[],
): DecisionGap => decisionGapSchema.parse({ id, category, question, whyItMatters, planImpact, blocking, defaultResolution, evidence });

const splitValues = (value: string): string[] =>
  value.split(/[，,；;、\n]/u).map((item) => item.trim()).filter(Boolean).slice(0, 12);
const isUnknownAnswer = (value: string): boolean => /^(?:不知道|不清楚|不确定|unknown|由你判断|采用系统建议)$/iu.test(value);
const requestsProposalFirst = (value: string): boolean =>
  isAutonomousDelegationAnswer(value) || /先.{0,4}(?:方案|建议|分析)|你先决定|按默认/iu.test(value);
const isNoComparison = (value: string): boolean => /不比较|无需比较|没有比较/iu.test(value);
const isAffirmative = (value: string): boolean => /^(?:是|需要|要|启用|分析|yes|true)$/iu.test(value) || /时间|趋势/iu.test(value);
const hasTemporalDecision = (value: string): boolean =>
  /时间|日期|年度|月份|季度|趋势|时序|不做.{0,4}(?:时间|趋势)/iu.test(value);
const isNegativeTemporal = (value: string): boolean =>
  /不(?:需要|做|分析|考虑).{0,6}(?:时间|趋势)|无需.{0,6}(?:时间|趋势)/iu.test(value);
const hasComparisonDecision = (value: string): boolean =>
  isNoComparison(value) || /比较|对比|分组|群体|来源|阶段|类别|按照.+(?:列|字段)/iu.test(value);
const extractComparisonDimensions = (value: string): string[] => {
  const explicit = value.match(/(?:按照|按|比较|对比)([^。；;，,]{1,80})/u)?.[1];
  return splitValues(explicit ?? value).slice(0, 6);
};
const hasSuccessDecision = (value: string): boolean =>
  /成功|结果|输出|交付|图表|关键词|代表文本|可解释|准确|稳定|趋势/iu.test(value);
const questionHash = (value: string): string => createHash('sha256').update(value.trim()).digest('hex');
const unique = <T>(values: T[]): T[] => [...new Set(values)];

export const explicitComparisonPurpose = (
  value: string,
): ResearchIntent['comparisonPurpose'] | undefined => {
  if (/只(?:用于|做).{0,10}(?:展示|分组|对比|图表)|结果.{0,8}(?:展示|分组|对比)|后处理|不进入模型|不用于训练/iu.test(value)) return 'display';
  if (/训练协变量|进入模型|作为.{0,8}(?:协变量|训练输入)|(?:比较|分组|这些列|该列|它们).{0,10}用于训练|模型(?:直接)?估计|估计.{0,8}(?:影响|关系)|控制变量|metadata effects?/iu.test(value)) return 'model';
  return undefined;
};

export const explicitTemporalPurpose = (
  value: string,
): ResearchIntent['temporalPurpose'] | undefined => {
  if (/只(?:用于|做).{0,10}(?:趋势|展示|图表|聚合)|训练后.{0,8}(?:趋势|聚合|展示)|后处理.{0,8}(?:趋势|时间)|不要求模型.{0,8}(?:时间|演化)/iu.test(value)) return 'display_trend';
  if (/主题演化|动态主题|模型(?:直接)?学习.{0,8}(?:时间|演化|变化)|时间进入模型|原生时间模型|\bDTM\b/iu.test(value)) return 'topic_evolution';
  return undefined;
};

export const reconcilePurposeUnknowns = (
  intent: ResearchIntent,
  unknowns: string[] = intent.unknowns,
): string[] => {
  const next = new Set(unknowns);
  if (intent.comparisonDimensions.length > 0 && intent.comparisonPurpose === 'unknown') next.add('comparison_purpose');
  else next.delete('comparison_purpose');
  if (intent.temporalAnalysis && intent.temporalPurpose === 'unknown') next.add('temporal_purpose');
  else next.delete('temporal_purpose');
  return [...next];
};
