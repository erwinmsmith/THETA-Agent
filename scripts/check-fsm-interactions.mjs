import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildThetaAgentInteraction,
  buildThetaWorkspaceInteraction,
} from '../agent/dist/interaction-service.js';
import { SQLiteConversationStore } from '../agent/dist/storage/sqlite-conversation-store.js';
import { listLocalRuns, pinLocalRun, renameLocalRun } from '../agent/dist/storage/run-catalog.js';
import { buildDatasetFacts, buildDeterministicUnderstanding } from '../agent/dist/dataset-understanding/service.js';
import { ThetaNaturalLanguageService } from '../tools/dist/support/language/natural-service.js';
import { runThetaModelCatalog } from '../tools/dist/hypha-runner.js';

const entry = buildThetaWorkspaceInteraction();
assert.equal(entry.source, 'fsm');
assert.equal(entry.state, 'Intake');
assert.equal(entry.card, undefined);
assert.deepEqual(entry.reasoning.allowedTools, ['theta.rag.search', 'theta.model.catalog']);

const requestedDataset = buildThetaWorkspaceInteraction(true);
assert.equal(requestedDataset.card?.kind, 'dataset_upload');

const planReview = buildThetaAgentInteraction({
  status: 'waiting_human',
  currentState: 'AwaitPlanCreationApproval',
  pendingActionRef: 'theta.plan.review',
  pendingReason: 'Plan review is required.',
});
assert.equal(planReview.card?.kind, 'plan_review');
assert.deepEqual(planReview.reasoning.allowedTools, []);
assert.deepEqual(planReview.reasoning.nextStates, [
  'CreatePlan',
  'ValidatePlan',
  'RecommendModel',
]);

const planning = buildThetaAgentInteraction({
  status: 'running',
  currentState: 'RecommendModel',
});
assert.ok(planning.reasoning.allowedTools.includes('theta.model.catalog'));
assert.ok(planning.reasoning.allowedTools.includes('theta.rag.search'));

const deterministic = await new ThetaNaturalLanguageService().generate({
  schemaVersion: '1.0.0',
  task: 'propose_readonly_tool',
  text: '列出所有模型并查看知识库',
  currentState: 'RecommendModel',
  allowedToolIds: ['theta.model.catalog', 'theta.rag.search'],
});
assert.equal(deterministic.output.task, 'propose_readonly_tool');
assert.equal(deterministic.output.toolId, null);
assert.equal(deterministic.output.confidence, 0);

const exploredDataset = {
  datasetRef: 'dataset.content-test',
  datasetHash: 'a'.repeat(64),
  fileName: 'content.csv',
  format: 'csv',
  sizeBytes: 120,
  encoding: 'utf-8',
  delimiter: ',',
  sheets: [],
  selectedSheet: null,
  rowCount: 3,
  columns: ['id', 'text'],
  columnProfiles: [
    { name: 'id', inferredType: 'number', missingRatio: 0, uniqueCount: 3, uniqueRatio: 1, averageLength: 1, maximumLength: 1, parseSuccessRatio: 1, sampleValues: ['1', '2', '3'] },
    { name: 'text', inferredType: 'text', missingRatio: 0, uniqueCount: 3, uniqueRatio: 1, averageLength: 32, maximumLength: 45, parseSuccessRatio: 0, sampleValues: [] },
  ],
  sampleRows: [
    { id: 1, text: 'Climate policy expands renewable energy investment.' },
    { id: 2, text: 'Schools discuss digital learning and teacher support.' },
    { id: 3, text: 'Renewable energy projects reduce urban emissions.' },
  ],
  sampleSeed: 'content-test',
  samplePolicy: { method: 'deterministic_reservoir', requestedRows: 10, returnedRows: 3, profileRows: 3, profileTruncated: false },
  sampleTruncated: false,
  outputTruncated: false,
  redactionSummary: { applied: false, redactedValueCount: 0, rules: [] },
  candidateRoles: {
    text: [{ name: 'text', score: 0.92, reason: 'Long natural-language values.' }],
    time: [], id: [{ name: 'id', score: 0.9, reason: 'Unique identifier.' }],
    group: [], covariate: [], evaluation: [], metadata: [], ignored: [],
  },
  languageDistribution: [{ language: 'en', ratio: 1 }],
  duplicateRatio: 0,
  timeCoverage: { start: null, end: null },
  inferredDomain: { label: 'public policy and education', confidence: 0.7, evidence: ['sample text'] },
  qualityWarnings: [],
};
const contentFacts = buildDatasetFacts(exploredDataset);
const contentUnderstanding = buildDeterministicUnderstanding(contentFacts, exploredDataset);
assert.equal(contentUnderstanding.contentSummary.sampledDocumentCount, 3);
assert.equal(contentUnderstanding.contentSummary.sampleExcerpts[0]?.text, exploredDataset.sampleRows[0].text);
assert.match(contentUnderstanding.contentSummary.summary, /已实际读取 3 条脱敏样本/);
assert.ok(contentUnderstanding.contentSummary.contentKeywords.includes('renewable'));
assert.ok(contentUnderstanding.evidenceReferences.some((entry) => entry.kind === 'sample_row'));

