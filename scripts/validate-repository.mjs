import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const failures = [];
const lock = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'config', 'upstreams.lock.json'), 'utf8'),
);

for (const [name, dependency] of Object.entries(lock.dependencies ?? {})) {
  if (!/^https:\/\/github\.com\/.+\.git$/.test(dependency.repository ?? '')) {
    failures.push(`${name} has an invalid GitHub repository URL.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(dependency.revision ?? '')) {
    failures.push(`${name} does not have a 40-character Git revision.`);
  }
  if (!String(dependency.directory ?? '').startsWith('third_party/')) {
    failures.push(`${name} is not isolated under third_party/.`);
  }
}

const repositoryFiles = git([
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
]);
for (const filename of repositoryFiles.split('\n').filter(Boolean)) {
  if (!existsSync(path.join(repositoryRoot, filename))) continue;
  if (filename.startsWith('third_party/')) {
    failures.push(`Third-party source is tracked: ${filename}.`);
  }
  if (filename.startsWith('packages/')) {
    failures.push(`Legacy packages/ layout remains: ${filename}.`);
  }
  if (filename.startsWith('apps/cli/knowledge/')) {
    failures.push(`Knowledge must be repository-level: ${filename}.`);
  }
  if (filename.startsWith('apps/cli/fixtures/')) {
    failures.push(`Fixtures must be repository-level: ${filename}.`);
  }
}

for (const directory of ['agent', 'domain', 'tools', 'skills', 'knowledge']) {
  const target = path.join(repositoryRoot, directory);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    failures.push(`Required architecture directory is missing: ${directory}/.`);
  }
}

const allowedCliSources = new Set([
  'apps/cli/src/agent-cli.ts',
  'apps/cli/src/cli.ts',
  'apps/cli/src/theta-workflow-cli.ts',
  'apps/cli/src/presentation/terminal-renderer.ts',
]);
for (const filename of repositoryFiles.split('\n').filter((entry) =>
  entry.startsWith('apps/cli/src/') && entry.endsWith('.ts')
)) {
  if (!existsSync(path.join(repositoryRoot, filename))) continue;
  if (!allowedCliSources.has(filename)) {
    failures.push(`CLI contains non-adapter implementation code: ${filename}.`);
  }
  const source = readFileSync(path.join(repositoryRoot, filename), 'utf8');
  if (/from\s+['"](?:@theta-agent\/(?:domain|tools)|@hypha\/)/.test(source)) {
    failures.push(`CLI bypasses the Agent API boundary: ${filename}.`);
  }
}

const gitlinks = git(['ls-files', '--stage'])
  .split('\n')
  .filter((line) => line.startsWith('160000 '));
if (gitlinks.length) {
  failures.push('Git submodules are not allowed; upstream source must remain ignored.');
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}

console.log('PASS Repository dependency boundaries are valid.');

function git(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
