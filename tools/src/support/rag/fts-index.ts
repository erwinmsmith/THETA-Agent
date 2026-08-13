import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import {
  evidenceRefSchema,
  knowledgeObjectFileSchema,
  type EvidenceRef,
  type KnowledgeManifest,
  type KnowledgeObject,
  type KnowledgeObjectType,
  type RetrievalRoute,
} from "@theta-agent/domain/rag/contracts.js";
import {
  resolveKnowledgeObjectSets,
  resolveKnowledgeSources,
} from "./manifest.js";

interface LegacyChunk {
  evidenceId: string;
  sourceId: string;
  authority: EvidenceRef["authority"];
  relativePath: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  sourceCommit: string;
  contentHash: string;
  excerpt: string;
}

interface StructuredRow {
  object: KnowledgeObject;
  relativePath: string;
  sourceCommit: string;
  contentHash: string;
  raw: string;
  tokens: string;
  grams: string;
}

export type RetrievalQueryType =
  | "model_selection"
  | "hyperparameter"
  | "preprocessing"
  | "evaluation"
  | "resource_and_environment"
  | "failure_diagnosis";

export interface RetrievalSubquery {
  type: RetrievalQueryType;
  query: string;
}

export interface RetrievalTrace {
  schemaVersion: "1.0.0";
  subqueries: RetrievalSubquery[];
  routesUsed: Array<"exact" | "fts_raw" | "fts_tokens" | "fts_grams">;
  candidateCount: number;
  selectedCount: number;
  sourceCap: number;
  coverage: string[];
  noEvidence: boolean;
}

export interface MultiRouteSearchResult {
  evidence: EvidenceRef[];
  trace: RetrievalTrace;
}

export interface KnowledgeBuildResult {
  indexedSources: number;
  unchangedSources: number;
  indexedChunks: number;
  indexedObjects: number;
  objectTypes: Record<string, number>;
}

export interface KnowledgeIndexCounts {
  totalSources: number;
  totalChunks: number;
  totalObjects: number;
  objectTypes: Record<string, number>;
}

type RouteName = RetrievalRoute["route"];
interface Candidate {
  id: string;
  reciprocalScore: number;
  routes: RetrievalRoute[];
  matchedQueries: Set<string>;
}

const ROUTE_WEIGHT: Record<RouteName, number> = {
  exact: 2.4,
  fts_raw: 1,
  fts_tokens: 1.25,
  fts_grams: 0.7,
};
const AUTHORITY_BONUS: Record<EvidenceRef["authority"], number> = {
  L1: 0.18,
  L2: 0.12,
  L3: 0.06,
  L4: 0,
};
const CONFIDENCE_BONUS = { high: 0.06, medium: 0.03, low: 0 } as const;
const RRF_K = 60;

export class FtsEvidenceIndex {
  private readonly db: DatabaseSync;

  constructor(
    private readonly databasePath: string,
    private readonly packageRoot: string,
  ) {
    this.db = new DatabaseSync(databasePath);
    this.initialize();
  }

  static async open(databasePath: string, packageRoot: string): Promise<FtsEvidenceIndex> {
    if (databasePath !== ":memory:") await mkdir(path.dirname(databasePath), { recursive: true });
    return new FtsEvidenceIndex(databasePath, packageRoot);
  }

  close(): void {
    this.db.close();
  }

