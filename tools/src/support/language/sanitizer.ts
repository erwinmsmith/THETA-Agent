import type {
  DatasetProfile,
  ResearchBrief,
} from '@theta-agent/domain/research/contracts.js';
import type { EvidenceRef } from '@theta-agent/domain/rag/contracts.js';
import type { ModelRecommendation } from '@theta-agent/domain/recommendation/contracts.js';
import {
  LANGUAGE_CONTRACT_VERSION,
  languageRequestSchema,
  type LanguageRequest,
  type SafeDatasetProfile,
  type SafeEvidenceExcerpt,
  type SafeResearchBrief,
} from '@theta-agent/domain/language/contracts.js';

const windowsPath = /(?:[a-zA-Z]:\\|\\\\)[^\s"'<>]+/g;
const unixPath = /(?:^|\s)\/(?:home|Users|tmp|var|opt|data)\/[^\s"'<>]+/g;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi;
const apiKey = /\b(?:sk-|api[_-]?key[=:]\s*)[A-Za-z0-9._~+/=-]{12,}\b/gi;

export const sanitizeLanguageText = (
  value: string,
  maximum = 1200,
): string =>
  value
    .replace(bearerToken, '[REDACTED_TOKEN]')
    .replace(apiKey, '[REDACTED_API_KEY]')
    .replace(windowsPath, '[LOCAL_PATH]')
    .replace(unixPath, ' [LOCAL_PATH]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);

export const sanitizeResearchBrief = (
  brief: ResearchBrief,
): SafeResearchBrief => ({
  ...(brief.researchQuestion
    ? { researchQuestion: sanitizeLanguageText(brief.researchQuestion) }
    : {}),
  ...(brief.language
    ? { language: sanitizeLanguageText(brief.language, 40) }
    : {}),
  ...(brief.topicGranularity
    ? { topicGranularity: brief.topicGranularity }
    : {}),
  trendAnalysis: brief.trendAnalysis,
  offlineOnly: brief.offlineOnly,
  requestedEmbedding: brief.requestedEmbedding,
  ...(brief.expectedRowCount === undefined
    ? {}
    : { expectedRowCount: brief.expectedRowCount }),
  hardware: {
    device: brief.hardwareLimit.device,
    ...(brief.hardwareLimit.memoryGb === undefined
      ? {}
      : { memoryGb: brief.hardwareLimit.memoryGb }),
  },
});

export const sanitizeDatasetProfile = (
  profile: DatasetProfile,
): SafeDatasetProfile => ({
  format: sanitizeLanguageText(profile.format, 40),
  rowCount: profile.rowCount,
  columnCount: profile.columnCount,
  missingRatio: profile.missingRatio,
  duplicateRatio: profile.duplicateRatio,
  averageTextLength: profile.textLengthDistribution.average,
  maximumTextLength: profile.textLengthDistribution.maximum,
  languageDistribution: profile.languageDistribution.slice(0, 10).map(
    (item) => ({
      language: sanitizeLanguageText(item.language, 40),
      ratio: item.ratio,
    }),
  ),
});

export const sanitizeEvidence = (
  evidence: readonly EvidenceRef[],
): SafeEvidenceExcerpt[] =>
  evidence.slice(0, 5).map((item) => ({
    evidenceId: sanitizeLanguageText(item.evidenceId, 160),
    authority: item.authority,
    excerpt: sanitizeLanguageText(item.excerpt),
  }));

export const createRecommendationExplanationRequest = (input: {
  recommendation: ModelRecommendation;
  researchBrief?: ResearchBrief;
  datasetProfile?: DatasetProfile;
  evidence?: EvidenceRef[];
}): LanguageRequest =>
  languageRequestSchema.parse({
    schemaVersion: LANGUAGE_CONTRACT_VERSION,
    task: 'explain_recommendation',
    recommendation: {
      modelId: sanitizeLanguageText(input.recommendation.modelId, 120),
      score: input.recommendation.score,
      confidence: input.recommendation.confidence,
      reasonCodes: input.recommendation.reasonCodes.map((code) =>
        sanitizeLanguageText(code, 120),
      ),
      warnings: input.recommendation.warnings.map((warning) =>
        sanitizeLanguageText(warning, 120),
      ),
    },
    ...(input.researchBrief
      ? { researchBrief: sanitizeResearchBrief(input.researchBrief) }
      : {}),
    ...(input.datasetProfile
      ? { datasetProfile: sanitizeDatasetProfile(input.datasetProfile) }
      : {}),
    evidence: sanitizeEvidence(input.evidence ?? []),
  });

export const sanitizeLanguageRequest = (
  input: LanguageRequest,
): LanguageRequest => {
  const parsed = languageRequestSchema.parse(input);
  if (parsed.task === 'classify_intent') {
    return languageRequestSchema.parse({
      ...parsed,
      sourceText: sanitizeLanguageText(parsed.sourceText),
    });
  }
  if (parsed.task === 'word_question') {
    return languageRequestSchema.parse({
      ...parsed,
      field: sanitizeLanguageText(parsed.field, 120),
      reason: sanitizeLanguageText(parsed.reason),
      draftQuestion: sanitizeLanguageText(parsed.draftQuestion),
    });
  }
  return languageRequestSchema.parse({
    ...parsed,
    recommendation: {
      ...parsed.recommendation,
      modelId: sanitizeLanguageText(parsed.recommendation.modelId, 120),
      reasonCodes: parsed.recommendation.reasonCodes.map((code) =>
        sanitizeLanguageText(code, 120),
      ),
      warnings: parsed.recommendation.warnings.map((warning) =>
        sanitizeLanguageText(warning, 120),
      ),
    },
    evidence: parsed.evidence.map((item) => ({
      ...item,
      evidenceId: sanitizeLanguageText(item.evidenceId, 160),
      excerpt: sanitizeLanguageText(item.excerpt),
    })),
  });
};
