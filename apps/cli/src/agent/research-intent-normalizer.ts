import {
  researchIntentSchema,
  type ResearchIntent,
} from '../dataset-understanding/contracts.js';

export type ResearchIntentPatch = Partial<Omit<
  ResearchIntent,
  'schemaVersion' | 'unknowns' | 'resourceBudget'
>> & {
  resourceBudget?: Partial<ResearchIntent['resourceBudget']>;
};

const SECTION_BOUNDARY = /(?:成功标准|什么样的结果|最终需要|交付(?:内容)?|输出(?:内容)?|约束|限制|只使用|使用本地|最多\s*\d+\s*(?:次|组)?实验|不(?:要|允许|下载)|离线(?:运行|执行)?)/iu;
const RESOURCE_BOUNDARY = /(?:使用本地|只使用|使用\s*(?:CPU|GPU)|\bCPU\b|\bGPU\b|最多\s*\d+\s*(?:次|组)?实验|不(?:要|允许)?下载|离线(?:运行|执行)?|内存|显存)/iu;

export const normalizeResearchIntentPatch = (
  patch: ResearchIntentPatch,
  current?: ResearchIntent,
): ResearchIntentPatch => {
  const output: ResearchIntentPatch = { ...patch };
  if (patch.researchQuestion !== undefined) {
    output.researchQuestion = cleanResearchQuestion(patch.researchQuestion);
  }
  if (patch.deliverables !== undefined) {
    output.deliverables = normalizeDeliverables(patch.deliverables);
  }
  if (patch.constraints !== undefined) {
    output.constraints = normalizeConstraints([
      ...(current?.constraints ?? []),
      ...patch.constraints,
    ]);
  }
  if (patch.successCriteria !== undefined) {
    output.successCriteria = cleanList(patch.successCriteria, RESOURCE_BOUNDARY);
  }
  if (patch.comparisonDimensions !== undefined) {
    output.comparisonDimensions = uniqueClean(patch.comparisonDimensions);
  }
  if (patch.focusAreas !== undefined) {
    output.focusAreas = uniqueClean(patch.focusAreas);
  }
  return output;
};

export const normalizeResearchIntent = (intent: ResearchIntent): ResearchIntent =>
  researchIntentSchema.parse({
    ...intent,
    ...normalizeResearchIntentPatch(intent, { ...intent, constraints: [] }),
  });

export const mergeResearchIntentPatches = (
  languagePatch: ResearchIntentPatch,
  explicitPatch: ResearchIntentPatch,
  current: ResearchIntent,
): ResearchIntentPatch => {
  const constraints = uniqueClean([
    ...(languagePatch.constraints ?? []),
    ...(explicitPatch.constraints ?? []),
  ]);
  const resourceBudget = {
    ...(languagePatch.resourceBudget ?? {}),
    ...(explicitPatch.resourceBudget ?? {}),
  };
  return normalizeResearchIntentPatch({
    ...languagePatch,
    ...explicitPatch,
    ...(constraints.length ? { constraints } : {}),
    ...(Object.keys(resourceBudget).length ? { resourceBudget } : {}),
  }, current);
};

const cleanResearchQuestion = (value: string): string => {
  const text = value.trim().replace(/^(?:研究问题|研究目标|我想|希望)[:：]?\s*/u, '').trim();
  const boundary = text.search(SECTION_BOUNDARY);
  const cleaned = (boundary >= 0 ? text.slice(0, boundary) : text)
    .replace(/[；;。，,\s]+$/u, '')
    .trim();
  return cleaned || '探索数据中的主要结构与可解释模式';
};

const normalizeDeliverables = (values: string[]): string[] => cleanList(values, RESOURCE_BOUNDARY)
  .filter((item) => !RESOURCE_BOUNDARY.test(item));

const normalizeConstraints = (values: string[]): string[] => {
  const joined = values.join('；');
  const output: string[] = [];
  if (/\bCPU\b/iu.test(joined)) output.push('使用本地 CPU');
  else if (/\bGPU\b/iu.test(joined)) output.push('使用 GPU');
  if (/不(?:要|允许)?下载|不下载|禁止下载|离线/iu.test(joined)) output.push('不下载远程模型');
  const maxExperiments = joined.match(/最多\s*(\d+)\s*(?:次|组)?实验/u)?.[1];
  if (maxExperiments) output.push(`最多 ${maxExperiments} 次实验`);
  const memory = joined.match(/(?:内存|RAM)\s*(?:上限|限制|为|不超过)?\s*([^，,；;。]{1,20})/iu)?.[1];
  if (memory) output.push(`内存限制 ${memory.trim()}`);
  const vram = joined.match(/显存\s*(?:上限|限制|为|不超过)?\s*([^，,；;。]{1,20})/iu)?.[1];
  if (vram) output.push(`显存限制 ${vram.trim()}`);
  for (const item of cleanList(values)) {
    if (!RESOURCE_BOUNDARY.test(item) && /限制|必须|不得|不能|仅|只/iu.test(item)) output.push(item);
  }
  return uniqueClean(output);
};

const cleanList = (values: string[], boundary?: RegExp): string[] => uniqueClean(
  values.flatMap((value) => value.split(/[，,；;、\n]|以及|并且|同时/u)).map((item) => {
    const index = boundary ? item.search(boundary) : -1;
    return (index >= 0 ? item.slice(0, index) : item).replace(/[。；;，,\s]+$/u, '').trim();
  }),
);

const uniqueClean = (values: string[]): string[] => [...new Set(
  values.map((item) => item.trim()).filter(Boolean),
)].slice(0, 12);
