import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const lockPath = path.join(repositoryRoot, 'config', 'upstreams.lock.json');
const command = process.argv[2] ?? 'status';
const requestedNames = process.argv.slice(3);
const supportedCommands = new Set(['status', 'sync', 'update']);

if (!supportedCommands.has(command)) {
  fail(`Unsupported command: ${command}. Use status, sync, or update.`);
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
  if (command === 'status') showStatus(name, dependency);
  if (command === 'sync') syncDependency(name, dependency);
  if (command === 'update') updateDependency(name, dependency);
}

if (command === 'update') {
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log(`Updated ${path.relative(repositoryRoot, lockPath)}.`);
}

function showStatus(name, dependency) {
  const directory = resolveDirectory(dependency);
  if (!existsSync(path.join(directory, '.git'))) {
    console.log(`${name}: missing; pinned ${short(dependency.revision)}`);
    return;
  }
  const head = git(directory, ['rev-parse', 'HEAD']);
  const state = head === dependency.revision ? 'pinned' : 'different';
  const dirty = isDirty(directory) ? ', dirty' : '';
  console.log(`${name}: ${state}${dirty}; local ${short(head)}; pinned ${short(dependency.revision)}`);
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
