import { createHash } from 'node:crypto';
import {
  LANGUAGE_CONTRACT_VERSION,
  languageResultSchema,
  type LanguageFallbackReason,
  type LanguageRequest,
  type LanguageResult,
  type SafeIntent,
} from '@theta-agent/domain/language/contracts.js';

const reasonDescriptions: Readonly<Record<string, string>> = {
  RUNNABLE_CATALOG_MODEL: 'the model is runnable in the current catalog',
  CALLER_PREFERENCE: 'it matches an explicit caller preference',
  TREND_ANALYSIS_MATCH: 'it supports the requested trend analysis',
  SHORT_TEXT_BTM: 'it is optimized for the confirmed short-text profile',
  COVARIATE_ANALYSIS_STM: 'it can use the confirmed training covariates',
  UNKNOWN_TOPIC_COUNT_HDP: 'it supports exploration when topic count is unknown',
  BASELINE_CLASSICAL_LDA: 'it matches the requested classical bag-of-words baseline',
  SEMANTIC_CLUSTERING_BERTOPIC: 'it matches the semantic clustering objective',
  SHORT_TEXT_MATCH: 'it fits the observed short-text profile',
  COVARIATE_MATCH: 'it can use the confirmed metadata columns',
  AUTO_TOPIC_COUNT_MATCH: 'it supports automatic topic-count exploration',
  BASELINE_GOAL_MATCH: 'it matches the requested baseline objective',
  THETA_NATIVE_MODEL: 'it uses the native THETA execution path',
  EVIDENCE_SUPPORTED: 'local evidence supports the recommendation',
};

export const languageFactsHash = (request: LanguageRequest): string =>
  createHash('sha256').update(stableJson(request)).digest('hex');

export const deterministicLanguageResult = (
  request: LanguageRequest,
  fallbackReason: LanguageFallbackReason = 'provider_not_configured',
): LanguageResult => {
  const factsHash = languageFactsHash(request);
  if (request.task === 'classify_intent') {
    const intent = deterministicIntent(request.sourceText);
    return languageResultSchema.parse({
      schemaVersion: LANGUAGE_CONTRACT_VERSION,
      task: request.task,
      source: 'deterministic',
      intent,
      text: intentDescription(intent),
      fallbackReason,
      factsHash,
    });
  }
  if (request.task === 'word_question') {
    const question = normalizeQuestion(request.draftQuestion);
    return languageResultSchema.parse({
      schemaVersion: LANGUAGE_CONTRACT_VERSION,
      task: request.task,
      source: 'deterministic',
      text: `${question}（用于确认 ${request.field}：${request.reason}）`,
      fallbackReason,
      factsHash,
    });
  }
  const descriptions = request.recommendation.reasonCodes.map(
    (code) => reasonDescriptions[code] ?? `规则 ${code} 已满足`,
  );
  const warnings =
    request.recommendation.warnings.length === 0
      ? '当前没有额外警告。'
      : `仍需注意：${request.recommendation.warnings.join('、')}。`;
  const evidence =
    request.evidence.length === 0
      ? '当前没有可引用的本地证据。'
      : `解释引用了 ${request.evidence.length} 条本地证据。`;
  return languageResultSchema.parse({
    schemaVersion: LANGUAGE_CONTRACT_VERSION,
    task: request.task,
    source: 'deterministic',
    text: [
      `${request.recommendation.modelId} 的确定性得分为 ${request.recommendation.score}，置信度为 ${request.recommendation.confidence}。`,
      `主要依据：${descriptions.join('；')}。`,
      warnings,
      evidence,
    ].join(' '),
    fallbackReason,
    factsHash,
  });
};

const deterministicIntent = (text: string): SafeIntent => {
  const normalized = text.toLowerCase();
  if (/evidence|证据|依据|引用/.test(normalized)) return 'read_evidence';
  if (/why|explain|原因|解释|为什么/.test(normalized)) {
    return 'explain_reason';
  }
  if (/status|progress|状态|进度/.test(normalized)) return 'read_status';
  if (/help|usage|怎么用|帮助|用法/.test(normalized)) return 'request_help';
  return 'unknown';
};

const intentDescription = (intent: SafeIntent): string => {
  const descriptions: Readonly<Record<SafeIntent, string>> = {
    read_status: '识别为只读状态查询；不会执行训练或修改计划。',
    explain_reason: '识别为原因解释请求；只允许解释已验证事实。',
    read_evidence: '识别为证据读取请求；只允许返回受治理的证据引用。',
    request_help: '识别为帮助请求；只返回命令说明。',
    unknown: '无法安全识别意图；未选择任何工具或执行动作。',
  };
  return descriptions[intent];
};

const normalizeQuestion = (value: string): string => {
  const trimmed = value.trim().replace(/[。.!！?？]+$/u, '');
  return `${trimmed}？`;
};

const stableJson = (value: unknown): string => JSON.stringify(sortValue(value));

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
};
