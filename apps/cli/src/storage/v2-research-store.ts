import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  datasetConfirmationSchema,
  datasetFactsSchema,
  datasetUnderstandingDraftSchema,
  researchIntentSchema,
  type DatasetConfirmation,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
  type ResearchIntent,
} from '../dataset-understanding/contracts.js';
import {
  interviewMemorySchema,
  type InterviewMemory,
} from '../agent/decision-gap.js';
import { defaultThetaWorkflowDb } from '../theta-workflow-runtime.js';
import {
  plannerDecisionV2Schema,
  plannerInputV2Hash,
  plannerInputV2Schema,
  plannerValidationResultV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
  type PlannerValidationResultV2,
} from '../planner/v2-contracts.js';

type RevisionKind = 'facts' | 'understanding' | 'intent';

export interface ResearchRevision<T> {
  runId: string;
  revision: number;
  datasetRef?: string;
  datasetHash?: string;
  value: T;
  createdAt: string;
}

export interface RemoteSampleConsentRecord {
  runId: string;
  datasetRef: string;
  datasetHash: string;
  allowed: boolean;
  maxRows: 10;
  policyVersion: '1.0.0';
  grantedBy: string;
  grantedAt: string;
}

export interface RemoteSampleReceiptRecord {
  runId: string;
  datasetHash: string;
  provider: string;
  model: string;
  payloadHash: string;
  rowCount: number;
  redactedValueCount: number;
  redactionRules: string[];
  createdAt: string;
}

export interface PlannerV2Record {
  runId: string;
  datasetHash: string;
  input: PlannerInputV2;
  decision: PlannerDecisionV2;
  validation: PlannerValidationResultV2;
  presentation: Record<string, unknown>;
  createdAt: string;
}

