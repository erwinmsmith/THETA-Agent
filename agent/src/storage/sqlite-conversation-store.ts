import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ConversationMessage,
  ConversationMemory,
  ConversationSession,
  ConversationSessionSummary,
  ConversationStore,
  ConversationTurn,
  ConversationTurnStatus,
  LanguageInterpretationRecord,
  ResearchBriefRevision,
} from '../conversation/message-store.js';

export class SQLiteConversationStore implements ConversationStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  getOrCreateSession(
    sessionId: string,
    options: { activeRunId?: string } = {},
  ): ConversationSession {
    const existing = this.getSession(sessionId);
    if (existing) {
      return options.activeRunId
        ? this.updateSession(sessionId, { activeRunId: options.activeRunId })
        : existing;
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO theta_conversation_sessions
         (session_id, active_run_id, provider_mode, language_consent, created_at, updated_at)
         VALUES (?, ?, 'deterministic', 0, ?, ?)`,
      )
      .run(sessionId, options.activeRunId ?? null, now, now);
    return this.requiredSession(sessionId);
  }

  getSession(sessionId: string): ConversationSession | undefined {
    const row = this.database
      .prepare(
        `SELECT session_id, active_run_id, provider_mode, language_consent,
                created_at, updated_at
           FROM theta_conversation_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as Row | undefined;
    return row ? session(row) : undefined;
  }

  updateSession(
    sessionId: string,
    patch: Partial<
      Pick<ConversationSession, 'providerMode' | 'languageConsent'> & {
        activeRunId: string | null;
      }
    >,
  ): ConversationSession {
    const current = this.requiredSession(sessionId);
    const next = {
      activeRunId:
        patch.activeRunId === undefined
          ? current.activeRunId
          : (patch.activeRunId ?? undefined),
      providerMode: patch.providerMode ?? current.providerMode,
      languageConsent: patch.languageConsent ?? current.languageConsent,
    };
    this.database
      .prepare(
        `UPDATE theta_conversation_sessions
            SET active_run_id = ?, provider_mode = ?, language_consent = ?,
                updated_at = ?
          WHERE session_id = ?`,
      )
      .run(
        next.activeRunId ?? null,
        next.providerMode,
        next.languageConsent ? 1 : 0,
        new Date().toISOString(),
        sessionId,
      );
    return this.requiredSession(sessionId);
  }

  appendMessage(
    input: Omit<ConversationMessage, 'sequenceNumber'>,
  ): ConversationMessage {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
           FROM theta_conversation_messages WHERE session_id = ?`,
      )
      .get(input.sessionId) as Row;
    const sequenceNumber = number(row.next_sequence);
    this.database
      .prepare(
        `INSERT INTO theta_conversation_messages
         (message_id, session_id, run_id, role, message_kind, content,
          sequence_number, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.messageId,
        input.sessionId,
        input.runId ?? null,
        input.role,
        input.messageKind,
        input.content,
        sequenceNumber,
        input.createdAt,
      );
    return { ...input, sequenceNumber };
  }

  listRecentMessages(
    sessionId: string,
    limit: number,
  ): ConversationMessage[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.database
      .prepare(
        `SELECT * FROM (
           SELECT message_id, session_id, run_id, role, message_kind, content,
                  sequence_number, created_at
             FROM theta_conversation_messages
            WHERE session_id = ?
            ORDER BY sequence_number DESC LIMIT ?
         ) ORDER BY sequence_number ASC`,
      )
      .all(sessionId, safeLimit) as Row[];
    return rows.map(message);
  }

  appendBriefRevision(revision: ResearchBriefRevision): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO theta_research_brief_revisions
         (revision_id, run_id, session_id, parent_revision_id,
          source_message_id, patch_json, brief_snapshot_json, brief_hash,
          interpretation_hash, field_evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.revisionId,
        revision.runId,
        revision.sessionId,
        revision.parentRevisionId ?? null,
        revision.sourceMessageId ?? null,
        JSON.stringify(revision.patch),
        JSON.stringify(revision.brief),
        revision.briefHash,
        revision.interpretationHash ?? null,
        revision.fieldEvidence === undefined
          ? null
          : JSON.stringify(revision.fieldEvidence),
        revision.createdAt,
      );
  }

  getLatestBrief(runId: string): ResearchBriefRevision | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM theta_research_brief_revisions
          WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(runId) as Row | undefined;
    return row ? revision(row) : undefined;
  }

  listBriefRevisions(runId: string): ResearchBriefRevision[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM theta_research_brief_revisions
            WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
        )
        .all(runId) as Row[]
    ).map(revision);
  }

  recordLanguageInterpretation(record: LanguageInterpretationRecord): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO theta_language_interpretations
         (interpretation_id, session_id, run_id, source_message_id, task,
          provider, request_hash, response_hash, structured_output_json,
          status, fallback_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.interpretationId,
        record.sessionId,
        record.runId ?? null,
        record.sourceMessageId ?? null,
        record.task,
        record.provider,
        record.requestHash,
        record.responseHash,
        JSON.stringify(record.structuredOutput),
        record.status,
        record.fallbackReason ?? null,
        record.createdAt,
      );
  }

  createTurn(turn: ConversationTurn): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO theta_conversation_turns
         (turn_id, session_id, run_id, user_message_id, status,
          idempotency_key, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.turnId,
        turn.sessionId,
        turn.runId ?? null,
        turn.userMessageId,
        turn.status,
        turn.idempotencyKey,
        turn.error === undefined ? null : JSON.stringify(turn.error),
        turn.createdAt,
        turn.updatedAt,
      );
  }

  updateTurn(
    turnId: string,
    status: ConversationTurnStatus,
    error?: unknown,
  ): void {
    this.database
      .prepare(
        `UPDATE theta_conversation_turns
            SET status = ?, error_json = ?, updated_at = ?
          WHERE turn_id = ?`,
      )
      .run(
        status,
        error === undefined ? null : JSON.stringify(error),
        new Date().toISOString(),
        turnId,
      );
  }

  listRecoverableTurns(sessionId: string): ConversationTurn[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM theta_conversation_turns
            WHERE session_id = ?
              AND status NOT IN ('responded', 'failed')
            ORDER BY created_at ASC`,
        )
        .all(sessionId) as Row[]
    ).map(turn);
  }

  refreshMemory(sessionId: string): ConversationMemory {
    const messages = this.listRecentMessages(sessionId, 100);
    const recentUserGoals = messages
      .filter((item) => item.role === 'user')
      .slice(-8)
      .map((item) => item.content.replace(/\s+/gu, ' ').trim().slice(0, 280))
      .filter(Boolean);
    const summary = recentUserGoals.length > 0
      ? recentUserGoals.slice(-4).join(' / ')
      : 'No durable user goal has been recorded yet.';
    const updatedAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO theta_conversation_memory
         (session_id, summary, recent_user_goals_json, source_message_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           summary = excluded.summary,
           recent_user_goals_json = excluded.recent_user_goals_json,
           source_message_count = excluded.source_message_count,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, summary, JSON.stringify(recentUserGoals), messages.length, updatedAt);
    return { sessionId, summary, recentUserGoals, sourceMessageCount: messages.length, updatedAt };
  }

  getMemory(sessionId: string): ConversationMemory | undefined {
    const row = this.database
      .prepare(
        `SELECT session_id, summary, recent_user_goals_json,
                source_message_count, updated_at
           FROM theta_conversation_memory WHERE session_id = ?`,
      )
      .get(sessionId) as Row | undefined;
    return row
      ? {
          sessionId: string(row.session_id),
          summary: string(row.summary),
          recentUserGoals: JSON.parse(string(row.recent_user_goals_json)) as string[],
          sourceMessageCount: number(row.source_message_count),
          updatedAt: string(row.updated_at),
        }
      : undefined;
  }

  listWorkspaceSessions(limit = 50): ConversationSessionSummary[] {
    const rows = this.database
      .prepare(
        `SELECT s.session_id, COALESCE(s.title, 'New conversation') AS title,
                COALESCE(s.pinned, 0) AS pinned,
                s.created_at, s.updated_at, COUNT(m.message_id) AS message_count
           FROM theta_conversation_sessions s
           LEFT JOIN theta_conversation_messages m ON m.session_id = s.session_id
          WHERE s.session_id LIKE 'theta-web-workspace-%'
          GROUP BY s.session_id
         HAVING COUNT(m.message_id) > 0
          ORDER BY COALESCE(s.pinned, 0) DESC, s.updated_at DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(100, Math.trunc(limit)))) as Row[];
    return rows.map(sessionSummary);
  }

  renameSession(sessionId: string, title: string): ConversationSessionSummary {
    const normalized = title.replace(/\s+/gu, ' ').trim().slice(0, 120);
    if (!normalized) throw new Error('Conversation title cannot be empty.');
    const updatedAt = new Date().toISOString();
    const result = this.database
      .prepare('UPDATE theta_conversation_sessions SET title = ?, updated_at = ? WHERE session_id = ?')
      .run(normalized, updatedAt, sessionId);
    if (Number(result.changes) === 0) throw new Error(`Conversation session not found: ${sessionId}`);
    const summary = this.listWorkspaceSessions(100).find((item) => item.sessionId === sessionId);
    return summary ?? { sessionId, title: normalized, messageCount: 0, createdAt: updatedAt, updatedAt, pinned: false };
  }

  pinSession(sessionId: string, pinned: boolean): ConversationSessionSummary {
    const updatedAt = new Date().toISOString();
    const result = this.database
      .prepare('UPDATE theta_conversation_sessions SET pinned = ?, updated_at = ? WHERE session_id = ?')
      .run(pinned ? 1 : 0, updatedAt, sessionId);
    if (Number(result.changes) === 0) throw new Error(`Conversation session not found: ${sessionId}`);
    const summary = this.listWorkspaceSessions(100).find((item) => item.sessionId === sessionId);
    if (!summary) throw new Error(`Conversation session not found: ${sessionId}`);
    return summary;
  }

  deleteSession(sessionId: string): boolean {
    if (!sessionId.startsWith('theta-web-workspace-')) return false;
    const exists = Boolean(this.getSession(sessionId));
    if (!exists) return false;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM theta_conversation_memory WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM theta_conversation_turns WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM theta_language_interpretations WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM theta_conversation_messages WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM theta_conversation_sessions WHERE session_id = ?').run(sessionId);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private requiredSession(sessionId: string): ConversationSession {
    const value = this.getSession(sessionId);
    if (!value) throw new Error(`Conversation session not found: ${sessionId}`);
    return value;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_conversation_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS theta_conversation_sessions (
        session_id TEXT PRIMARY KEY,
        active_run_id TEXT,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        provider_mode TEXT NOT NULL,
        language_consent INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS theta_conversation_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        role TEXT NOT NULL,
        message_kind TEXT NOT NULL,
        content TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id)
          REFERENCES theta_conversation_sessions(session_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS theta_message_sequence
        ON theta_conversation_messages(session_id, sequence_number);
      CREATE TABLE IF NOT EXISTS theta_research_brief_revisions (
        revision_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_revision_id TEXT,
        source_message_id TEXT,
        patch_json TEXT NOT NULL,
        brief_snapshot_json TEXT NOT NULL,
        brief_hash TEXT NOT NULL,
        interpretation_hash TEXT,
        field_evidence_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS theta_brief_run
        ON theta_research_brief_revisions(run_id, created_at);
      CREATE TABLE IF NOT EXISTS theta_language_interpretations (
        interpretation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        source_message_id TEXT,
        task TEXT NOT NULL,
        provider TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_hash TEXT NOT NULL,
        structured_output_json TEXT,
        status TEXT NOT NULL,
        fallback_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS theta_conversation_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        user_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS theta_conversation_memory (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        recent_user_goals_json TEXT NOT NULL,
        source_message_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id)
          REFERENCES theta_conversation_sessions(session_id)
      );
      INSERT OR IGNORE INTO theta_conversation_migrations(version, applied_at)
      VALUES (1, datetime('now'));
    `);
    const revisionColumns = this.database
      .prepare('PRAGMA table_info(theta_research_brief_revisions)')
      .all() as Row[];
    if (!revisionColumns.some((column) => column.name === 'field_evidence_json')) {
      this.database.exec(
        'ALTER TABLE theta_research_brief_revisions ADD COLUMN field_evidence_json TEXT',
      );
    }
    const sessionColumns = this.database
      .prepare('PRAGMA table_info(theta_conversation_sessions)')
      .all() as Row[];
    if (!sessionColumns.some((column) => column.name === 'title')) {
      this.database.exec('ALTER TABLE theta_conversation_sessions ADD COLUMN title TEXT');
    }
    if (!sessionColumns.some((column) => column.name === 'pinned')) {
      this.database.exec('ALTER TABLE theta_conversation_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO theta_conversation_migrations(version, applied_at)
         VALUES (2, datetime('now'))`,
      )
      .run();
  }
}