  async build(manifest: KnowledgeManifest): Promise<KnowledgeBuildResult> {
    const sources = resolveKnowledgeSources(manifest, this.packageRoot);
    let unchangedSources = 0;
    let indexedChunks = 0;
    for (const source of sources) {
      const content = await readFile(source.absolutePath, "utf8");
      const sourceHash = sha256(content);
      const existing = this.db
        .prepare("SELECT content_hash AS contentHash FROM knowledge_sources WHERE source_id = ?")
        .get(source.sourceId) as { contentHash?: string } | undefined;
      if (existing?.contentHash === sourceHash) {
        unchangedSources += 1;
        continue;
      }
      const chunks = chunkLegacySource({
        sourceId: source.sourceId,
        authority: source.authority,
        relativePath: source.relativePath,
        sourceCommit: source.sourceCommit,
        content,
      });
      this.replaceLegacySource(source.sourceId, sourceHash, chunks);
      indexedChunks += chunks.length;
    }

    const structuredRows: StructuredRow[] = [];
    const ids = new Set<string>();
    const allowedStructuredSources = new Set(manifest.structuredSources.map((source) => source.sourceId));
    for (const objectSet of resolveKnowledgeObjectSets(manifest, this.packageRoot)) {
      const rawFile = await readFile(objectSet.absolutePath, "utf8");
      const parsed = knowledgeObjectFileSchema.parse(parse(rawFile, { merge: true }));
      for (const object of parsed.objects) {
        if (ids.has(object.object_id)) throw new Error(`Duplicate knowledge object id '${object.object_id}'.`);
        ids.add(object.object_id);
        if (!allowedStructuredSources.has(object.source_id)) {
          throw new Error(`Knowledge object '${object.object_id}' references undeclared source '${object.source_id}'.`);
        }
        const contentHash = sha256(canonicalObjectContent(object));
        if (object.content_hash && object.content_hash !== contentHash) {
          throw new Error(`Knowledge object '${object.object_id}' has a stale content_hash.`);
        }
        structuredRows.push({
          object,
          relativePath: objectSet.relativePath,
          sourceCommit: objectSet.sourceCommit,
          contentHash,
          raw: searchableRaw(object),
          tokens: searchableTokens(object),
          grams: searchableGrams(object),
        });
      }
    }
    this.replaceStructuredObjects(structuredRows);
    const counts = this.counts();
    return {
      indexedSources: sources.length - unchangedSources,
      unchangedSources,
      indexedChunks: indexedChunks + structuredRows.length,
      indexedObjects: structuredRows.length,
      objectTypes: counts.objectTypes,
    };
  }

  counts(): KnowledgeIndexCounts {
    const sources = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_sources").get() as { count: number };
    const legacy = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_chunks").get() as { count: number };
    const objects = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get() as { count: number };
    const typeRows = this.db
      .prepare("SELECT object_type AS type, COUNT(*) AS count FROM knowledge_objects GROUP BY object_type")
      .all() as Array<{ type: string; count: number }>;
    return {
      totalSources: Number(sources.count),
      totalChunks: Number(legacy.count) + Number(objects.count),
      totalObjects: Number(objects.count),
      objectTypes: Object.fromEntries(typeRows.map((row) => [row.type, Number(row.count)])),
    };
  }

  search(query: string, limit = 8): EvidenceRef[] {
    return this.searchMulti(query, limit).evidence;
  }

