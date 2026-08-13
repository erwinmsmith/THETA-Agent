import type { InformationGap, ResearchBrief } from '@theta-agent/domain/research/contracts.js';

type GapRule = (brief: ResearchBrief) => InformationGap | null;

const gap = (
  id: string,
  field: string,
  severity: InformationGap['severity'],
  question: string,
  reason: string,
  informationGain: number,
): InformationGap => ({
  id,
  field,
  severity,
  question,
  reason,
  informationGain,
});

export const detectResearchQuestionGap: GapRule = (brief) =>
  brief.researchQuestion
    ? null
    : gap(
        'gap.research-question',
        'researchQuestion',
        'blocking',
        '你希望通过这批数据回答什么研究问题？',
        '明确研究问题后，才能判断模型和评价方式是否合适。',
        100,
      );

export const detectDomainConfirmationGap: GapRule = (brief) =>
  brief.domainConfirmed
    ? null
    : gap(
        'gap.00-domain-confirmation',
        'domainConfirmed',
        'blocking',
        brief.researchDomain
          ? `我初步判断这批数据属于“${brief.researchDomain}”方向。这个判断符合你的数据背景吗？`
          : '这批数据主要属于哪个领域或方向？',
        '先确认领域方向，THETA 才能用贴近业务的语言解释数据并减少后续提问。',
        100,
      );

export const detectDataSourceGap: GapRule = (brief) =>
  brief.dataSources.length > 0
    ? null
    : gap(
        'gap.data-source',
        'dataSources',
        'blocking',
        '这次分析使用的是哪一个本地数据集？',
        '检查数据前需要确认数据来源。',
        100,
      );

export const detectAnalysisUnitGap: GapRule = (brief) =>
  brief.analysisUnit
    ? null
    : gap(
        'gap.analysis-unit',
        'analysisUnit',
        'blocking',
        '数据中的一行代表什么？',
        '分析单位决定模型如何解释每一行和最终主题占比。',
        90,
      );

export const detectTextFieldIntentGap: GapRule = (brief) =>
  brief.textFieldIntent
    ? null
    : gap(
        'gap.text-field-intent',
        'textFieldIntent',
        'blocking',
        '每条记录中，哪一类文本内容是你真正希望分析的正文？',
        '系统可以检测列名，但正文的业务含义必须由你确认。',
        95,
      );

export const detectTrendTimeGap: GapRule = (brief) =>
  brief.trendAnalysis &&
  brief.expectedRowCount !== undefined &&
  !brief.timeRange &&
  brief.candidateTimeColumns.length === 0
    ? gap(
        'gap.trend-time',
        'timeRange',
        'blocking',
        '你希望用哪个时间字段或时间范围观察主题变化？',
        '时间趋势分析必须有明确的时间依据。',
        100,
      )
    : null;

export const detectPrivacyConfirmationGap: GapRule = (brief) =>
  brief.sensitiveData.status === 'unknown'
    ? gap(
        'gap.privacy-confirmation',
        'sensitiveData',
        'blocking',
        '这批数据是否包含个人信息、机密内容或其他敏感数据？',
        '进入外部语言服务或模型训练前必须确认敏感数据情况；本地预检不会上传原始文本。',
        100,
      )
    : null;

export const detectSuccessCriteriaGap: GapRule = (brief) =>
  brief.successCriteria.length > 0
    ? null
    : gap(
        'gap.success-criteria',
        'successCriteria',
        'optional',
        '什么样的结果会让你认为这次分析是成功的？',
        '成功标准会影响模型、主题数量和评价指标的推荐。',
        70,
      );

export const detectHardwareLimitGap: GapRule = (brief) =>
  brief.hardwareLimit.device !== 'unknown'
    ? null
    : gap(
        'gap.hardware-limit',
        'hardwareLimit',
        'optional',
        '这次训练只能使用 CPU，还是有可用的 GPU？',
        '硬件条件会排除当前机器无法运行的模型。',
        65,
      );

export const detectCollectionMethodGap: GapRule = (brief) =>
  brief.collectionMethod
    ? null
    : gap(
        'gap.collection-method',
        'collectionMethod',
        'optional',
        '这些数据是如何产生或收集的？',
        '数据生成方式有助于识别偏差并正确解释主题。',
        72,
      );

export const detectComparisonGroupsGap: GapRule = (brief) =>
  (brief.comparisonIntent ?? 'unknown') !== 'unknown'
    ? null
    : gap(
        'gap.comparison-groups',
        'comparisonGroups',
        'optional',
        '你希望比较哪些来源、群体或时间阶段？如果不需要比较也可以明确说明。',
        '比较维度会影响模型选择和结果组织方式。',
        68,
      );

export const detectTopicGranularityGap: GapRule = (brief) =>
  brief.topicGranularity
    ? null
    : gap(
        'gap.topic-granularity',
        'topicGranularity',
        'optional',
        '你更希望得到少量宽泛主题，还是更多细粒度主题？',
        '主题粒度会直接影响建议的主题数量。',
        66,
      );

export const detectKnownBiasesGap: GapRule = (brief) =>
  brief.knownBiases.length > 0
    ? null
    : gap(
        'gap.known-biases',
        'knownBiases',
        'optional',
        '你已经知道这批数据可能存在哪些偏差或局限？没有也可以回答“暂未发现”。',
        '已知偏差应进入方案警告和结果解释。',
        60,
      );

export const researchGapRules: readonly GapRule[] = [
  detectDomainConfirmationGap,
  detectResearchQuestionGap,
  detectDataSourceGap,
  detectAnalysisUnitGap,
  detectTextFieldIntentGap,
  detectTrendTimeGap,
  detectPrivacyConfirmationGap,
  detectCollectionMethodGap,
  detectComparisonGroupsGap,
  detectSuccessCriteriaGap,
  detectTopicGranularityGap,
  detectKnownBiasesGap,
  detectHardwareLimitGap,
];

export const detectResearchGaps = (
  brief: ResearchBrief,
): InformationGap[] =>
  researchGapRules
    .map((rule) => rule(brief))
    .filter((value): value is InformationGap => value !== null)
    .filter(
      (value) => !brief.interviewComplete || value.severity === 'blocking',
    );
