import type { ResearchBriefPatch } from '@theta-agent/domain/research/contracts.js';

export const USER_ASSERTED_RESEARCH_FIELDS = new Set<
  keyof ResearchBriefPatch
>([
  'researchQuestion',
  'collectionMethod',
  'analysisUnit',
  'timeRange',
  'language',
  'comparisonGroups',
  'comparisonIntent',
  'topicGranularity',
  'knownBiases',
  'sensitiveData',
  'successCriteria',
  'hardwareLimit',
  'textFieldIntent',
  'trendAnalysis',
  'offlineOnly',
  'requestedEmbedding',
  'timeLimitHours',
  'interviewComplete',
]);

export const filterUserResearchPatch = (
  patch: ResearchBriefPatch,
): ResearchBriefPatch =>
  Object.fromEntries(
    Object.entries(patch).filter(([field]) =>
      USER_ASSERTED_RESEARCH_FIELDS.has(field as keyof ResearchBriefPatch),
    ),
  ) as ResearchBriefPatch;
