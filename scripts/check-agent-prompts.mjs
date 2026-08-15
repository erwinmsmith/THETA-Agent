import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const promptFiles = [
  'agent/src/dataset-understanding/correction-service.ts',
  'agent/src/planner/service.ts',
  'agent/src/research/research-intent-interpreter.ts',
  'agent/src/results/result-analysis-service.ts',
  'tools/src/dataset-understanding-language-tool.ts',
  'tools/src/support/language/natural-service.ts',
  'tools/src/support/language/service.ts',
  'tools/src/support/planner/native-service.ts',
];

const identity = readFileSync('tools/src/support/language/agent-identity.ts', 'utf8');
assert.match(identity, /specialized Agent for topic modeling, text mining, and data analysis/u);
assert.match(identity, /governed training plans/u);
assert.match(identity, /interpreting trained topics, metrics, tables, visualizations/u);

for (const filename of promptFiles) {
  const source = readFileSync(filename, 'utf8');
  assert.match(
    source,
    /THETA_AGENT_(?:MISSION|SYSTEM)_PROMPT/u,
    `${filename} must inherit the shared THETA Agent identity.`,
  );
}

const auditedSources = [
  ...promptFiles,
  'agent/src/conversation/turn-orchestrator.ts',
  'apps/cli/src/agent-cli.ts',
  'apps/web/src/App.tsx',
  'README.md',
  'README.zh-CN.md',
  'docs/ARCHITECTURE.md',
].map((filename) => readFileSync(filename, 'utf8')).join('\n');

for (const legacyIdentity of [
  '猫咪科学家',
  'THETA research-training assistant',
  'THETA dataset-understanding agent',
  'THETA autonomous research agent',
  '主题建模是系统首个研究能力',
]) {
  assert.equal(
    auditedSources.includes(legacyIdentity),
    false,
    `Legacy Agent identity remains: ${legacyIdentity}`,
  );
}

console.log(`PASS ${promptFiles.length} prompt modules inherit the specialized THETA Agent identity.`);
