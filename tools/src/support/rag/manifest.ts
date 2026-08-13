import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  knowledgeManifestSchema,
  type KnowledgeManifest,
  type KnowledgeSource,
} from "@theta-agent/domain/rag/contracts.js";

export interface ResolvedKnowledgeSource extends KnowledgeSource {
  absolutePath: string;
  relativePath: string;
}

export interface ResolvedKnowledgeObjectSet {
  absolutePath: string;
  relativePath: string;
  sourceCommit: string;
}

export const loadKnowledgeManifest = async (
  manifestPath: string,
  packageRoot: string,
): Promise<KnowledgeManifest> => {
  const raw = await readFile(manifestPath, "utf8");
  return knowledgeManifestSchema.parse(parse(raw));
};

export const resolveKnowledgeSources = (
  manifest: KnowledgeManifest,
  packageRoot: string,
): ResolvedKnowledgeSource[] => {
  const allowedRoot = path.resolve(packageRoot, "..");
  return manifest.sources.map((source) => {
    const absolutePath = path.resolve(packageRoot, source.path);
    const relative = path.relative(allowedRoot, absolutePath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Knowledge source '${source.sourceId}' escapes the theta_project boundary.`,
      );
    }
    return {
      ...source,
      absolutePath,
      relativePath: relative.split(path.sep).join("/"),
    };
  });
};

export const resolveKnowledgeObjectSets = (
  manifest: KnowledgeManifest,
  packageRoot: string,
): ResolvedKnowledgeObjectSet[] => {
  const allowedRoot = path.resolve(packageRoot, "..");
  return manifest.objectSets.map((objectSet) => {
    const absolutePath = path.resolve(packageRoot, objectSet.path);
    const relative = path.relative(allowedRoot, absolutePath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Knowledge object set '${objectSet.path}' escapes the theta_project boundary.`);
    }
    return {
      ...objectSet,
      absolutePath,
      relativePath: relative.split(path.sep).join("/"),
    };
  });
};
