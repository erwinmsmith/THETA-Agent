import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDatasetFile } from '../../dataset-path-policy.js';
import { repositoryRoot } from '../repository-paths.js';

const defaultAgentRuntimeDb = (): string =>
  path.resolve(
    process.env.THETA_WORKFLOW_DB ??
      path.join(repositoryRoot, '.theta_agent', 'theta-workflow.sqlite'),
  );

export interface DatasetRecord {
  datasetRef: string;
  userId: string;
  workspaceId: string;
  displayName: string;
  managedPath: string;
  sha256: string;
  sizeBytes: number;
  suffix: string;
  createdAt: string;
}

export class SQLiteDatasetRegistry {
  private readonly database: DatabaseSync;

  constructor(readonly filename = defaultAgentRuntimeDb()) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_datasets (
        dataset_ref TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        managed_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        suffix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, workspace_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS idx_theta_datasets_owner
        ON theta_datasets(user_id, workspace_id, created_at DESC);
    `);
  }

  async registerLocalFile(
    filePath: string,
    owner: { userId: string; workspaceId: string },
  ): Promise<DatasetRecord> {
    const resolved = await resolveDatasetFile(filePath);
    const sha256 = await hashFile(resolved.filePath);
    const existing = this.database
      .prepare(
        `SELECT * FROM theta_datasets
          WHERE user_id = ? AND workspace_id = ? AND sha256 = ?`,
      )
      .get(owner.userId, owner.workspaceId, sha256) as Row | undefined;
    if (existing) return rowToRecord(existing);

    const datasetRef = `dataset_${sha256.slice(0, 24)}`;
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO theta_datasets
         (dataset_ref, user_id, workspace_id, display_name, managed_path,
          sha256, size_bytes, suffix, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        datasetRef,
        owner.userId,
        owner.workspaceId,
        path.basename(resolved.filePath),
        resolved.filePath,
        sha256,
        resolved.sizeBytes,
        resolved.suffix,
        createdAt,
      );
    return this.require(datasetRef, owner);
  }

  require(
    datasetRef: string,
    owner: { userId: string; workspaceId: string },
  ): DatasetRecord {
    const row = this.database
      .prepare(
        `SELECT * FROM theta_datasets
          WHERE dataset_ref = ? AND user_id = ? AND workspace_id = ?`,
      )
      .get(datasetRef, owner.userId, owner.workspaceId) as Row | undefined;
    if (!row) {
      throw new Error(`Dataset reference is unknown or not owned by this workspace: ${datasetRef}`);
    }
    return rowToRecord(row);
  }

  list(owner: { userId: string; workspaceId: string }): DatasetRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM theta_datasets
          WHERE user_id = ? AND workspace_id = ?
          ORDER BY created_at DESC`,
      )
      .all(owner.userId, owner.workspaceId) as unknown as Row[];
    return rows.map(rowToRecord);
  }

  close(): void {
    this.database.close();
  }
}

interface Row {
  dataset_ref: string;
  user_id: string;
  workspace_id: string;
  display_name: string;
  managed_path: string;
  sha256: string;
  size_bytes: number;
  suffix: string;
  created_at: string;
}

const rowToRecord = (row: Row): DatasetRecord => ({
  datasetRef: row.dataset_ref,
  userId: row.user_id,
  workspaceId: row.workspace_id,
  displayName: row.display_name,
  managedPath: row.managed_path,
  sha256: row.sha256,
  sizeBytes: Number(row.size_bytes),
  suffix: row.suffix,
  createdAt: row.created_at,
});

const hashFile = async (filename: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};
