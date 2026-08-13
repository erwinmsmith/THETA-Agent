import type { ResearchAssessment } from './research-service.js';

export interface GrillingDecision {
  kind: 'ready' | 'ask' | 'unresolved';
  activeQuestion?: string;
  candidateQuestions: string[];
}

export const decideResearchGrilling = (
  assessment: ResearchAssessment,
  stateAttempt: number,
): GrillingDecision => {
  if (assessment.gaps.length === 0) {
    return { kind: 'ready', candidateQuestions: [] };
  }
  const candidateQuestions = assessment.questions.map(
    (item) => item.question,
  );
  if (stateAttempt > 8 && assessment.blocking) {
    return {
      kind: 'unresolved',
      activeQuestion: candidateQuestions[0],
      candidateQuestions,
    };
  }
  return {
    kind: 'ask',
    activeQuestion:
      candidateQuestions[0] ??
      'Resolve the remaining blocking research information.',
    candidateQuestions,
  };
};