export class SQLiteV2ResearchStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename = defaultThetaWorkflowDb()) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_dataset_fact_snapshots (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        dataset_ref TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_theta_dataset_facts_hash
        ON theta_dataset_fact_snapshots(dataset_ref, dataset_hash, created_at DESC);

      CREATE TABLE IF NOT EXISTS theta_dataset_understanding_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        dataset_ref TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_theta_dataset_understanding_hash
        ON theta_dataset_understanding_revisions(dataset_ref, dataset_hash, created_at DESC);

      CREATE TABLE IF NOT EXISTS theta_dataset_confirmations (
        run_id TEXT PRIMARY KEY,
        dataset_ref TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        confirmed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS theta_research_intent_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, revision)
      );

      CREATE TABLE IF NOT EXISTS theta_interview_memory (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS theta_remote_sample_consents (
        run_id TEXT PRIMARY KEY,
        dataset_ref TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        max_rows INTEGER NOT NULL,
        policy_version TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS theta_remote_sample_receipts (
        run_id TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        redacted_value_count INTEGER NOT NULL,
        redaction_rules_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, payload_hash)
      );

      CREATE TABLE IF NOT EXISTS theta_planner_v2_records (
        run_id TEXT PRIMARY KEY,
        dataset_hash TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        presentation_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  appendFacts(runId: string, value: DatasetFacts): ResearchRevision<DatasetFacts> {
    const facts = datasetFactsSchema.parse(value);
    return this.appendRevision('facts', runId, facts, facts.datasetRef, facts.datasetHash);
  }

  latestFacts(runId: string): ResearchRevision<DatasetFacts> | undefined {
    const row = this.latestRevision('facts', runId);
    return row
      ? { ...row, value: datasetFactsSchema.parse(JSON.parse(row.payloadJson)) }
      : undefined;
  }

  appendUnderstanding(
    runId: string,
    value: DatasetUnderstandingDraft,
  ): ResearchRevision<DatasetUnderstandingDraft> {
    const draft = datasetUnderstandingDraftSchema.parse(value);
    return this.appendRevision(
      'understanding',
      runId,
      draft,
      draft.datasetRef,
      draft.datasetHash,
    );
  }

  latestUnderstanding(
    runId: string,
  ): ResearchRevision<DatasetUnderstandingDraft> | undefined {
    const row = this.latestRevision('understanding', runId);
    return row
      ? {
          ...row,
          value: datasetUnderstandingDraftSchema.parse(JSON.parse(row.payloadJson)),
        }
      : undefined;
  }

  saveConfirmation(runId: string, value: DatasetConfirmation): DatasetConfirmation {
    const confirmation = datasetConfirmationSchema.parse(value);
    this.database
      .prepare(`
        INSERT INTO theta_dataset_confirmations
          (run_id, dataset_ref, dataset_hash, payload_json, confirmed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          dataset_ref = excluded.dataset_ref,
          dataset_hash = excluded.dataset_hash,
          payload_json = excluded.payload_json,
          confirmed_at = excluded.confirmed_at
      `)
      .run(
        runId,
        confirmation.datasetRef,
        confirmation.datasetHash,
        JSON.stringify(confirmation),
        confirmation.confirmedAt,
      );
    return confirmation;
  }

  confirmation(runId: string): DatasetConfirmation | undefined {
    const row = this.database
      .prepare('SELECT payload_json FROM theta_dataset_confirmations WHERE run_id = ?')
      .get(runId) as { payload_json: string } | undefined;
    return row ? datasetConfirmationSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  appendIntent(runId: string, value: ResearchIntent): ResearchRevision<ResearchIntent> {
    const intent = researchIntentSchema.parse(value);
    return this.appendRevision('intent', runId, intent);
  }

  latestIntent(runId: string): ResearchRevision<ResearchIntent> | undefined {
    const row = this.latestRevision('intent', runId);
    return row
      ? { ...row, value: researchIntentSchema.parse(JSON.parse(row.payloadJson)) }
      : undefined;
  }

  saveInterviewMemory(runId: string, value: InterviewMemory): InterviewMemory {
    const memory = interviewMemorySchema.parse(value);
    this.database
      .prepare(`
        INSERT INTO theta_interview_memory (run_id, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `)
      .run(runId, JSON.stringify(memory), new Date().toISOString());
    return memory;
  }

  interviewMemory(runId: string): InterviewMemory | undefined {
    const row = this.database
      .prepare('SELECT payload_json FROM theta_interview_memory WHERE run_id = ?')
      .get(runId) as { payload_json: string } | undefined;
    return row ? interviewMemorySchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  saveRemoteSampleConsent(value: RemoteSampleConsentRecord): RemoteSampleConsentRecord {
    this.database.prepare(`
      INSERT INTO theta_remote_sample_consents
        (run_id, dataset_ref, dataset_hash, allowed, max_rows, policy_version, granted_by, granted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        dataset_ref = excluded.dataset_ref,
        dataset_hash = excluded.dataset_hash,
        allowed = excluded.allowed,
        max_rows = excluded.max_rows,
        policy_version = excluded.policy_version,
        granted_by = excluded.granted_by,
        granted_at = excluded.granted_at
    `).run(
      value.runId, value.datasetRef, value.datasetHash, value.allowed ? 1 : 0,
      value.maxRows, value.policyVersion, value.grantedBy, value.grantedAt,
    );
    return value;
  }

  saveRemoteSampleReceipt(value: RemoteSampleReceiptRecord): RemoteSampleReceiptRecord {
    this.database.prepare(`
      INSERT OR IGNORE INTO theta_remote_sample_receipts
        (run_id, dataset_hash, provider, model, payload_hash, row_count,
         redacted_value_count, redaction_rules_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.runId, value.datasetHash, value.provider, value.model, value.payloadHash,
      value.rowCount, value.redactedValueCount, JSON.stringify(value.redactionRules), value.createdAt,
    );
    return value;
  }

  savePlannerV2(value: PlannerV2Record): PlannerV2Record {
    const input = plannerInputV2Schema.parse(value.input);
    const decision = plannerDecisionV2Schema.parse(value.decision);
    const validation = plannerValidationResultV2Schema.parse(value.validation);
    if (input.facts.datasetHash !== value.datasetHash) {
      throw new Error('Planner V2 record does not bind the active dataset hash.');
    }
    if (decision.inputHash !== plannerInputV2Hash(input)) {
      throw new Error('Planner V2 record contains a stale decision.');
    }
    this.database.prepare(`
      INSERT INTO theta_planner_v2_records
        (run_id, dataset_hash, input_hash, input_json, decision_json,
         validation_json, presentation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        dataset_hash = excluded.dataset_hash,
        input_hash = excluded.input_hash,
        input_json = excluded.input_json,
        decision_json = excluded.decision_json,
        validation_json = excluded.validation_json,
        presentation_json = excluded.presentation_json,
        created_at = excluded.created_at
    `).run(
      value.runId, value.datasetHash, decision.inputHash, JSON.stringify(input),
      JSON.stringify(decision), JSON.stringify(validation),
      JSON.stringify(value.presentation), value.createdAt,
    );
    return { ...value, input, decision, validation };
  }

  plannerV2(runId: string): PlannerV2Record | undefined {
    const row = this.database.prepare(`
      SELECT dataset_hash, input_json, decision_json, validation_json,
             presentation_json, created_at
      FROM theta_planner_v2_records WHERE run_id = ?
    `).get(runId) as {
      dataset_hash: string;
      input_json: string;
      decision_json: string;
      validation_json: string;
      presentation_json: string;
      created_at: string;
    } | undefined;
    return row ? {
      runId,
      datasetHash: row.dataset_hash,
      input: plannerInputV2Schema.parse(JSON.parse(row.input_json)),
      decision: plannerDecisionV2Schema.parse(JSON.parse(row.decision_json)),
      validation: plannerValidationResultV2Schema.parse(JSON.parse(row.validation_json)),
      presentation: JSON.parse(row.presentation_json) as Record<string, unknown>,
      createdAt: row.created_at,
    } : undefined;
  }

  invalidateAfterDatasetHashChange(runId: string, currentHash: string): void {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database
        .prepare('DELETE FROM theta_dataset_confirmations WHERE run_id = ? AND dataset_hash <> ?')
        .run(runId, currentHash);
      this.database
        .prepare(`
          DELETE FROM theta_dataset_understanding_revisions
          WHERE run_id = ? AND dataset_hash <> ?
        `)
        .run(runId, currentHash);
      this.database
        .prepare('DELETE FROM theta_research_intent_revisions WHERE run_id = ?')
        .run(runId);
      this.database
        .prepare('DELETE FROM theta_interview_memory WHERE run_id = ?')
        .run(runId);
      this.database
        .prepare('DELETE FROM theta_remote_sample_consents WHERE run_id = ? AND dataset_hash <> ?')
        .run(runId, currentHash);
      this.database
        .prepare('DELETE FROM theta_remote_sample_receipts WHERE run_id = ? AND dataset_hash <> ?')
        .run(runId, currentHash);
      this.database
        .prepare('DELETE FROM theta_planner_v2_records WHERE run_id = ? AND dataset_hash <> ?')
        .run(runId, currentHash);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private appendRevision<T>(
    kind: RevisionKind,
    runId: string,
    value: T,
    datasetRef?: string,
    datasetHash?: string,
  ): ResearchRevision<T> {
    const table = tableName(kind);
    const revision = this.nextRevision(table, runId);
    const createdAt = new Date().toISOString();
    if (kind === 'intent') {
      this.database
        .prepare(`
          INSERT INTO ${table} (run_id, revision, payload_json, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(runId, revision, JSON.stringify(value), createdAt);
    } else {
      if (!datasetRef || !datasetHash) {
        throw new Error(`${kind} revisions require datasetRef and datasetHash.`);
      }
      this.database
        .prepare(`
          INSERT INTO ${table}
            (run_id, revision, dataset_ref, dataset_hash, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(runId, revision, datasetRef, datasetHash, JSON.stringify(value), createdAt);
    }
    return { runId, revision, datasetRef, datasetHash, value, createdAt };
  }

  private latestRevision(
    kind: RevisionKind,
    runId: string,
  ): StoredRevision | undefined {
    const row = this.database
      .prepare(`
        SELECT revision, payload_json, created_at,
               ${kind === 'intent' ? 'NULL' : 'dataset_ref'} AS dataset_ref,
               ${kind === 'intent' ? 'NULL' : 'dataset_hash'} AS dataset_hash
        FROM ${tableName(kind)}
        WHERE run_id = ?
        ORDER BY revision DESC
        LIMIT 1
      `)
      .get(runId) as RevisionRow | undefined;
    return row
      ? {
          runId,
          revision: Number(row.revision),
          ...(row.dataset_ref ? { datasetRef: row.dataset_ref } : {}),
          ...(row.dataset_hash ? { datasetHash: row.dataset_hash } : {}),
          payloadJson: row.payload_json,
          createdAt: row.created_at,
        }
      : undefined;
  }

  private nextRevision(table: string, runId: string): number {
    const row = this.database
      .prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM ${table} WHERE run_id = ?`)
      .get(runId) as { revision: number };
    return Number(row.revision) + 1;
  }
}

interface RevisionRow {
  revision: number;
  dataset_ref: string | null;
  dataset_hash: string | null;
  payload_json: string;
  created_at: string;
}

interface StoredRevision {
  runId: string;
  revision: number;
  datasetRef?: string;
  datasetHash?: string;
  payloadJson: string;
  createdAt: string;
}

const tableName = (kind: RevisionKind): string => ({
  facts: 'theta_dataset_fact_snapshots',
  understanding: 'theta_dataset_understanding_revisions',
  intent: 'theta_research_intent_revisions',
})[kind];
