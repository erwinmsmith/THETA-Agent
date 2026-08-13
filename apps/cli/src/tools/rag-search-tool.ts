import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonSchema } from "@hypha/core";
import type { ToolHandler, ToolSpec } from "@hypha/tools";
import { evidenceRefSchema, type EvidenceRef } from "../rag/contracts.js";
import { FtsEvidenceIndex } from "../rag/fts-index.js";
import type { RetrievalTrace } from "../rag/fts-index.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaRagSearchInput {
  query: string;
  limit?: number;
}

export interface ThetaRagSearchOutput {
  schemaVersion: "1.1.0";
  query: string;
  evidence: EvidenceRef[];
  noEvidence: boolean;
  retrievalTrace: RetrievalTrace;
}

const inputSchema: JsonSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 1000 },
    limit: { type: "integer", minimum: 1, maximum: 30 },
  },
  additionalProperties: false,
};

const evidenceSchema: JsonSchema = {
  type: "object",
  required: [
    "evidenceId",
    "sourceId",
    "authority",
    "relativePath",
    "symbol",
    "startLine",
    "endLine",
    "sourceCommit",
    "contentHash",
    "excerpt",
    "finalScore",
  ],
  properties: {
    evidenceId: { type: "string" },
    sourceId: { type: "string" },
    authority: { enum: ["L1", "L2", "L3", "L4"] },
    relativePath: { type: "string" },
    symbol: { anyOf: [{ type: "string" }, { type: "null" }] },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    sourceCommit: { type: "string" },
    contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    excerpt: { type: "string", maxLength: 1200 },
    finalScore: { type: "number", minimum: 0, maximum: 100 },
    objectId: { type: "string" },
    objectType: { type: "string" },
    title: { type: "string" },
    modelIds: { type: "array", items: { type: "string" } },
    parameterIds: { type: "array", items: { type: "string" } },
    scenarioTags: { type: "array", items: { type: "string" } },
    sourceYear: { anyOf: [{ type: "integer" }, { type: "null" }] },
    sourceLocator: { type: "string" },
    claimScope: { type: "string" },
    implementationName: { anyOf: [{ type: "string" }, { type: "null" }] },
    implementationVersion: { anyOf: [{ type: "string" }, { type: "null" }] },
    thetaSupportStatus: { enum: ["supported", "conditional", "unsupported", "unknown"] },
    confidence: { enum: ["low", "medium", "high"] },
    conflictGroupId: { anyOf: [{ type: "string" }, { type: "null" }] },
    retrievalRoutes: { type: "array", items: { type: "object", additionalProperties: true } },
    matchedQueries: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: "object",
  required: ["schemaVersion", "query", "evidence", "noEvidence", "retrievalTrace"],
  properties: {
    schemaVersion: { const: "1.1.0" },
    query: { type: "string" },
    evidence: { type: "array", items: evidenceSchema },
    noEvidence: { type: "boolean" },
    retrievalTrace: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
};

export const thetaRagSearchToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.ragSearch,
  version: "1.1.0",
  displayName: "Search THETA Evidence",
  description: "Search the operator-built local FTS5 knowledge index.",
  tags: ["theta", "rag", "evidence"],
  inputSchema,
  outputSchema,
  sideEffectLevel: "read",
  permissionScope: [THETA_PERMISSION_SCOPES.ragRead],
  timeoutPolicy: { timeoutMs: 5000, onTimeout: "fail" },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: true,
    includeOutput: true,
  },
  source: "local",
};

export const thetaRagSearchHandler: ToolHandler<
  unknown,
  ThetaRagSearchOutput
> = async (input) => {
  if (!input || typeof input !== "object") {
    throw new Error("rag.search input must be an object.");
  }
  const normalized = input as ThetaRagSearchInput;
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const databasePath =
    process.env.THETA_KNOWLEDGE_INDEX ??
    path.join(packageRoot, ".theta_agent", "knowledge.sqlite");
  if (!existsSync(databasePath)) {
    return {
      schemaVersion: "1.1.0",
      query: normalized.query,
      evidence: [],
      noEvidence: true,
      retrievalTrace: {
        schemaVersion: "1.0.0",
        subqueries: [], routesUsed: [], candidateCount: 0, selectedCount: 0,
        sourceCap: 3, coverage: [], noEvidence: true,
      },
    };
  }

  const index = await FtsEvidenceIndex.open(databasePath, packageRoot);
  try {
    const result = index.searchMulti(normalized.query, normalized.limit);
    const evidence = result.evidence
      .map((item) => evidenceRefSchema.parse(item));
    return {
      schemaVersion: "1.1.0",
      query: normalized.query,
      evidence,
      noEvidence: evidence.length === 0,
      retrievalTrace: result.trace,
    };
  } finally {
    index.close();
  }
};
