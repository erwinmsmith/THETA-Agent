import { createHash } from 'node:crypto';
import {
  columnConfirmationSchema,
  datasetProfileSchema,
  researchBriefSchema,
} from '../agent/research-contracts.js';
import {
  recommendationResultSchema,
  type RecommendationResult,
} from '../recommendation/contracts.js';
import {
  evidenceBundleSchema,
  type EvidenceBundle,
} from '../rag/evidence-bundle.js';
import {
  PLANNER_CONTRACT_VERSION,
  plannerInputChangeSchema,
  plannerInputSnapshotSchema,
  type PlannerInputChange,
  type PlannerInputSection,
  type PlannerInputSnapshot,
} from './contracts.js';

export interface PlannerSnapshotInput {
  researchBrief: Record<string, unknown>;
  datasetProfile: Record<string, unknown>;
  columnConfirmation: Record<string, unknown>;
  recommendation: RecommendationResult;
  evidenceBundle: EvidenceBundle;
}

export const sanitizePlannerInput = (
  input: PlannerSnapshotInput,
): PlannerSnapshotInput => {
  const researchBrief = researchBriefSchema.parse(input.researchBrief);
  const datasetProfile = datasetProfileSchema.parse(input.datasetProfile);
  const columnConfirmation = columnConfirmationSchema.parse(
    input.columnConfirmation,
  );
  const recommendation = recommendationResultSchema.parse(input.recommendation);
  const evidenceBundle = evidenceBundleSchema.parse(input.evidenceBundle);
  return {
    researchBrief: cloneRecord(researchBrief),
    datasetProfile: summarizeProfile(datasetProfile),
    columnConfirmation: cloneRecord(columnConfirmation),
    recommendation,
    evidenceBundle: evidenceBundleSchema.parse({
      ...evidenceBundle,
      evidence: evidenceBundle.evidence.slice(0, 18).map((item) => {
        const {
          retrievalRoutes: _routes,
          matchedQueries: _queries,
          ...safe
        } = item;
        return { ...safe, excerpt: item.excerpt.slice(0, 900) };
      }),
    }),
  };
};

export const createPlannerInputSnapshot = (
  input: PlannerSnapshotInput,
): PlannerInputSnapshot => {
  const sectionHashes = {
    researchBriefHash: canonicalHash(input.researchBrief),
    datasetProfileHash: canonicalHash(input.datasetProfile),
    columnConfirmationHash: canonicalHash(input.columnConfirmation),
    recommendationHash: canonicalHash(input.recommendation),
    evidenceBundleHash: canonicalHash(input.evidenceBundle),
  };
  const factsHash = canonicalHash(input);
  return plannerInputSnapshotSchema.parse({
    schemaVersion: PLANNER_CONTRACT_VERSION,
    ...sectionHashes,
    factsHash,
    snapshotHash: canonicalHash({ ...sectionHashes, factsHash }),
  });
};

export const comparePlannerInputSnapshots = (
  previous: PlannerInputSnapshot,
  current: PlannerInputSnapshot,
): PlannerInputChange => {
  const sections: Array<{
    section: PlannerInputSection;
    key: keyof PlannerInputSnapshot;
  }> = [
    { section: 'researchBrief', key: 'researchBriefHash' },
    { section: 'datasetProfile', key: 'datasetProfileHash' },
    { section: 'columnConfirmation', key: 'columnConfirmationHash' },
    { section: 'recommendation', key: 'recommendationHash' },
    { section: 'evidenceBundle', key: 'evidenceBundleHash' },
  ];
  const changedSections = sections
    .filter(({ key }) => previous[key] !== current[key])
    .map(({ section }) => section);
  return plannerInputChangeSchema.parse({
    changed: changedSections.length > 0,
    changedSections,
    previousSnapshotHash: previous.snapshotHash,
    currentSnapshotHash: current.snapshotHash,
    approvalInvalidated: changedSections.length > 0,
  });
};

const canonicalHash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  if (value === undefined) {
    throw new Error('Planner snapshot cannot encode undefined.');
  }
  return JSON.stringify(value);
};

const cloneRecord = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const summarizeProfile = (
  profile: Record<string, unknown>,
): Record<string, unknown> => {
  const allowed = [
    'schemaVersion',
    'datasetSha256',
    'fileName',
    'fileSizeBytes',
    'format',
    'encoding',
    'rowCount',
    'sampledRowCount',
    'profileScope',
    'estimationWarnings',
    'columnCount',
    'missingRatio',
    'duplicateRatio',
    'textLengthDistribution',
    'languageDistribution',
    'columns',
    'timeCoverage',
    'columnCandidates',
    'sensitiveRiskCodes',
    'timeSliceProfile',
    'metadataProfile',
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => key in profile)
      .map((key) => [key, profile[key]]),
  );
};
