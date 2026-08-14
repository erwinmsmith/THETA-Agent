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