let capturedToolTrace = [];
const catalogResult = await runThetaModelCatalog({}, {
  onTrace: (events) => { capturedToolTrace = events; },
});
assert.equal(catalogResult.status, 'completed');
assert.ok(capturedToolTrace.some((event) => event.type === 'tool.call.requested'));
assert.ok(capturedToolTrace.some((event) => event.type === 'tool.policy.checked'));
assert.ok(capturedToolTrace.some((event) => event.type === 'tool.call.completed'));

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'theta-agent-interactions-'));
try {
  const runtimeDb = path.join(temporaryRoot, 'runtime.sqlite');
  const store = new SQLiteConversationStore(runtimeDb);
  store.getOrCreateSession('memory-test');
  store.appendMessage({
    messageId: 'message.user.1',
    sessionId: 'memory-test',
    role: 'user',
    messageKind: 'conversation.text',
    content: 'Compare themes in customer feedback.',
    createdAt: new Date().toISOString(),
  });
  const memory = store.refreshMemory('memory-test');
  assert.equal(memory.sourceMessageCount, 1);
  assert.deepEqual(memory.recentUserGoals, ['Compare themes in customer feedback.']);
  assert.equal(store.getMemory('memory-test')?.summary, memory.summary);
  store.recordLanguageInterpretation({
    interpretationId: 'interpretation.usage.1',
    sessionId: 'memory-test',
    task: 'compose_grounded_response',
    provider: 'provider',
    requestHash: 'request-hash',
    responseHash: 'response-hash',
    structuredOutput: {
      telemetry: { inputTokens: 120, outputTokens: 35, totalTokens: 155 },
    },
    status: 'completed',
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(store.getTokenUsage('memory-test'), {
    inputTokens: 120,
    outputTokens: 35,
    totalTokens: 155,
    calls: 1,
  });

  const workspaceSessionId = 'theta-web-workspace-history-test';
  store.getOrCreateSession(workspaceSessionId);
  store.appendMessage({
    messageId: 'message.workspace.1',
    sessionId: workspaceSessionId,
    role: 'user',
    messageKind: 'conversation.text',
    content: 'Help me understand what THETA can research.',
    createdAt: new Date().toISOString(),
  });
  store.refreshMemory(workspaceSessionId);
  assert.equal(store.listWorkspaceSessions()[0]?.sessionId, workspaceSessionId);
  assert.equal(store.renameSession(workspaceSessionId, 'Capability discussion').title, 'Capability discussion');
  assert.equal(store.pinSession(workspaceSessionId, true).pinned, true);
  assert.equal(store.listWorkspaceSessions()[0]?.pinned, true);
  assert.equal(store.deleteSession(workspaceSessionId), true);
  assert.equal(store.listWorkspaceSessions().length, 0);
  store.close();

  const database = new DatabaseSync(runtimeDb);
  database.exec(`
    CREATE TABLE runtime_events (
      run_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `);
  database.prepare('INSERT INTO runtime_events VALUES (?, ?, ?, ?)').run(
    'run.test',
    new Date().toISOString(),
    'run.started',
    JSON.stringify({ payload: { input: {} } }),
  );
  database.close();
  renameLocalRun('run.test', 'Renamed research', runtimeDb);
  pinLocalRun('run.test', true, runtimeDb);
  assert.equal(listLocalRuns(runtimeDb)[0]?.displayName, 'Renamed research');
  assert.equal(listLocalRuns(runtimeDb)[0]?.pinned, true);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('PASS FSM interactions, memory, history metadata, and no-keyword fallback.');