  searchMulti(query: string, limit = 12): MultiRouteSearchResult {
    const normalizedLimit = Math.max(1, Math.min(limit, 30));
    if (!isIndexableQuery(query)) {
      return {
        evidence: [],
        trace: {
          schemaVersion: "1.0.0",
          subqueries: [],
          routesUsed: [],
          candidateCount: 0,
          selectedCount: 0,
          sourceCap: 3,
          coverage: [],
          noEvidence: true,
        },
      };
    }
    const subqueries = decomposeQuery(query);
    const candidates = new Map<string, Candidate>();
    const routesUsed = new Set<RouteName>();

    for (const subquery of subqueries) {
      const exactTerms = identifierTerms(subquery.query);
      if (exactTerms.length) {
        const placeholders = exactTerms.map(() => "?").join(",");
        const rows = this.db.prepare(
          `SELECT DISTINCT object_id AS id FROM knowledge_aliases WHERE normalized_alias IN (${placeholders}) LIMIT 40`,
        ).all(...exactTerms) as Array<{ id: string }>;
        addRanked(candidates, rows.map((row) => row.id), "exact", subquery, routesUsed);
      }
      this.runFtsRoute("knowledge_object_fts_raw", "fts_raw", rawMatchQuery(subquery.query), subquery, candidates, routesUsed);
      this.runFtsRoute("knowledge_object_fts_tokens", "fts_tokens", tokenMatchQuery(subquery.query), subquery, candidates, routesUsed);
      this.runFtsRoute("knowledge_object_fts_grams", "fts_grams", gramMatchQuery(subquery.query), subquery, candidates, routesUsed);
    }

    // Preserve the original allow-listed documentation as a lower-priority raw channel.
    const legacyIds = this.searchLegacyIds(query, 20);
    addRanked(candidates, legacyIds, "fts_raw", subqueries[0], routesUsed);

    const ranked = [...candidates.values()]
      .map((candidate) => ({ candidate, row: this.readEvidence(candidate.id) }))
      .filter((entry): entry is { candidate: Candidate; row: EvidenceRef } => Boolean(entry.row))
      .map((entry) => ({
        ...entry,
        adjusted:
          entry.candidate.reciprocalScore *
          (1 + AUTHORITY_BONUS[entry.row.authority] + CONFIDENCE_BONUS[entry.row.confidence ?? "low"] +
            (entry.row.thetaSupportStatus === "supported" ? 0.06 : entry.row.thetaSupportStatus === "conditional" ? 0.02 : 0)),
      }))
      .sort((a, b) => b.adjusted - a.adjusted);

    const maxScore = ranked[0]?.adjusted ?? 1;
    const hydrated = ranked.map(({ candidate, row, adjusted }) =>
      evidenceRefSchema.parse({
        ...row,
        finalScore: Math.max(0, Math.min(100, Math.round((adjusted / maxScore) * 10000) / 100)),
        retrievalRoutes: candidate.routes,
        matchedQueries: [...candidate.matchedQueries],
      }),
    );
    const selected = selectEvidenceSet(hydrated, normalizedLimit, 3);
    return {
      evidence: selected,
      trace: {
        schemaVersion: "1.0.0",
        subqueries,
        routesUsed: [...routesUsed],
        candidateCount: hydrated.length,
        selectedCount: selected.length,
        sourceCap: 3,
        coverage: [...new Set(selected.map(coverageClass))],
        noEvidence: selected.length === 0,
      },
    };
  }

  private runFtsRoute(
    table: string,
    route: RouteName,
    matchQuery: string,
    subquery: RetrievalSubquery,
    candidates: Map<string, Candidate>,
    routesUsed: Set<RouteName>,
  ): void {
    if (!matchQuery) return;
    try {
      const rows = this.db.prepare(
        `SELECT object_id AS id, bm25(${table}) AS score FROM ${table} WHERE ${table} MATCH ? ORDER BY score LIMIT 30`,
      ).all(matchQuery) as Array<{ id: string }>;
      addRanked(candidates, rows.map((row) => row.id), route, subquery, routesUsed);
    } catch {
      // One malformed/unsupported FTS query must not disable the remaining routes.
    }
  }

  private searchLegacyIds(query: string, limit: number): string[] {
    const match = rawMatchQuery(query);
    if (!match) return [];
    try {
      return (this.db.prepare(
        `SELECT c.evidence_id AS id FROM knowledge_fts JOIN knowledge_chunks c ON c.evidence_id = knowledge_fts.evidence_id WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT ?`,
      ).all(match, limit) as Array<{ id: string }>).map((row) => row.id);
    } catch {
      return [];
    }
  }

