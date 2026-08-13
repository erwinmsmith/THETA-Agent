import type { ResearchBriefPatch } from '../agent/research-contracts.js';

export interface GuardedResearchPatch {
  patch: ResearchBriefPatch;
  correctedFields: string[];
  confirmationFields: string[];
}

const explicitNotApplicable =
  /^(?:不|否|no|不要|无需|不需要|没有|无|不适用|暂未发现|尚未发现)(?:比较|分组|对比|偏差|局限|限制|group|comparison)?[。.]?$/iu;

const meaningfulCategoryPhrase = (value: string): boolean =>
  value.length >= 2 &&
  value.length <= 120 &&
  /[\p{L}\p{N}]/u.test(value) &&
  !/[？?]$/u.test(value) &&
  !/^(?:你|THETA|系统|助手).*(?:能|可以|怎么|如何|为什么|什么)/iu.test(value) &&
  !/^(?:测试|test|正常|好的|好|可以|确认|继续|下一步|日常|普通|一般)[。.]?$/iu.test(value);

export const researchAnswerSupportsField = (
  field: string,
  answer: string,
): boolean => {
  const value = answer.trim();
  if (!value || /^(?:不知道|不清楚|随便|都可以|无所谓|跳过|略)[。.]?$/iu.test(value)) {
    return false;
  }
  switch (field.split(',')[0] ?? field) {
    case 'domainConfirmed':
      return /^(?:是|对|准确|符合|可以|确认|没错)[。.]?$/u.test(value) ||
        /不是|不对|更准确|应该是|属于|领域|方向/u.test(value);
    case 'researchDomain':
      return meaningfulCategoryPhrase(value);
    case 'researchQuestion':
      return value.length >= 8 && /研究|目标|识别|分析|比较|探索|提取|预测|分类|主题|趋势|关系|影响/iu.test(value);
    case 'analysisUnit':
      return /每(?:一)?(?:行|条|篇|个)|记录|文档|文章|帖子|评论|样本|文本/iu.test(value);
    case 'textFieldIntent':
      return (
        /正文|文本|内容|语料|字段|列|词汇|短语|句子|对话|评论|帖子|新闻|报告|记录|文章|标题|摘要/iu.test(value) ||
        meaningfulCategoryPhrase(value)
      );
    case 'collectionMethod':
      return /采集|收集|整理|汇总|导出|爬取|抓取|问卷|访谈|实验|日志|数据库|平台|人工|生成|来源/iu.test(value);
    case 'comparisonGroups':
      return explicitNotApplicable.test(value) || /比较|对比|来源|群体|分组|时间|阶段|月份|年份|地区|类别|source|group|category|period/iu.test(value);
    case 'successCriteria':
      return value.length >= 4 && /成功|标准|清晰|稳定|准确|一致|可解释|关键词|代表|占比|趋势|指标|困惑度|主题|结果/iu.test(value);
    case 'topicGranularity':
      return /宽泛|少量|粗粒度|细粒度|更多主题|适中|中等|medium|broad|fine|\d+\s*个?主题/iu.test(value);
    case 'knownBiases':
      return explicitNotApplicable.test(value) || /偏差|局限|限制|样本|不均|缺失|噪声|代表性|误差/iu.test(value);
    case 'hardwareLimit':
      return /CPU|GPU|显卡|CUDA|\d+(?:\.\d+)?\s*(?:GB|G)\b/iu.test(value);
    case 'timeRange':
      return /时间|日期|年份|月份|季度|timestamp|date|(?:19|20)\d{2}/iu.test(value);
    case 'sensitiveData':
      return /个人|隐私|机密|敏感|医疗|商业|合成|模拟|不包含|不含|不存在|没有|\byes\b|\bno\b/iu.test(value);
    case 'trendAnalysis':
      return /时间|日期|趋势|变化|temporal|trend|time/iu.test(value);
    case 'offlineOnly':
      return /离线|联网|远程|offline|online|remote/iu.test(value);
    case 'language':
      return /中文|英文|英语|汉语|language|Chinese|English/iu.test(value);
    default:
      return value.length >= 2;
  }
};

const explicitlyNoGpu =
  /(?:不|不要|不用|禁止|无法|没有|无)\s*(?:使用|可用|支持)?\s*(?:GPU|显卡|CUDA)/iu;
const explicitlyNoCpu =
  /(?:不|不要|不用|禁止|无法|没有|无)\s*(?:使用|可用|支持)?\s*CPU/iu;

