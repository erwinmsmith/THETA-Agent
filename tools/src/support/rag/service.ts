import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FtsEvidenceIndex } from './fts-index.js';
import { loadKnowledgeManifest } from './manifest.js';
import { repositoryRoot } from '../repository-paths.js';

export interface KnowledgeIndexStatus {
  schemaVersion: '1.1.0';
  status: 'ready' | 'not_built';
  database: string;
  manifest: string;
  totalSources: number;
  totalChunks: number;
  totalObjects: number;
  objectTypes: Record<string, number>;
}

export interface KnowledgeIndexBuildResult extends KnowledgeIndexStatus {
  status: 'ready';
  indexedSources: number;
  unchangedSources: number;
  indexedChunks: number;
}

interface KnowledgePaths {
  packageRoot: string;
  manifestPath: string;
  databasePath: string;
}

export const getKnowledgeIndexStatus =
  async (): Promise<KnowledgeIndexStatus> => {
    const paths = knowledgePaths();
    if (!existsSync(paths.databasePath)) {
      return {
        ...baseStatus(paths),
        status: 'not_built',
        totalSources: 0,
        totalChunks: 0,
        totalObjects: 0,
        objectTypes: {},
      };
    }
    const database = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      return {
        ...baseStatus(paths),
        status: 'ready',
        ...readCounts(database),
      };
    } finally {
      database.close();
    }
  };

export const buildKnowledgeIndex =
  async (): Promise<KnowledgeIndexBuildResult> => {
    const paths = knowledgePaths();
    const manifest = await loadKnowledgeManifest(
      paths.manifestPath,
      paths.packageRoot,
    );
    const index = await FtsEvidenceIndex.open(
      paths.databasePath,
      paths.packageRoot,
    );
    try {
      const result = await index.build(manifest);
      return {
        ...baseStatus(paths),
        status: 'ready',
        ...result,
        ...index.counts(),
      };
    } finally {
      index.close();
    }
  };

const knowledgePaths = (): KnowledgePaths => {
  const packageRoot = repositoryRoot;
  return {
    packageRoot,
    manifestPath: path.join(packageRoot, 'knowledge', 'manifest.yaml'),
    databasePath:
      process.env.THETA_KNOWLEDGE_INDEX ??
      path.join(packageRoot, '.theta_agent', 'knowledge.sqlite'),
  };
};

const baseStatus = (
  paths: KnowledgePaths,
): Pick<KnowledgeIndexStatus, 'schemaVersion' | 'database' | 'manifest'> => ({
  schemaVersion: '1.1.0',
  database: displayPath(paths.packageRoot, paths.databasePath),
  manifest: displayPath(paths.packageRoot, paths.manifestPath),
});

const displayPath = (root: string, target: string): string => {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return path.basename(target);
  }
  return relative.split(path.sep).join('/');
};

const readCounts = (database: DatabaseSync) => {
  const sources = database
    .prepare('SELECT COUNT(*) AS count FROM knowledge_sources')
    .get() as { count: number };
  const chunks = database
    .prepare('SELECT COUNT(*) AS count FROM knowledge_chunks')
    .get() as { count: number };
  let totalObjects = 0;
  let objectTypes: Record<string, number> = {};
  try {
    const objects = database
      .prepare('SELECT COUNT(*) AS count FROM knowledge_objects')
      .get() as { count: number };
    totalObjects = Number(objects.count);
    const rows = database
      .prepare('SELECT object_type AS type, COUNT(*) AS count FROM knowledge_objects GROUP BY object_type')
      .all() as Array<{ type: string; count: number }>;
    objectTypes = Object.fromEntries(rows.map((row) => [row.type, Number(row.count)]));
  } catch {
    // A pre-V1.1 local index remains readable and is reported as zero objects.
  }
  return {
    totalSources: Number(sources.count),
    totalChunks: Number(chunks.count) + totalObjects,
    totalObjects,
    objectTypes,
  };
};
