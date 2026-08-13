import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const tracked = git(['ls-files']);
for (const filename of tracked.split('\n').filter(Boolean)) {
  if (filename.startsWith('third_party/')) {
    failures.push(`Third-party source is tracked: ${filename}.`);
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