type Row = Record<string, unknown>;

const session = (row: Row): ConversationSession => ({
  sessionId: string(row.session_id),
  ...(nullableString(row.active_run_id)
    ? { activeRunId: nullableString(row.active_run_id) }
    : {}),
  providerMode:
    row.provider_mode === 'provider' || row.provider_mode === 'minimax'
      ? 'provider'
      : 'deterministic',
  languageConsent: number(row.language_consent) === 1,
  createdAt: string(row.created_at),
  updatedAt: string(row.updated_at),
});

const message = (row: Row): ConversationMessage => ({
  messageId: string(row.message_id),
  sessionId: string(row.session_id),
  ...(nullableString(row.run_id) ? { runId: nullableString(row.run_id) } : {}),
  role: string(row.role) as ConversationMessage['role'],
  messageKind: string(row.message_kind),
  content: string(row.content),
  sequenceNumber: number(row.sequence_number),
  createdAt: string(row.created_at),
});

const revision = (row: Row): ResearchBriefRevision => ({
  revisionId: string(row.revision_id),
  runId: string(row.run_id),
  sessionId: string(row.session_id),
  ...(nullableString(row.parent_revision_id)
    ? { parentRevisionId: nullableString(row.parent_revision_id) }
    : {}),
  ...(nullableString(row.source_message_id)
    ? { sourceMessageId: nullableString(row.source_message_id) }
    : {}),
  patch: JSON.parse(string(row.patch_json)),
  brief: JSON.parse(string(row.brief_snapshot_json)),
  briefHash: string(row.brief_hash),
  ...(nullableString(row.interpretation_hash)
    ? { interpretationHash: nullableString(row.interpretation_hash) }
    : {}),
  ...(nullableString(row.field_evidence_json)
    ? { fieldEvidence: JSON.parse(string(row.field_evidence_json)) }
    : {}),
  createdAt: string(row.created_at),
});

const turn = (row: Row): ConversationTurn => ({
  turnId: string(row.turn_id),
  sessionId: string(row.session_id),
  ...(nullableString(row.run_id) ? { runId: nullableString(row.run_id) } : {}),
  userMessageId: string(row.user_message_id),
  status: string(row.status) as ConversationTurn['status'],
  idempotencyKey: string(row.idempotency_key),
  ...(nullableString(row.error_json)
    ? { error: JSON.parse(string(row.error_json)) }
    : {}),
  createdAt: string(row.created_at),
  updatedAt: string(row.updated_at),
});

const sessionSummary = (row: Row): ConversationSessionSummary => ({
  sessionId: string(row.session_id),
  title: string(row.title),
  messageCount: number(row.message_count),
  createdAt: string(row.created_at),
  updatedAt: string(row.updated_at),
  pinned: number(row.pinned) === 1,
});

const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected SQLite text value.');
  return value;
};

const nullableString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const number = (value: unknown): number => {
  if (typeof value !== 'number') {
    throw new Error('Expected SQLite numeric value.');
  }
  return value;
};