  private readEvidence(id: string): EvidenceRef | undefined {
    const objectRow = this.db.prepare(
      `SELECT object_id, object_type, title, model_ids, parameter_ids, scenario_tags,
              authority, source_id, source_year, source_locator, claim_scope,
              implementation_name, implementation_version, theta_support_status,
              confidence, conflict_group_id, relative_path, source_commit,
              content_hash, content_markdown
         FROM knowledge_objects WHERE object_id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    if (objectRow) {
      return evidenceRefSchema.parse({
        evidenceId: `ko:${objectRow.object_id}`,
        objectId: objectRow.object_id,
        objectType: objectRow.object_type,
        title: objectRow.title,
        modelIds: jsonArray(objectRow.model_ids),
        parameterIds: jsonArray(objectRow.parameter_ids),
        scenarioTags: jsonArray(objectRow.scenario_tags),
        sourceId: objectRow.source_id,
        authority: objectRow.authority,
        relativePath: objectRow.relative_path,
        symbol: objectRow.object_id,
        startLine: 1,
        endLine: 1,
        sourceCommit: objectRow.source_commit,
        contentHash: objectRow.content_hash,
        excerpt: String(objectRow.content_markdown).slice(0, 1200),
        finalScore: 0,
        sourceYear: objectRow.source_year === null ? null : Number(objectRow.source_year),
        sourceLocator: objectRow.source_locator,
        claimScope: objectRow.claim_scope,
        implementationName: objectRow.implementation_name,
        implementationVersion: objectRow.implementation_version,
        thetaSupportStatus: objectRow.theta_support_status,
        confidence: objectRow.confidence,
        conflictGroupId: objectRow.conflict_group_id,
      });
    }
    const legacy = this.db.prepare(
      `SELECT evidence_id AS evidenceId, source_id AS sourceId, authority,
              relative_path AS relativePath, symbol, start_line AS startLine,
              end_line AS endLine, source_commit AS sourceCommit,
              content_hash AS contentHash, excerpt
         FROM knowledge_chunks WHERE evidence_id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    return legacy ? evidenceRefSchema.parse({ ...legacy, finalScore: 0 }) : undefined;
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        source_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        evidence_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        symbol TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        source_commit TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        excerpt TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        evidence_id UNINDEXED, source_id UNINDEXED, content, tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS knowledge_objects (
        object_id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        title TEXT NOT NULL,
        model_ids TEXT NOT NULL,
        parameter_ids TEXT NOT NULL,
        scenario_tags TEXT NOT NULL,
        authority TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_year INTEGER,
        source_locator TEXT NOT NULL,
        claim_scope TEXT NOT NULL,
        implementation_name TEXT,
        implementation_version TEXT,
        theta_support_status TEXT NOT NULL,
        confidence TEXT NOT NULL,
        conflict_group_id TEXT,
        relative_path TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_aliases (
        object_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        language TEXT NOT NULL,
        model_scope TEXT NOT NULL,
        PRIMARY KEY (object_id, normalized_alias)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_alias_normalized ON knowledge_aliases(normalized_alias);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_object_fts_raw USING fts5(
        object_id UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_object_fts_tokens USING fts5(
        object_id UNINDEXED, content, tokenize = 'unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_object_fts_grams USING fts5(
        object_id UNINDEXED, content, tokenize = 'unicode61'
      );
    `);
  }

  private replaceLegacySource(sourceId: string, contentHash: string, chunks: readonly LegacyChunk[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM knowledge_fts WHERE source_id = ?").run(sourceId);
      this.db.prepare("DELETE FROM knowledge_chunks WHERE source_id = ?").run(sourceId);
      const insertChunk = this.db.prepare(
        `INSERT INTO knowledge_chunks (evidence_id, source_id, authority, relative_path, symbol, start_line, end_line, source_commit, content_hash, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.db.prepare("INSERT INTO knowledge_fts (evidence_id, source_id, content) VALUES (?, ?, ?)");
      for (const chunk of chunks) {
        insertChunk.run(chunk.evidenceId, chunk.sourceId, chunk.authority, chunk.relativePath, chunk.symbol, chunk.startLine, chunk.endLine, chunk.sourceCommit, chunk.contentHash, chunk.excerpt);
        insertFts.run(chunk.evidenceId, chunk.sourceId, chunk.excerpt);
      }
      this.db.prepare(
        `INSERT INTO knowledge_sources (source_id, content_hash) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET content_hash = excluded.content_hash`,
      ).run(sourceId, contentHash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceStructuredObjects(rows: readonly StructuredRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["knowledge_object_fts_raw", "knowledge_object_fts_tokens", "knowledge_object_fts_grams", "knowledge_aliases", "knowledge_objects"]) {
        this.db.exec(`DELETE FROM ${table}`);
      }
      const insertObject = this.db.prepare(
        `INSERT INTO knowledge_objects (object_id, object_type, title, model_ids, parameter_ids, scenario_tags, authority, evidence_type, source_id, source_year, source_locator, claim_scope, implementation_name, implementation_version, theta_support_status, confidence, conflict_group_id, relative_path, source_commit, content_hash, content_markdown, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertAlias = this.db.prepare(
        `INSERT INTO knowledge_aliases (object_id, alias, normalized_alias, language, model_scope) VALUES (?, ?, ?, ?, ?)`,
      );
      const rawFts = this.db.prepare("INSERT INTO knowledge_object_fts_raw (object_id, content) VALUES (?, ?)");
      const tokenFts = this.db.prepare("INSERT INTO knowledge_object_fts_tokens (object_id, content) VALUES (?, ?)");
      const gramFts = this.db.prepare("INSERT INTO knowledge_object_fts_grams (object_id, content) VALUES (?, ?)");
      for (const row of rows) {
        const o = row.object;
        insertObject.run(o.object_id, o.object_type, o.title, JSON.stringify(o.model_ids), JSON.stringify(o.parameter_ids), JSON.stringify(o.scenario_tags), o.authority_level, o.evidence_type, o.source_id, o.source_year, o.source_locator, o.claim_scope, o.implementation_name, o.implementation_version, o.theta_support_status, o.confidence, o.conflict_group_id, row.relativePath, row.sourceCommit, row.contentHash, o.content_markdown, o.updated_at);
        const aliases = [[o.object_id, "id"], [o.title, o.language], ...o.aliases_zh.map((a) => [a, "zh-CN"]), ...o.aliases_en.map((a) => [a, "en"])] as Array<[string, string]>;
        const seen = new Set<string>();
        for (const [alias, language] of aliases) {
          const normalized = normalizeAlias(alias);
          if (!normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          insertAlias.run(o.object_id, alias, normalized, language, JSON.stringify(o.model_ids));
        }
        rawFts.run(o.object_id, row.raw);
        tokenFts.run(o.object_id, row.tokens);
        gramFts.run(o.object_id, row.grams);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const addRanked = (
  candidates: Map<string, Candidate>,
  ids: readonly string[],
  route: RouteName,
  subquery: RetrievalSubquery,
  routesUsed: Set<RouteName>,
): void => {
  if (!ids.length) return;
  routesUsed.add(route);
  ids.forEach((id, index) => {
    const rank = index + 1;
    const contribution = ROUTE_WEIGHT[route] / (RRF_K + rank);
    const current = candidates.get(id) ?? { id, reciprocalScore: 0, routes: [], matchedQueries: new Set<string>() };
    current.reciprocalScore += contribution;
    current.routes.push({ route, queryType: subquery.type, rank, contribution });
    current.matchedQueries.add(subquery.type);
    candidates.set(id, current);
  });
};

export const decomposeQuery = (query: string): RetrievalSubquery[] => {
  const base = query.trim().slice(0, 800);
  const definitions: Array<[RetrievalQueryType, string]> = [
    ["model_selection", "模型选择 适用场景 model selection topic model"],
    ["hyperparameter", "超参数 主题数 参数 hyperparameter topic count"],
    ["preprocessing", "预处理 文本 清洗 分词 preprocessing"],
    ["evaluation", "评估 coherence diversity stability evaluation"],
    ["resource_and_environment", "资源 CPU GPU 内存 离线 依赖 environment"],
    ["failure_diagnosis", "失败 风险 报错 诊断 failure troubleshooting"],
  ];
  return definitions.map(([type, suffix]) => ({ type, query: `${base} ${suffix}`.trim() }));
};

const selectEvidenceSet = (rows: readonly EvidenceRef[], limit: number, sourceCap: number): EvidenceRef[] => {
  const coverageOrder = ["model", "parameter", "resource", "paper", "preprocessing", "evaluation", "failure"];
  const selected: EvidenceRef[] = [];
  const selectedIds = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const take = (row: EvidenceRef): boolean => {
    if (selectedIds.has(row.evidenceId) || (sourceCounts.get(row.sourceId) ?? 0) >= sourceCap) return false;
    selected.push(row);
    selectedIds.add(row.evidenceId);
    sourceCounts.set(row.sourceId, (sourceCounts.get(row.sourceId) ?? 0) + 1);
    return true;
  };
  for (const coverage of coverageOrder) {
    const match = rows.find((row) => coverageClass(row) === coverage && !selectedIds.has(row.evidenceId) && (sourceCounts.get(row.sourceId) ?? 0) < sourceCap);
    if (match) take(match);
    if (selected.length >= limit) return selected;
  }
  for (const row of rows) {
    take(row);
    if (selected.length >= limit) break;
  }
  return selected.sort((a, b) => b.finalScore - a.finalScore);
};

const coverageClass = (row: EvidenceRef): string => {
  if (/^(paper|survey)\./.test(row.sourceId) && (row.authority === "L3" || row.authority === "L4")) return "paper";
  if (row.objectType === "failure_mode") return "failure";
  if (row.objectType === "evaluation_metric") return "evaluation";
  if (row.scenarioTags?.some((tag) => /preprocess|clean|token/i.test(tag))) return "preprocessing";
  if (row.scenarioTags?.some((tag) => /resource|cpu|gpu|offline|environment/i.test(tag))) return "resource";
  if (row.objectType === "model" || row.objectType === "implementation_capability") return "model";
  if (row.objectType === "parameter") return "parameter";
  return "other";
};

const searchableRaw = (o: KnowledgeObject): string => [o.object_id, o.title, ...o.aliases_zh, ...o.aliases_en, ...o.model_ids, ...o.parameter_ids, ...o.scenario_tags, o.claim_scope, o.content_markdown].join("\n");
const searchableTokens = (o: KnowledgeObject): string => tokenizeChinese(searchableRaw(o)).join(" ");
const searchableGrams = (o: KnowledgeObject): string => chineseNgrams(searchableRaw(o)).join(" ");

export const tokenizeChinese = (value: string): string[] => {
  const normalized = value.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2");
  const latin = normalized.match(/[a-z0-9]+(?:[_-][a-z0-9]+)*/g) ?? [];
  const chineseRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => run.length <= 2 ? [run] : [run, ...[...run], ...ngrams(run, 2)]);
  return [...new Set([...latin.flatMap((term) => [term, ...term.split(/[_-]/)]), ...chinese])].filter(Boolean);
};

const chineseNgrams = (value: string): string[] => {
  const runs = value.match(/[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(runs.flatMap((run) => [...ngrams(run, 2), ...ngrams(run, 3)]))];
};

const ngrams = (value: string, size: number): string[] => {
  const chars = [...value];
  if (chars.length < size) return chars.length ? [value] : [];
  return Array.from({ length: chars.length - size + 1 }, (_, i) => chars.slice(i, i + size).join(""));
};

const identifierTerms = (query: string): string[] => [...new Set((query.match(/[A-Za-z][A-Za-z0-9_.-]{1,40}|[\p{Script=Han}]{2,16}/gu) ?? []).map(normalizeAlias))].slice(0, 24);
const isIndexableQuery = (query: string): boolean =>
  identifierTerms(query).length > 0 || tokenizeChinese(query).some((term) => term.length > 1);
const normalizeAlias = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, "").trim();
const rawMatchQuery = (query: string): string => matchQuery((query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((term) => term.length > 1));
const tokenMatchQuery = (query: string): string => matchQuery(tokenizeChinese(query));
const gramMatchQuery = (query: string): string => matchQuery(chineseNgrams(query));
const matchQuery = (terms: readonly string[]): string => [...new Set(terms)].slice(0, 28).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
const jsonArray = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
};

const canonicalObjectContent = (o: KnowledgeObject): string => JSON.stringify({ ...o, content_hash: null }, Object.keys({ ...o, content_hash: null }).sort());
const chunkLegacySource = (input: { sourceId: string; authority: EvidenceRef["authority"]; relativePath: string; sourceCommit: string; content: string }): LegacyChunk[] => {
  const lines = input.content.replace(/\r\n/g, "\n").split("\n");
  const chunks: LegacyChunk[] = [];
  for (let start = 0; start < lines.length; start += 15) {
    const slice = lines.slice(start, start + 18);
    const excerpt = slice.join("\n").trim();
    if (!excerpt) continue;
    const startLine = start + 1;
    const endLine = Math.min(lines.length, start + slice.length);
    const contentHash = sha256(excerpt);
    chunks.push({ evidenceId: sha256(`${input.sourceId}:${startLine}:${endLine}:${contentHash}`).slice(0, 32), sourceId: input.sourceId, authority: input.authority, relativePath: input.relativePath, symbol: null, startLine, endLine, sourceCommit: input.sourceCommit, contentHash, excerpt: excerpt.slice(0, 1200) });
  }
  return chunks;
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
