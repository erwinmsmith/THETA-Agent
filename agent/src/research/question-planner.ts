import type {
  DatasetProfile,
  InformationGap,
  PlannedQuestion,
} from '@theta-agent/domain/research/contracts.js';

export interface QuestionPlanningContext {
  currentState: string;
  askedCounts?: Readonly<Record<string, number>>;
  recentlyAskedGapId?: string;
  datasetProfile?: DatasetProfile;
}

export const planResearchQuestions = (
  gaps: readonly InformationGap[],
  context: QuestionPlanningContext,
  limit = 3,
): PlannedQuestion[] =>
  gaps
    .map((gap) => {
      const askedCount = context.askedCounts?.[gap.id] ?? 0;
      const score =
        (gap.severity === 'blocking' ? 1000 : 100) +
        gap.informationGain +
        (context.currentState === 'ResearchClarification' ? 20 : 0) -
        askedCount * 25 -
        (context.recentlyAskedGapId === gap.id ? 10 : 0);
      return {
        gapId: gap.id,
        field: gap.field,
        question: dataAwareQuestion(gap, context.datasetProfile, askedCount),
        severity: gap.severity,
        score,
      };
    })
    .sort(
      (left, right) =>
        (left.severity === right.severity
          ? 0
          : left.severity === 'blocking'
            ? -1
            : 1) ||
        right.score - left.score ||
        left.gapId.localeCompare(right.gapId),
    )
    .slice(0, Math.max(1, Math.min(limit, 3)));

const dataAwareQuestion = (
  gap: InformationGap,
  profile?: DatasetProfile,
  askedCount = 0,
): string => {
  if (!profile) return humanQuestion(gap, askedCount);
  const names = (values: readonly { name: string }[]): string =>
    values
      .slice(0, 4)
      .map((item) => item.name)
      .join('、');
  switch (gap.field.split(',')[0] ?? gap.field) {
    case 'domainConfirmed':
      return profile.inferredDomain
        ? `我先在本地读取了数据结构和少量样本，初步判断它属于“${profile.inferredDomain.label}”方向。这个方向判断准确吗？你可以回答“是”，或者直接告诉我更合适的领域。`
        : gap.question;
    case 'analysisUnit':
      return askedCount > 0
        ? `换个简单的说法：系统看到 ${profile.rowCount} 行数据。请告诉我“一行”是一条评论、一篇文章，还是其他对象；不确定也可以直接说“由你判断”。`
        : `系统已读取到 ${profile.rowCount} 行数据。每一行在你的研究中代表什么？`;
    case 'textFieldIntent': {
      const candidates = names(profile.columnCandidates.text);
      return candidates
        ? askedCount > 0
          ? `我已找到可能存放正文的列：${candidates}。你只需说明主要分析哪一列；不确定时可以说“采用系统建议”。`
          : `系统检测到可能的正文列：${candidates}。你真正希望分析的是哪类文本内容？`
        : humanQuestion(gap, askedCount);
    }
    case 'timeRange': {
      const candidates = names(profile.columnCandidates.time);
      return candidates
        ? `系统检测到可能的时间列：${candidates}。你希望依据哪个时间字段或范围分析变化？`
        : humanQuestion(gap, askedCount);
    }
    case 'comparisonGroups': {
      const candidates = names(profile.columnCandidates.metadata);
      return candidates
        ? `系统检测到可能的分组列：${candidates}。你希望比较其中哪些来源、群体或阶段？如果不比较也可以明确说明。`
        : humanQuestion(gap, askedCount);
    }
    default:
      return humanQuestion(gap, askedCount);
  }
};

const humanQuestion = (gap: InformationGap, askedCount: number): string => {
  if (askedCount < 1) return gap.question;
  const field = gap.field.split(',')[0] ?? gap.field;
  const alternatives: Readonly<Record<string, string>> = {
    sensitiveData:
      '我只需要做安全判断：数据中有没有姓名、手机号、医疗记录、内部文件等不适合外发的内容？回答“有”或“没有”即可。',
    researchQuestion:
      '不用写专业术语。请用一句话告诉我：你最希望从这批数据里发现什么？',
    collectionMethod:
      '这些记录大致来自哪里，例如问卷、平台评论、新闻或已有业务系统？不清楚可以说“来源未知”。',
    successCriteria:
      '你希望最终看到什么就算分析有用，例如清晰主题、关键词、代表文本或时间变化？',
    comparisonGroups:
      '需要比较不同来源、群体或时间段吗？不需要时直接回答“不比较”。',
    topicGranularity:
      '你更想看少而概括的主题，还是多而具体的主题？拿不准时我会先采用中等粒度。',
    knownBiases:
      '你是否已经知道数据有样本少、来源单一或时间不均等局限？没有发现也可以直接说明。',
    hardwareLimit:
      '这台电脑是否有可用于训练的 GPU？不知道时我会采用更稳妥的 CPU 方案。',
  };
  return alternatives[field] ?? `换一种说法：${gap.question}`;
};
