import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(
  process.argv[2] ?? path.join(repositoryRoot, '..', 'Hypha', '.env'),
);
const target = path.join(repositoryRoot, '.env');
const template = path.join(repositoryRoot, '.env.example');

if (!existsSync(source)) {
  throw new Error(`Hypha environment file was not found at ${source}.`);
}

const sourceValues = parseEnvironment(readFileSync(source, 'utf8'));
const deepseekKey = sourceValues.get('DEEPSEEK_API_KEY');
if (!deepseekKey) {
  throw new Error('Hypha DEEPSEEK_API_KEY is missing or empty.');
}

const base = existsSync(target)
  ? readFileSync(target, 'utf8')
  : readFileSync(template, 'utf8');
const updates = new Map([
  ['THETA_LLM_PROVIDER', 'deepseek'],
  ['THETA_LLM_MODEL', sourceValues.get('DEEPSEEK_MODEL') ?? 'deepseek-v4-flash'],
  ['DEEPSEEK_API_KEY', deepseekKey],
  ['DEEPSEEK_BASE_URL', sourceValues.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/v1'],
  ['DEEPSEEK_MODEL', sourceValues.get('DEEPSEEK_MODEL') ?? 'deepseek-v4-flash'],
]);

writeFileSync(target, mergeEnvironment(base, updates), {
  encoding: 'utf8',
  mode: 0o600,
});
chmodSync(target, 0o600);
console.log(`Imported DeepSeek configuration from ${source} into the ignored repository .env.`);

function parseEnvironment(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    values.set(match[1], unquote(match[2].trim()));
  }
  return values;
}

function mergeEnvironment(content, updates) {
  const seen = new Set();
  const lines = content.split(/\r?\n/u).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
    if (!match || !updates.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${quote(updates.get(match[1]))}`;
  });
  for (const [key, value] of updates) {
    if (!seen.has(key)) lines.push(`${key}=${quote(value)}`);
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quote(value) {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value)
    ? value
    : JSON.stringify(value);
}
