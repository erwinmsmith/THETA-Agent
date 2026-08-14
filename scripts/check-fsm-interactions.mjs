import assert from 'node:assert/strict';
import {
  buildThetaAgentInteraction,
  buildThetaWorkspaceInteraction,
} from '../agent/dist/interaction-service.js';
import { ThetaNaturalLanguageService } from '../tools/dist/support/language/natural-service.js';

const entry = buildThetaWorkspaceInteraction();
assert.equal(entry.source, 'fsm');
assert.equal(entry.state, 'Intake');
assert.equal(entry.card?.kind, 'dataset_upload');

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

console.log('PASS FSM interactions drive cards and deterministic fallback executes no Tool.');
