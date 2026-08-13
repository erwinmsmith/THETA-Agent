import { detectResearchConflicts } from './conflict-rules.js';
import { detectResearchGaps } from './gap-rules.js';
import { planResearchQuestions } from './question-planner.js';
import {
  RESEARCH_CONTRACT_VERSION,
  researchBriefPatchSchema,
  researchBriefSchema,
  type DatasetProfile,
  type InformationGap,
  type PlannedQuestion,
  type ResearchBrief,
  type ResearchBriefPatch,
  type ResearchConflict,
} from './research-contracts.js';

export interface ResearchIntakeInput {
  filePath: string;
  researchGoal?: string;
  research?: unknown;
}

export interface ResearchAssessment {
  brief: ResearchBrief;
  gaps: InformationGap[];
  conflicts: ResearchConflict[];
  questions: PlannedQuestion[];
  blocking: boolean;
}

export class ResearchService {
  createBrief(input: ResearchIntakeInput): ResearchBrief {
    const research = isRecord(input.research)
      ? researchBriefPatchSchema.parse(input.research)
      : {};
    return this.finalize({
      ...research,
      researchQuestion: research.researchQuestion ?? input.researchGoal,
      dataSources:
        research.dataSources && research.dataSources.length > 0
          ? research.dataSources
          : [input.filePath],
    });
  }

  applyAnswers(
    current: ResearchBrief,
    answers: unknown,
  ): ResearchBrief {
    const patch = researchBriefPatchSchema.parse(answers);
    return this.finalize({
      ...current,
      ...patch,
      timeRange:
        patch.timeRange === undefined
          ? current.timeRange
          : { ...current.timeRange, ...patch.timeRange },
      sensitiveData:
        patch.sensitiveData === undefined
          ? current.sensitiveData
          : { ...current.sensitiveData, ...patch.sensitiveData },
      hardwareLimit:
        patch.hardwareLimit === undefined
          ? current.hardwareLimit
          : { ...current.hardwareLimit, ...patch.hardwareLimit },
    });
  }

  assess(
    brief: ResearchBrief,
    options: {
      currentState?: string;
      askedCounts?: Readonly<Record<string, number>>;
      recentlyAskedGapId?: string;
      datasetProfile?: DatasetProfile;
    } = {},
  ): ResearchAssessment {
    const conflicts = detectResearchConflicts(brief);
    const conflictGaps: InformationGap[] = conflicts
      .filter((item) => item.severity === 'blocking')
      .map((item) => ({
        id: `gap.${item.id}`,
        field: item.fields.join(','),
        severity: 'blocking',
        question: item.resolution,
        reason: item.message,
        informationGain: 100,
      }));
    const gaps = uniqueById([...detectResearchGaps(brief), ...conflictGaps]);
    const questions = planResearchQuestions(gaps, {
      currentState: options.currentState ?? 'ResearchIntake',
      askedCounts: options.askedCounts,
      recentlyAskedGapId: options.recentlyAskedGapId,
      datasetProfile: options.datasetProfile,
    });
    return {
      brief: this.finalize({
        ...brief,
        unknownFields: gaps.map((item) => item.field),
      }),
      gaps,
      conflicts,
      questions,
      blocking: gaps.some((item) => item.severity === 'blocking'),
    };
  }

  private finalize(value: Record<string, unknown>): ResearchBrief {
    return researchBriefSchema.parse({
      ...value,
      schemaVersion: RESEARCH_CONTRACT_VERSION,
    });
  }
}

const uniqueById = <T extends { id: string }>(values: T[]): T[] => {
  const byId = new Map<string, T>();
  for (const value of values) byId.set(value.id, value);
  return [...byId.values()];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const parseResearchAnswers = (value: unknown): ResearchBriefPatch =>
  researchBriefPatchSchema.parse(value);
