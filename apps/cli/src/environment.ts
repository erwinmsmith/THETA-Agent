import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { repositoryRoot } from './repository-paths.js';

export const loadThetaProjectEnvironment = (): string | undefined => {
  const filename = path.resolve(
    process.env.THETA_ENV_FILE ?? path.join(repositoryRoot, '.env'),
  );
  if (!existsSync(filename)) return undefined;
  loadEnvFile(filename);
  return filename;
};
