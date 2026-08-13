import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const lockPath = path.join(repositoryRoot, 'config', 'upstreams.lock.json');
const command = process.argv[2] ?? 'ensure';
const requestedNames = process.argv.slice(3);
const supportedCommands = new Set(['ensure', 'sync', 'update']);

if (!supportedCommands.has(command)) {
  fail(`Unsupported command: ${command}. Use ensure, sync, or update.`);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const entries = Object.entries(lock.dependencies);
const selected = requestedNames.length
  ? entries.filter(([name]) => requestedNames.includes(name))
  : entries;

if (requestedNames.length && selected.length !== requestedNames.length) {
  const known = entries.map(([name]) => name).join(', ');
  fail(`Unknown dependency name. Available dependencies: ${known}.`);
}

for (const [name, dependency] of selected) {
  if (command === 'ensure') ensureDependency(name, dependency);
  if (command === 'sync') syncDependency(name, dependency);
  if (command === 'update') updateDependency(name, dependency);
}

function ensureDependency(name, dependency) {
  const directory = resolveDirectory(dependency);
  const existed = existsSync(path.join(directory, '.git'));
  const checkout = ensureCheckout(name, dependency);
  verifyRemote(name, checkout, dependency.repository);
  const revision = git(checkout, ['rev-parse', 'HEAD']);
  const state = revision === dependency.revision ? 'pinned' : 'different';
  const dirty = isDirty(checkout) ? ', dirty' : '';
  const action = existed ? 'available' : `cloned latest ${dependency.branch}`;
  console.log(
    `${name}: ${action}; ${state}${dirty}; local ${short(revision)}; pinned ${short(dependency.revision)}.`,
  );
}

if (command === 'update') {
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log(`Updated ${path.relative(repositoryRoot, lockPath)}.`);
}

function syncDependency(name, dependency) {
  const directory = ensureCheckout(name, dependency);
  requireClean(name, directory);
  verifyRemote(name, directory, dependency.repository);
  git(directory, ['fetch', '--prune', 'origin', dependency.branch]);
  git(directory, ['checkout', '--detach', dependency.revision]);
  console.log(`${name}: synchronized to ${short(dependency.revision)}.`);
}

function updateDependency(name, dependency) {
  const directory = ensureCheckout(name, dependency);
  requireClean(name, directory);
  verifyRemote(name, directory, dependency.repository);
  git(directory, ['fetch', '--prune', 'origin', dependency.branch]);
  const revision = git(directory, ['rev-parse', `origin/${dependency.branch}`]);
  git(directory, ['checkout', '--detach', revision]);
  dependency.revision = revision;
  console.log(`${name}: advanced to ${dependency.branch}@${short(revision)}.`);
}

function ensureCheckout(name, dependency) {
  const directory = resolveDirectory(dependency);
  if (existsSync(path.join(directory, '.git'))) return directory;
  if (existsSync(directory)) {
    fail(`${name}: ${dependency.directory} exists but is not a Git checkout.`);
  }
  mkdirSync(path.dirname(directory), { recursive: true });
  execFileSync(
    'git',
    [
      'clone',
      '--filter=blob:none',
      '--single-branch',
      '--branch',
      dependency.branch,
      dependency.repository,
      directory,
    ],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );
  return directory;
}

function verifyRemote(name, directory, expected) {
  const actual = git(directory, ['remote', 'get-url', 'origin']);
  const normalize = (value) => value.replace(/\.git$/, '').toLowerCase();
  if (normalize(actual) !== normalize(expected)) {
    fail(`${name}: origin is ${actual}; expected ${expected}.`);
  }
}

function requireClean(name, directory) {
  if (isDirty(directory)) {
    fail(`${name}: local checkout is dirty. Preserve or discard its changes before synchronization.`);
  }
}

function isDirty(directory) {
  return git(directory, ['status', '--porcelain']).length > 0;
}

function resolveDirectory(dependency) {
  const directory = path.resolve(repositoryRoot, dependency.directory);
  const thirdPartyRoot = path.join(repositoryRoot, 'third_party');
  if (directory !== thirdPartyRoot && !directory.startsWith(`${thirdPartyRoot}${path.sep}`)) {
    fail(`Unsafe dependency directory outside third_party: ${dependency.directory}.`);
  }
  return directory;
}

function git(directory, args) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function short(revision) {
  return revision.slice(0, 12);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