export const guardCriticalResearchPatch = (
  field: string,
  answer: string,
  providerPatch: ResearchBriefPatch,
  confidenceByField: Readonly<Record<string, number>> = {},
): GuardedResearchPatch => {
  const authoritativeField = field.split(',')[0] ?? field;
  const patch: ResearchBriefPatch = { ...providerPatch };
  const correctedFields: string[] = [];
  const confirmationFields: string[] = [];

  if (!researchAnswerSupportsField(authoritativeField, answer)) {
    delete patch[authoritativeField as keyof ResearchBriefPatch];
    if (authoritativeField === 'comparisonGroups') delete patch.comparisonIntent;
    confirmationFields.push(authoritativeField);
  }

  if (authoritativeField === 'domainConfirmed') {
    const accepted = /^(?:是|对|准确|符合|可以|确认|没错)[。.]?$/u.test(answer.trim());
    const corrected = /不是|不对|更准确|应该是|属于|领域|方向/u.test(answer);
    if (accepted || corrected) {
      patch.domainConfirmed = true;
      correctedFields.push('domainConfirmed');
    }
  }

  const shortNo =
    authoritativeField === 'sensitiveData' &&
    /^(?:否|no|不包含|不含|没有|无|不存在)[。.]?$/iu.test(answer.trim());
  const shortYes =
    authoritativeField === 'sensitiveData' &&
    /^(?:是|有|包含|yes)[。.]?$/iu.test(answer.trim());
  const explicitNo =
    shortNo ||
    /(?:不包含|不含|不存在|没有|无).{0,16}(?:个人|隐私|机密|敏感|医疗|商业)(?:信息|内容|数据)?|(?:个人|隐私|机密|敏感|医疗|商业)(?:信息|内容|数据)?.{0,16}(?:不包含|不含|不存在|没有|无)|完全.{0,8}模拟|人工.{0,8}模拟|合成数据|无敏感|does\s+not\s+contain.{0,20}(?:personal|sensitive|confidential)|without\s+(?:personal|sensitive|confidential)|synthetic|simulated|mock\s+data/iu.test(
      answer,
    );
  const explicitYes =
    (shortYes ||
      /(包含|含有|存在|涉及).{0,12}(个人|隐私|机密|敏感|医疗|商业)|contains?.{0,20}(personal|sensitive|confidential|medical)|\byes\b.{0,12}(sensitive|personal|confidential)/iu.test(
        answer,
      )) &&
    !explicitNo;
  if (explicitNo || explicitYes) {
    const guarded = {
      status: explicitNo ? ('no' as const) : ('yes' as const),
      categories: patch.sensitiveData?.categories ?? [],
    };
    if (patch.sensitiveData?.status !== guarded.status) {
      correctedFields.push('sensitiveData');
    }
    patch.sensitiveData = guarded;
  } else if (patch.sensitiveData !== undefined) {
    delete patch.sensitiveData;
    confirmationFields.push('sensitiveData');
  }

  if (authoritativeField === 'hardwareLimit' || patch.hardwareLimit) {
    const memory = answer.match(/(\d+(?:\.\d+)?)\s*(?:GB|G)\b/iu);
    let device: 'cpu' | 'gpu' | 'unknown' | undefined;
    if (
      explicitlyNoGpu.test(answer) ||
      (/CPU/iu.test(answer) && !explicitlyNoCpu.test(answer))
    ) {
      device = 'cpu';
    } else if (
      /(?:GPU|显卡|CUDA)/iu.test(answer) &&
      !explicitlyNoGpu.test(answer)
    ) {
      device = 'gpu';
    }
    if (device) {
      if (patch.hardwareLimit?.device !== device) {
        correctedFields.push('hardwareLimit');
      }
      patch.hardwareLimit = {
        device,
        ...(memory
          ? { memoryGb: Number(memory[1]) }
          : patch.hardwareLimit?.memoryGb === undefined
            ? {}
            : { memoryGb: patch.hardwareLimit.memoryGb }),
      };
    }
  }

  if (authoritativeField === 'trendAnalysis' || patch.trendAnalysis !== undefined) {
    const explicitNo =
      /(不|否|no|不要|无需|不需要|不分析|不研究).{0,16}(时间|趋势|变化|temporal|trend|time)|^(不|否|no|不要|无需|不需要)$/iu.test(
        answer.trim(),
      );
    if (explicitNo) {
      if (patch.trendAnalysis !== false) correctedFields.push('trendAnalysis');
      patch.trendAnalysis = false;
    }
  }

  if (authoritativeField === 'comparisonGroups' || patch.comparisonGroups) {
    const explicitNo =
      /^(不|否|no|不要|无需|不需要|没有|无|不适用).{0,20}(比较|分组|对比|group|comparison)?[。.]?$/iu.test(
        answer.trim(),
      );
    if (explicitNo) {
      if ((patch.comparisonGroups?.length ?? 0) > 0) {
        correctedFields.push('comparisonGroups');
      }
      patch.comparisonGroups = [];
      patch.comparisonIntent = 'none';
      correctedFields.push('comparisonIntent');
    } else if ((patch.comparisonGroups?.length ?? 0) > 0) {
      patch.comparisonIntent = 'groups';
      correctedFields.push('comparisonIntent');
    }
  }

  for (const patchField of Object.keys(patch)) {
    const threshold = patchField === authoritativeField ? 0.5 : 0.78;
    const confidence =
      correctedFields.includes(patchField) ||
      (patchField === 'sensitiveData' && (explicitNo || explicitYes))
        ? 1
        : (confidenceByField[patchField] ?? 0);
    if (confidence < threshold) {
      delete patch[patchField as keyof ResearchBriefPatch];
      confirmationFields.push(patchField);
    }
  }

  return {
    patch,
    correctedFields: [...new Set(correctedFields)],
    confirmationFields: [...new Set(confirmationFields)],
  };
};
