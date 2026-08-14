import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultThetaWorkflowDb } from '../runtime/hypha-runtime.js';

export interface LocalRunSummary {
  runId: string;
  updatedAt: string;
  eventCount: number;
  recoveryOfRunId?: string;
  successorRunId?: string;
  displayName?: string;
}

export interface DeleteLocalRunResult {
  existed: boolean;
  deletedRecords: number;
}

interface SQLiteTableRow {
  name: string;
}

interface SQLiteColumnRow {
  name: string;
  notnull: number;
}

export const listLocalRuns = (
  runtimeDb = defaultThetaWorkflowDb(),
  limit = 30,
): LocalRunSummary[] => {
  const database = new DatabaseSync(path.resolve(runtimeDb));
  try {
    try {
      ensureRunMetadata(database);
      const summaries = database
        .prepare(
          `SELECT run_id AS runId, MAX(timestamp) AS updatedAt, COUNT(*) AS eventCount
           FROM runtime_events
           GROUP BY run_id
           ORDER BY updatedAt DESC
           LIMIT ?`,
        )
        .all(Math.max(1, Math.min(limit, 100))) as unknown as LocalRunSummary[];
      const lineage = new Map<string, string>();
      const successor = new Map<string, string>();
      const metadataRows = database
        .prepare('SELECT run_id AS runId, display_name AS displayName FROM theta_run_metadata')
        .all() as unknown as Array<{ runId: string; displayName: string }>;
      const names = new Map<string, string>(
        metadataRows.map((item) => [item.runId, item.displayName]),
      );
      const starts = database
        .prepare("SELECT run_id AS runId, event_json AS eventJson FROM runtime_events WHERE type = 'run.started' ORDER BY timestamp ASC")
        .all() as unknown as Array<{ runId: string; eventJson: string }>;
      for (const start of starts) {
        try {
          const event = JSON.parse(start.eventJson) as { payload?: { input?: { recoveryOfRunId?: unknown } } };
          const parent = event.payload?.input?.recoveryOfRunId;
          if (typeof parent !== 'string' || !parent.trim()) continue;
          lineage.set(start.runId, parent);
          successor.set(parent, start.runId);
        } catch {
          continue;
        }
      }
      return summaries.map((summary) => ({
        ...summary,
        ...(lineage.has(summary.runId) ? { recoveryOfRunId: lineage.get(summary.runId) } : {}),
        ...(successor.has(summary.runId) ? { successorRunId: successor.get(summary.runId) } : {}),
        ...(names.has(summary.runId) ? { displayName: names.get(summary.runId) } : {}),
      }));
    } catch {
      return [];
    }
  } finally {
    database.close();
  }
};

export const renameLocalRun = (
  runId: string,
  displayName: string,
  runtimeDb = defaultThetaWorkflowDb(),
): { runId: string; displayName: string } => {
  const database = new DatabaseSync(path.resolve(runtimeDb));
  try {
    ensureRunMetadata(database);
    const exists = database
      .prepare('SELECT 1 AS value FROM runtime_events WHERE run_id = ? LIMIT 1')
      .get(runId);
    if (!exists) throw new Error(`Run not found: ${runId}`);
    const normalized = displayName.replace(/\s+/gu, ' ').trim().slice(0, 120);
    if (!normalized) throw new Error('Run display name cannot be empty.');
    database
      .prepare(
        `INSERT INTO theta_run_metadata (run_id, display_name, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`,
      )
      .run(runId, normalized, new Date().toISOString());
    return { runId, displayName: normalized };
  } finally {
    database.close();
  }
};

const ensureRunMetadata = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS theta_run_metadata (
      run_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
};

export const deleteLocalRun = (
  runId: string,
  runtimeDb = defaultThetaWorkflowDb(),
): DeleteLocalRunResult => {
  const database = new DatabaseSync(path.resolve(runtimeDb));
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    database.close();
    return { existed: false, deletedRecords: 0 };
  }

  let foreignKeysDisabled = false;
  try {
    const runtimeEventCount = database
      .prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?')
      .get(normalizedRunId) as unknown as { count: number };
    if (Number(runtimeEventCount.count) === 0) {
      return { existed: false, deletedRecords: 0 };
    }

    const foreignKeyState = database.prepare('PRAGMA foreign_keys').get() as unknown as {
      foreign_keys?: number;
    };
    if (Number(foreignKeyState.foreign_keys) === 1) {
      database.exec('PRAGMA foreign_keys = OFF');
      foreignKeysDisabled = true;
    }

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as unknown as SQLiteTableRow[];
    let deletedRecords = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const table of tables) {
        const tableName = quoteIdentifier(table.name);
        const columns = database
          .prepare(`PRAGMA table_info(${tableName})`)
          .all() as unknown as SQLiteColumnRow[];
        const columnNames = new Set(columns.map((column) => column.name));
        if (columnNames.has('run_id')) {
          deletedRecords += Number(
            database.prepare(`DELETE FROM ${tableName} WHERE run_id = ?`).run(normalizedRunId).changes,
          );
        }
        const activeRunColumn = columns.find((column) => column.name === 'active_run_id');
        if (activeRunColumn && Number(activeRunColumn.notnull) === 0) {
          deletedRecords += Number(
            database.prepare(`UPDATE ${tableName} SET active_run_id = NULL WHERE active_run_id = ?`).run(normalizedRunId).changes,
          );
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { existed: true, deletedRecords };
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table: runtime_events')) {
      return { existed: false, deletedRecords: 0 };
    }
    throw error;
  } finally {
    if (foreignKeysDisabled) database.exec('PRAGMA foreign_keys = ON');
    database.close();
  }
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
