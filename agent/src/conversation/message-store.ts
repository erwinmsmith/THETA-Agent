import type { ResearchBrief, ResearchBriefPatch } from '@theta-agent/domain/research/contracts.js';

export type ConversationRole = 'user' | 'assistant' | 'system' | 'tool';
export type ConversationTurnStatus =
  | 'received'
  | 'interpreted'
  | 'brief_applied'
  | 'fsm_resumed'
  | 'responded'
  | 'failed';

export interface ConversationSession {
  sessionId: string;
  activeRunId?: string;
  providerMode: 'deterministic' | 'provider';
  languageConsent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  messageId: string;
  sessionId: string;
  runId?: string;
  role: ConversationRole;
  messageKind: string;
  content: string;
  sequenceNumber: number;
  createdAt: string;
}

export interface ResearchBriefRevision {
  revisionId: string;
  runId: string;
  sessionId: string;
  parentRevisionId?: string;
  sourceMessageId?: string;
  patch: ResearchBriefPatch;
  brief: ResearchBrief;
  briefHash: string;
  interpretationHash?: string;
  fieldEvidence?: Readonly<
    Record<
      string,
      {
        sourceText: string;
        confidence: number;
        evidenceSpans: string[];
      }
    >
  >;
  createdAt: string;
}

export interface LanguageInterpretationRecord {
  interpretationId: string;
  sessionId: string;
  runId?: string;
  sourceMessageId?: string;
  task: string;
  provider: 'provider' | 'deterministic';
  requestHash: string;
  responseHash: string;
  structuredOutput: unknown;
  status: 'completed' | 'fallback' | 'failed';
  fallbackReason?: string;
  createdAt: string;
}

export interface ConversationTurn {
  turnId: string;
  sessionId: string;
  runId?: string;
  userMessageId: string;
  status: ConversationTurnStatus;
  idempotencyKey: string;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMemory {
  sessionId: string;
  summary: string;
  recentUserGoals: string[];
  sourceMessageCount: number;
  updatedAt: string;
}

export interface ConversationSessionSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
}

export interface ConversationStore {
  getOrCreateSession(
    sessionId: string,
    options?: { activeRunId?: string },
  ): ConversationSession;
  getSession(sessionId: string): ConversationSession | undefined;
  updateSession(
    sessionId: string,
    patch: Partial<
      Pick<ConversationSession, 'providerMode' | 'languageConsent'> & {
        activeRunId: string | null;
      }
    >,
  ): ConversationSession;
  appendMessage(
    input: Omit<ConversationMessage, 'sequenceNumber'>,
  ): ConversationMessage;
  listRecentMessages(sessionId: string, limit: number): ConversationMessage[];
  appendBriefRevision(revision: ResearchBriefRevision): void;
  getLatestBrief(runId: string): ResearchBriefRevision | undefined;
  listBriefRevisions(runId: string): ResearchBriefRevision[];
  recordLanguageInterpretation(record: LanguageInterpretationRecord): void;
  createTurn(turn: ConversationTurn): void;
  updateTurn(
    turnId: string,
    status: ConversationTurnStatus,
    error?: unknown,
  ): void;
  listRecoverableTurns(sessionId: string): ConversationTurn[];
  refreshMemory(sessionId: string): ConversationMemory;
  getMemory(sessionId: string): ConversationMemory | undefined;
  listWorkspaceSessions(limit?: number): ConversationSessionSummary[];
  renameSession(sessionId: string, title: string): ConversationSessionSummary;
  pinSession(sessionId: string, pinned: boolean): ConversationSessionSummary;
  deleteSession(sessionId: string): boolean;
  close(): void;
}
