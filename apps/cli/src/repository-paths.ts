import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const repositoryRoot = path.resolve(
  process.env.THETA_AGENT_REPOSITORY_ROOT ?? path.join(packageRoot, '..', '..'),
);

export const thetaUpstreamRoot = path.resolve(
  process.env.THETA_UPSTREAM_ROOT ??
    path.join(repositoryRoot, 'third_party', 'THETA'),
);

export const hyphaUpstreamRoot = path.resolve(
  process.env.HYPHA_UPSTREAM_ROOT ??
    path.join(repositoryRoot, 'third_party', 'Hypha'),
);

export const thetaBridgePackageRoot = path.join(
  repositoryRoot,
  'packages',
  'theta_agent_bridge',
);

export const upstreamLockPath = path.join(
  repositoryRoot,
  'config',
  'upstreams.lock.json',
);

export const uvPythonExecutable = path.join(
  repositoryRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);
