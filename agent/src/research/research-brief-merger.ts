import { createHash } from 'node:crypto';
import {
  researchBriefPatchSchema,
  type ResearchBrief,
  type ResearchBriefPatch,
} from '@theta-agent/domain/research/contracts.js';
import { ResearchService } from './research-service.js';
import { filterUserResearchPatch } from './research-field-authority.js';

export interface ResearchBriefMergeResult {
  brief: ResearchBrief;
  patch: ResearchBriefPatch;
  changedFields: string[];
  conflictingFields: string[];
  previousHash: string;
  briefHash: string;
}

export class ResearchBriefMerger {
  constructor(private readonly research = new ResearchService()) {}

  merge(current: ResearchBrief, proposed: unknown): ResearchBriefMergeResult {
    const patch = filterUserResearchPatch(
      researchBriefPatchSchema.parse(proposed),
    );
    const changedFields = Object.keys(patch).filter(
      (field) =>
        stableJson(current[field as keyof ResearchBrief]) !==
        stableJson(patch[field as keyof ResearchBriefPatch]),
    );
    const conflictingFields = changedFields.filter((field) => {
      const previous = current[field as keyof ResearchBrief];
      return !isEmpty(previous);
    });
    const brief = this.research.applyAnswers(current, patch);
    return {
      brief,
      patch,
      changedFields,
      conflictingFields,
      previousHash: hash(current),
      briefHash: hash(brief),
    };
  }
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  value === 'unknown' ||
  (Array.isArray(value) && value.length === 0) ||
  (Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(isEmpty));

const stableJson = (value: unknown): string =>
  JSON.stringify(sortValue(value));

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
};

const hash = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');
