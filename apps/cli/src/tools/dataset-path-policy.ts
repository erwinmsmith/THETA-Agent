import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot, thetaUpstreamRoot } from '../repository-paths.js';

const supportedDatasetSuffixes = new Set([
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.txt',
  '.xlsx',
  '.xls',
  '.parquet',
]);
const defaultMaxDatasetBytes = 100 * 1024 * 1024;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(moduleDirectory, '..', '..');
const projectRoot = repositoryRoot;

const configuredMaxDatasetBytes = (): number => {
  const configured = Number.parseInt(process.env.THETA_MAX_DATASET_BYTES ?? '', 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : defaultMaxDatasetBytes;
};

const configuredAllowedRoots = (): string[] => {
  const configured = process.env.THETA_ALLOWED_DATA_ROOTS;
  if (configured?.trim()) {
    return configured
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (isAbsolute(entry) ? entry : resolve(projectRoot, entry)));
  }

  return [resolve(agentRoot, 'fixtures'), resolve(thetaUpstreamRoot, 'data')];
};

const isWithinRoot = (candidate: string, root: string): boolean => {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  );
};

export interface ResolvedDatasetFile {
  filePath: string;
  allowedRoot: string;
  sizeBytes: number;
  suffix: string;
}

export const resolveDatasetFile = async (filePath: string): Promise<ResolvedDatasetFile> => {
  const requestedPath = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    throw new Error(`Dataset file does not exist: ${requestedPath}`);
  }

  const roots = await Promise.all(
    configuredAllowedRoots().map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        throw new Error(`Configured dataset root does not exist: ${root}`);
      }
    })
  );
  const allowedRoot = roots.find((root) => isWithinRoot(canonicalPath, root));
  if (!allowedRoot) {
    throw new Error(`Dataset file is outside THETA_ALLOWED_DATA_ROOTS: ${canonicalPath}`);
  }

  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) {
    throw new Error(`Dataset path is not a regular file: ${canonicalPath}`);
  }

  const suffix = extname(canonicalPath).toLowerCase();
  if (!supportedDatasetSuffixes.has(suffix)) {
    throw new Error(
      `Unsupported dataset suffix "${suffix}". Supported: ${[...supportedDatasetSuffixes].join(
        ', '
      )}`
    );
  }

  const maxBytes = configuredMaxDatasetBytes();
  if (fileStat.size > maxBytes) {
    throw new Error(
      `Dataset file exceeds THETA_MAX_DATASET_BYTES (${fileStat.size} > ${maxBytes}).`
    );
  }

  return {
    filePath: canonicalPath,
    allowedRoot,
    sizeBytes: fileStat.size,
    suffix,
  };
};
