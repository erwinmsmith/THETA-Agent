import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documents = ['docs/CLI.md', 'docs/CLI.zh-CN.md'];
const directCommands = [
  'doctor', 'start', 'resume', 'answer', 'columns', 'status', 'audit export',
  'plan show', 'plan approve', 'train status', 'train cancel', 'evidence show',
  'rag build', 'rag status', 'language intent', 'language question',
  'language explain', 'model list', 'model current', 'model use', 'model reset',
  'repl', 'dataset inspect', 'dataset detect-columns', 'dataset register',
  'dataset explore', 'dataset understanding', 'dataset confirm', 'models',
  'recommend', 'plan validate', 'plan create', 'training dry-run',
  'training start', 'training status', 'training cancel', 'workflow compile',
  'workflow run', 'workflow resume', 'workflow status', 'workflow trace',
  'workflow replay', 'demo',
];
const replCommands = [
  '/help', '/start', '/answer', '/columns', '/llm', '/model', '/brief',
  '/history', '/next', '/done', '/details', '/status', '/why', '/evidence', '/plan',
  '/approve-plan', '/start-training', '/approve', '/adjust', '/follow', '/logs',
  '/results', '/open-results', '/summary', '/runs', '/cancel', '/retry',
  '/reevaluate', '/save', '/back', '/exit',
];

for (const filename of documents) {
  const content = readFileSync(path.join(root, filename), 'utf8');
  const missing = [...directCommands, ...replCommands].filter(
    (command) => !content.includes(command),
  );
  if (missing.length) {
    throw new Error(`${filename} is missing CLI entries: ${missing.join(', ')}`);
  }
}

for (const filename of [
  'fixtures/cli/workflow-input.json',
  'fixtures/cli/dataset-confirmation.json',
  'fixtures/cli/plan-adjustment.json',
]) {
  JSON.parse(readFileSync(path.join(root, filename), 'utf8'));
}

console.log('PASS English and Chinese CLI references cover every direct and REPL command.');
