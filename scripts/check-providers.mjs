import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createInferenceProviderFromEnv,
  listInferenceProviders,
  resetInferenceSelection,
  resolveInferenceSelection,
  selectInferenceModel,
} from '../tools/dist/support/providers/registry.js';

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'theta-provider-check-'));
const selectionFile = path.join(temporaryRoot, 'selection.json');
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

  let requestBody;
  const provider = createInferenceProviderFromEnv({
    selectionFile,
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
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
  assert.deepEqual(response.output, { answer: 'ok' });
  assert.equal(response.metadata?.providerId, 'openai');

  assert.deepEqual(resetInferenceSelection(selectionFile), {
    providerId: 'openai',
    model: 'environment-model',
    source: 'environment',
  });
  console.log('PASS Provider registry selection, persistence, fallback, and request adapter.');
} finally {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
