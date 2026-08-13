import { z } from 'zod';

const modelIds = [
  'bertopic',
  'btm',
  'ctm',
  'dtm',
  'etm',
  'gsm',
  'hdp',
  'lda',
  'nvdm',
  'prodlda',
  'stm',
  'theta',
  'top2vec',
  'topicbert',
] as const;

export const planAdjustmentIntentSchema = z
  .object({
    parameter: z.enum([
      'numTopics',
      'model',
      'seed',
      'iterations',
      'covariates',
    ]),
    operation: z.enum(['set', 'increase', 'decrease', 'replace']),
    oldValue: z.unknown().optional(),
    newValue: z.unknown(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type PlanAdjustmentIntent = z.infer<
  typeof planAdjustmentIntentSchema
>;

export interface CurrentPlanAdjustmentValues {
  numTopics?: number | null;
  model?: string;
  seed?: number;
  iterations?: number;
  covariates?: string[];
  experimentProtocol?: Record<string, unknown>;
}

export interface ParsedPlanAdjustment {
  patch: Record<string, unknown>;
  intents: PlanAdjustmentIntent[];
  clarificationReasons: string[];
}

interface NumericParameterSpec {
  parameter: 'numTopics' | 'iterations';
  labels: string;
  units: string;
  minimum: number;
  maximum: number;
}

const numericSpecs: NumericParameterSpec[] = [
  {
    parameter: 'numTopics',
    labels: '(?:主题(?:数|数量)?|topics?)',
    units: '(?:个)?',
    minimum: 2,
    maximum: 200,
  },
  {
    parameter: 'iterations',
    labels: '(?:迭代(?:次数)?|训练轮次|epochs?)',
    units: '(?:次|轮)?',
    minimum: 1,
    maximum: 10_000_000,
  },
];

export const parsePlanAdjustmentRequest = (
  input: string,
  current: CurrentPlanAdjustmentValues = {},
): ParsedPlanAdjustment => {
  const text = input.trim();
  const patch: Record<string, unknown> = {};
  const intents: PlanAdjustmentIntent[] = [];
  const clarificationReasons: string[] = [];

  for (const spec of numericSpecs) {
    const parsed = parseNumericIntent(text, spec);
    if (!parsed) continue;
    if ('reason' in parsed) {
      clarificationReasons.push(parsed.reason);
      continue;
    }
    const resolved = resolveNumericIntent(parsed, current, spec);
    if ('reason' in resolved) {
      clarificationReasons.push(resolved.reason);
      continue;
    }
    intents.push(resolved.intent);
    if (spec.parameter === 'numTopics') {
      patch.topicCountMode = 'fixed';
      patch.numTopics = resolved.value;
    } else {
      patch.epochs = resolved.value;
    }
  }

  const baselineModelMatch =
    text.match(
      /(?:用|以)?\s*\b(BTM|LDA|HDP|DTM|STM|CTM|BERTopic|THETA)\b\s*(?:作为|做|当)?\s*(?:基线|对照)/iu,
    ) ??
    text.match(
      /(?:基线|对照)(?:模型)?[^a-z0-9]{0,8}\b(BTM|LDA|HDP|DTM|STM|CTM|BERTopic|THETA)\b/iu,
    );
  const baselineModel = baselineModelMatch?.[1]?.toLowerCase();
  const modelIntent = baselineModel ? undefined : parseModelIntent(text);
  if (modelIntent) {
    const currentModel = current.model?.toLowerCase();
    const oldModel =
      typeof modelIntent.oldValue === 'string'
        ? modelIntent.oldValue.toLowerCase()
        : undefined;
    if (oldModel && currentModel && oldModel !== currentModel) {
      clarificationReasons.push(
        `当前模型是 ${currentModel.toUpperCase()}，不是你写的 ${oldModel.toUpperCase()}。请确认最终要改为 ${String(modelIntent.newValue).toUpperCase()}。`,
      );
    } else {
      intents.push(modelIntent);
      patch.modelId = String(modelIntent.newValue).toLowerCase();
    }
  }

  const covariateIntent = parseCovariateIntent(text);
  if (covariateIntent) {
    intents.push(covariateIntent);
    patch.covariateColumns = covariateIntent.newValue;
  }

  const maxTopics = parseExplicitNumber(
    text,
    '(?:最大主题数|主题上限|max(?:imum)?\\s*topics?)',
  );
  if (maxTopics !== undefined) patch.maxTopics = maxTopics;
  const batchSize = parseExplicitNumber(
    text,
    '(?:批大小|batch(?:\\s*size)?)',
  );
  if (batchSize !== undefined) patch.batchSize = batchSize;

  const seedIntent = parseSeedIntent(text);
  const seedValues = [
    ...text.matchAll(/(?:随机种子|种子|seeds?)[^\d]{0,8}([\d、，,\s/]+)/giu),
  ]
    .flatMap((match) => (match[1]?.match(/\d+/gu) ?? []).map(Number))
    .filter(
      (value, index, values) =>
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 2_147_483_647 &&
        values.indexOf(value) === index,
    );
  if (seedIntent) {
    const resolved = resolveSeedIntent(seedIntent, current);
    if ('reason' in resolved) {
      clarificationReasons.push(resolved.reason);
    } else {
      intents.push(resolved.intent);
      patch.experimentProtocol = protocolWithPrimarySeed(
        current.experimentProtocol,
        resolved.value,
      );
    }
  }

  const quickRequested =
    /(?:只|仅)?(?:运行|训练)?一次|单次(?:快速)?运行|quick\s*run|取消基线|移除基线|不要基线/iu.test(
      text,
    );
  const stabilityRequested =
    /稳定性|复验|多(?:随机)?种子|stability/iu.test(text);
  if (quickRequested) {
    patch.experimentProtocol = {
      mode: 'quick',
      primarySeeds: [seedValues.at(-1) ?? current.seed ?? 42],
      baselineModelId: null,
      baselineSeeds: [],
      rationale: '用户要求先执行一次主模型快速运行。',
      evidenceRefs: [],
      confidence: 'high',
    };
  } else if (baselineModel) {
    patch.experimentProtocol = {
      mode: 'comparative',
      primarySeeds: [seedValues[0] ?? current.seed ?? 42],
      baselineModelId: baselineModel,
      baselineSeeds: [seedValues[1] ?? seedValues[0] ?? current.seed ?? 42],
      rationale: `用户要求将 ${baselineModel.toUpperCase()} 作为对照模型。`,
      evidenceRefs: [],
      confidence: 'high',
    };
  } else if (stabilityRequested) {
    patch.experimentProtocol = {
      mode: 'stability',
      primarySeeds:
        seedValues.length >= 3 ? seedValues.slice(0, 5) : [17, 42, 73],
      baselineModelId: null,
      baselineSeeds: [],
      rationale: '用户要求使用多个随机种子复验主模型稳定性。',
      evidenceRefs: [],
      confidence: 'high',
    };
  }

  if (/自动主题|自动决定主题|auto(?:matic)?\s*topics?/iu.test(text)) {
    patch.topicCountMode = 'auto';
    patch.numTopics = null;
  }
  if (patch.modelId === 'hdp') {
    patch.topicCountMode = 'auto';
    patch.numTopics = null;
  }
  if (patch.modelId === 'bertopic' && patch.numTopics === undefined) {
    patch.topicCountMode = 'auto';
    patch.numTopics = null;
  } else if (patch.modelId === 'bertopic') {
    patch.topicCountMode = 'target_reduction';
  }
  if (/监督/iu.test(text) && !/无监督/iu.test(text)) {
    patch.mode = 'supervised';
  } else if (/无监督/iu.test(text)) {
    patch.mode = 'unsupervised';
  }

  if (clarificationReasons.length > 0) {
    return { patch: {}, intents, clarificationReasons };
  }
  if (Object.keys(patch).length === 0) {
    clarificationReasons.push(
      '没有识别出明确的最终调整值。请说明“主题数改为 8”“迭代次数从 1000 改到 1500”或“将模型改为 DTM”。',
    );
  }
  return { patch, intents, clarificationReasons };
};

export const parsePlanAdjustment = (
  input: string,
  current: CurrentPlanAdjustmentValues = {},
): Record<string, unknown> => {
  const parsed = parsePlanAdjustmentRequest(input, current);
  if (parsed.clarificationReasons.length > 0) {
    throw new Error(parsed.clarificationReasons.join(' '));
  }
  return parsed.patch;
};

const parseNumericIntent = (
  text: string,
  spec: NumericParameterSpec,
): PlanAdjustmentIntent | { reason: string } | undefined => {
  const source =
    spec.parameter === 'numTopics'
      ? text.replace(
          /(?:最大主题数|主题上限|max(?:imum)?\s*topics?)\s*(?:改为|改成|改到|设为|设置为|调整到|调整为)\s*\d+/giu,
          '',
        )
      : text;
  const labelFirst = new RegExp(
    `${spec.labels}\\s*(?:从|由)?\\s*(\\d+)\\s*${spec.units}\\s*(?:改为|改成|改到|调整到|调整为|变为|增加到|提升到|减少到|减少为|降低到)\\s*(\\d+)`,
    'iu',
  );
  const valueFirst = new RegExp(
    `(?:把|将)?\\s*(\\d+)\\s*${spec.units}\\s*${spec.labels}\\s*(?:改为|改成|改到|调整到|调整为|变为|增加到|提升到|减少到|减少为|降低到)\\s*(\\d+)`,
    'iu',
  );
  const replacement = source.match(labelFirst) ?? source.match(valueFirst);
  if (replacement) {
    return planAdjustmentIntentSchema.parse({
      parameter: spec.parameter,
      operation: 'replace',
      oldValue: Number(replacement[1]),
      newValue: Number(replacement[2]),
      confidence: 1,
    });
  }

  const direct = source.match(
    new RegExp(
      `${spec.labels}\\s*(?:改为|改成|改到|设为|设置为|调整到|调整为|增加到|提升到|减少到|减少为|降低到)\\s*(\\d+)`,
      'iu',
    ),
  );
  if (direct) {
    return planAdjustmentIntentSchema.parse({
      parameter: spec.parameter,
      operation: 'set',
      newValue: Number(direct[1]),
      confidence: 1,
    });
  }

  const delta =
    source.match(
      new RegExp(
        `${spec.labels}\\s*(增加|新增|提高|提升|减少|降低)\\s*(\\d+)`,
        'iu',
      ),
    ) ??
    source.match(
      new RegExp(
        `(增加|新增|提高|提升|减少|降低)\\s*(\\d+)\\s*${spec.units}\\s*${spec.labels}`,
        'iu',
      ),
    );
  if (delta) {
    return planAdjustmentIntentSchema.parse({
      parameter: spec.parameter,
      operation: /减少|降低/u.test(delta[1]) ? 'decrease' : 'increase',
      newValue: Number(delta[2]),
      confidence: 0.98,
    });
  }

  const mentionsParameter = new RegExp(spec.labels, 'iu').test(source);
  const numbers = source.match(/\d+/gu) ?? [];
  if (mentionsParameter && numbers.length > 0) {
    return {
      reason: `${parameterLabel(spec.parameter)}调整包含数字，但没有明确“改为/调整到/增加/减少”的关系。请明确最终目标值。`,
    };
  }
  return undefined;
};

const resolveNumericIntent = (
  intent: PlanAdjustmentIntent,
  current: CurrentPlanAdjustmentValues,
  spec: NumericParameterSpec,
): { intent: PlanAdjustmentIntent; value: number } | { reason: string } => {
  const currentValue = current[spec.parameter];
  const oldValue = number(intent.oldValue);
  if (oldValue !== undefined && currentValue != null && oldValue !== currentValue) {
    return {
      reason: `当前${parameterLabel(spec.parameter)}是 ${currentValue}，不是你写的 ${oldValue}。请确认最终目标值。`,
    };
  }
  const requested = number(intent.newValue);
  if (requested === undefined) {
    return { reason: `${parameterLabel(spec.parameter)}必须是整数。` };
  }
  let value = requested;
  if (intent.operation === 'increase' || intent.operation === 'decrease') {
    if (currentValue == null) {
      return {
        reason: `当前${parameterLabel(spec.parameter)}不可用，无法计算相对调整。请直接说明最终目标值。`,
      };
    }
    value =
      intent.operation === 'increase'
        ? currentValue + requested
        : currentValue - requested;
  }
  if (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum) {
    return {
      reason: `${parameterLabel(spec.parameter)}最终值必须是 ${spec.minimum} 到 ${spec.maximum} 之间的整数。`,
    };
  }
  return { intent: { ...intent, newValue: value }, value };
};

const parseModelIntent = (text: string): PlanAdjustmentIntent | undefined => {
  const modelPattern = modelIds.join('|');
  const replacement = text.match(
    new RegExp(
      `(?:模型)?\\s*(?:从|由)\\s*\\b(${modelPattern})\\b\\s*(?:改为|改成|改到|调整到|调整为|替换为)\\s*\\b(${modelPattern})\\b`,
      'iu',
    ),
  );
  if (replacement) {
    return planAdjustmentIntentSchema.parse({
      parameter: 'model',
      operation: 'replace',
      oldValue: replacement[1].toLowerCase(),
      newValue: replacement[2].toLowerCase(),
      confidence: 1,
    });
  }
  const direct = text.match(
    new RegExp(
      `(?:模型)?\\s*(?:改为|改成|改到|设为|设置为|调整到|调整为|替换为|使用|采用)\\s*\\b(${modelPattern})\\b`,
      'iu',
    ),
  );
  if (!direct) return undefined;
  return planAdjustmentIntentSchema.parse({
    parameter: 'model',
    operation: 'set',
    newValue: direct[1].toLowerCase(),
    confidence: 1,
  });
};

const parseSeedIntent = (text: string): PlanAdjustmentIntent | undefined => {
  const replacement = text.match(
    /(?:随机种子|种子|seed)\s*(?:从|由)\s*(\d+)\s*(?:改为|改成|改到|调整到|调整为)\s*(\d+)/iu,
  );
  if (replacement) {
    return planAdjustmentIntentSchema.parse({
      parameter: 'seed',
      operation: 'replace',
      oldValue: Number(replacement[1]),
      newValue: Number(replacement[2]),
      confidence: 1,
    });
  }
  const direct = text.match(
    /(?:随机种子|种子|seed)\s*(?:改为|改成|改到|设为|设置为|调整到|调整为)\s*(\d+)/iu,
  );
  if (!direct) return undefined;
  return planAdjustmentIntentSchema.parse({
    parameter: 'seed',
    operation: 'set',
    newValue: Number(direct[1]),
    confidence: 1,
  });
};

const resolveSeedIntent = (
  intent: PlanAdjustmentIntent,
  current: CurrentPlanAdjustmentValues,
): { intent: PlanAdjustmentIntent; value: number } | { reason: string } => {
  if (
    current.experimentProtocol?.mode !== undefined &&
    current.experimentProtocol.mode !== 'quick'
  ) {
    return {
      reason: '当前是多运行实验设计。请明确说明“只运行一次，种子 42”或重新给出全部稳定性/对照种子。',
    };
  }
  const oldValue = number(intent.oldValue);
  if (oldValue !== undefined && current.seed !== undefined && oldValue !== current.seed) {
    return {
      reason: `当前主运行种子是 ${current.seed}，不是你写的 ${oldValue}。请确认最终目标值。`,
    };
  }
  const value = number(intent.newValue);
  if (value === undefined || value < 0 || value > 2_147_483_647) {
    return { reason: '随机种子必须是 0 到 2147483647 之间的整数。' };
  }
  return { intent, value };
};

const parseCovariateIntent = (
  text: string,
): PlanAdjustmentIntent | undefined => {
  const match = text.match(
    /(?:协变量|covariates?)\s*(?:改为|改成|设为|设置为|调整为|使用)\s*([^；;。]+)/iu,
  );
  if (!match) return undefined;
  const values = match[1]
    .split(/[、，,\s]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  return planAdjustmentIntentSchema.parse({
    parameter: 'covariates',
    operation: 'set',
    newValue: [...new Set(values)],
    confidence: 0.98,
  });
};

const protocolWithPrimarySeed = (
  current: Record<string, unknown> | undefined,
  seed: number,
): Record<string, unknown> => ({
  mode: current?.mode ?? 'quick',
  primarySeeds: [seed],
  baselineModelId: current?.baselineModelId ?? null,
  baselineSeeds: Array.isArray(current?.baselineSeeds)
    ? current.baselineSeeds
    : [],
  rationale: '用户明确调整主模型随机种子。',
  evidenceRefs: Array.isArray(current?.evidenceRefs) ? current.evidenceRefs : [],
  confidence: 'high',
});

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

const parseExplicitNumber = (
  text: string,
  labelPattern: string,
): number | undefined => {
  const match = text.match(
    new RegExp(
      `${labelPattern}\\s*(?:改为|改成|改到|设为|设置为|调整到|调整为)\\s*(\\d+)`,
      'iu',
    ),
  );
  return match ? Number(match[1]) : undefined;
};

const parameterLabel = (
  parameter: PlanAdjustmentIntent['parameter'],
): string =>
  ({
    numTopics: '主题数',
    model: '模型',
    seed: '随机种子',
    iterations: '迭代次数',
    covariates: '协变量',
  })[parameter];
