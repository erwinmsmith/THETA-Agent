import { rm } from "node:fs/promises";
import path from "node:path";

const target = process.argv[2];
if (!target) throw new Error("A package output directory is required.");
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const resolved = path.resolve(repositoryRoot, target);
if (!resolved.startsWith(`${repositoryRoot}${path.sep}`) || path.basename(resolved) !== "dist") {
  throw new Error(`Refusing to clean an unsafe package path: ${target}`);
}
await rm(resolved, { recursive: true, force: true });
