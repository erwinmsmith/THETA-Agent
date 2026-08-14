import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createInferenceProviderFromEnv,
  configureInferenceSettings,
  getInferenceSettingsView,
  listInferenceProviders,
  resetInferenceSelection,
  resolveInferenceSelection,
  selectInferenceModel,
} from '../tools/dist/support/providers/registry.js';

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'theta-provider-check-'));
const selectionFile = path.join(temporaryRoot, 'selection.json');
const settingsFile = path.join(temporaryRoot, 'settings.json');
const secretsFile = path.join(temporaryRoot, 'secrets.json');
const settingsFiles = { settingsFile, secretsFile, selectionFile };
const environmentKeys = [
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'THETA_LLM_PROVIDER',
  'THETA_LLM_MODEL',
];
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);

try {
  process.env.OPENAI_API_KEY = 'offline-test-key';
  process.env.OPENAI_MODEL = 'environment-model';
  process.env.THETA_LLM_PROVIDER = 'openai';
  process.env.THETA_LLM_MODEL = 'environment-model';

  assert.deepEqual(resolveInferenceSelection({ selectionFile }), {
    providerId: 'openai',
    model: 'environment-model',
    source: 'environment',
  });

  selectInferenceModel('openai', 'saved-model', selectionFile);
  assert.deepEqual(resolveInferenceSelection({ selectionFile }), {
    providerId: 'openai',
    model: 'saved-model',
    source: 'saved',
  });
  assert.equal(
    listInferenceProviders(selectionFile).find((item) => item.id === 'openai')?.selected,
    true,
  );

  const settings = configureInferenceSettings({
    llm: {
      providerId: 'openai',
      model: 'saved-model',
      baseUrl: 'https://example.test/v1',
      apiKey: 'private-offline-key',
      reasoningMode: 'reasoning',
      reasoningEffort: 'high',
      reasoningBudgetTokens: 4096,
      streaming: true,
      typewriter: true,
      typewriterSpeedMs: 12,
      models: ['saved-model', 'alternate-model'],
    },
    embedding: {
      enabled: true,
      providerId: 'openai',
      model: 'text-embedding-test',
      baseUrl: 'https://example.test/v1',
      apiKey: 'private-embedding-key',
      dimensions: 1024,
    },
  }, settingsFiles);
  assert.equal(settings.llm.apiKeyConfigured, true);
  assert.equal(settings.embedding.apiKeyConfigured, true);
  assert.equal(JSON.stringify(settings).includes('private-offline-key'), false);
  assert.equal(getInferenceSettingsView(settingsFiles).llm.reasoningEffort, 'high');
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  assert.match(readFileSync(secretsFile, 'utf8'), /private-offline-key/u);

  let requestBody;
  const provider = createInferenceProviderFromEnv({
    ...settingsFiles,
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      if (requestBody.stream) {
        return new Response([
          'data: {"id":"stream-1","choices":[{"delta":{"content":"{\\"answer\\":"}}]}\n\n',
          'data: {"id":"stream-1","choices":[{"delta":{"content":"\\"ok\\"}"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
          'data: [DONE]\n\n',
        ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(
        JSON.stringify({
          id: 'offline-response',
          choices: [{ message: { content: '{"answer":"ok"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  assert.ok(provider);
  const response = await provider.infer({
    runId: 'offline-provider-check',
    stepId: 'infer',
    modelAlias: 'selected-model',
    input: { messages: [{ role: 'user', content: 'Return JSON.' }] },
    options: { maxTokens: 64 },
  });
  assert.equal(requestBody.model, 'saved-model');
  assert.equal(requestBody.reasoning_effort, 'high');
  assert.equal(requestBody.temperature, undefined);
  assert.deepEqual(response.output, { answer: 'ok' });
  assert.equal(response.metadata?.providerId, 'openai');

  const streamed = [];
  for await (const event of provider.stream({
    runId: 'offline-provider-stream-check',
    stepId: 'stream',
    modelAlias: 'selected-model',
    input: { messages: [{ role: 'user', content: 'Return streamed JSON.' }] },
    options: { maxTokens: 64 },
  })) streamed.push(event);
  assert.equal(requestBody.stream, true);
  assert.equal(streamed.at(-1)?.output.kind, 'stream_done');
  assert.equal(streamed.at(-1)?.output.content, '{"answer":"ok"}');
  assert.equal(streamed.at(-1)?.usage?.totalTokens, 5);

  assert.deepEqual(resetInferenceSelection(selectionFile), {
    providerId: 'openai',
    model: 'environment-model',
    source: 'environment',
  });
  console.log('PASS Provider selection, private settings, reasoning, and streaming adapter.');
} finally {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
