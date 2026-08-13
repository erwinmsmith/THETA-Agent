import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from '../repository-paths.js';
import { OpenAICompatibleInferenceProvider } from './openai-compatible.js';

export const INFERENCE_PROVIDER_IDS = [
  'deepseek',
  'minimax',
  'openai',
  'openrouter',
  'ollama',
  'custom',
] as const;

export type InferenceProviderId = (typeof INFERENCE_PROVIDER_IDS)[number];

export interface InferenceSelection {
  providerId: InferenceProviderId;
  model: string;
  source: 'saved' | 'environment' | 'legacy';
}

export interface InferenceProviderStatus {
  id: InferenceProviderId;
  displayName: string;
  protocol: 'openai-compatible';
  baseUrl: string;
  credentialConfigured: boolean;
  configured: boolean;
  configuredModel: string | null;
  selected: boolean;
  local: boolean;
}

export interface InferenceProviderFactoryOptions {
  providerId?: string;
  model?: string;
  timeoutMs?: number;
  selectionFile?: string;
  fetchImpl?: typeof fetch;
}

interface ProviderPreset {
  id: InferenceProviderId;
  displayName: string;
  baseUrl: () => string | undefined;
  apiKey: () => string | undefined;
  model: () => string | undefined;
  apiKeyRequired: boolean;
  local: boolean;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  headers?: () => Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

const presets: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: () => value(process.env.DEEPSEEK_BASE_URL) ?? 'https://api.deepseek.com/v1',
    apiKey: () => value(process.env.DEEPSEEK_API_KEY),
    model: () => value(process.env.DEEPSEEK_MODEL) ?? 'deepseek-v4-flash',
    apiKeyRequired: true,
    local: false,
    maxTokensField: 'max_tokens',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    baseUrl: () => value(process.env.MINIMAX_API_BASE) ?? 'https://api.minimax.io/v1',
    apiKey: () => value(process.env.MINIMAX_API_KEY),
    model: () => value(process.env.MINIMAX_MODEL) ?? 'MiniMax-M2.7',
    apiKeyRequired: true,
    local: false,
    maxTokensField: 'max_completion_tokens',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: () => value(process.env.OPENAI_BASE_URL) ?? 'https://api.openai.com/v1',
    apiKey: () => value(process.env.OPENAI_API_KEY),
    model: () => value(process.env.OPENAI_MODEL),
    apiKeyRequired: true,
    local: false,
    maxTokensField: 'max_completion_tokens',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: () => value(process.env.OPENROUTER_BASE_URL) ?? 'https://openrouter.ai/api/v1',
    apiKey: () => value(process.env.OPENROUTER_API_KEY),
    model: () => value(process.env.OPENROUTER_MODEL),
    apiKeyRequired: true,
    local: false,
    maxTokensField: 'max_tokens',
    headers: () => ({
      ...(value(process.env.OPENROUTER_HTTP_REFERER)
        ? { 'HTTP-Referer': value(process.env.OPENROUTER_HTTP_REFERER)! }
        : {}),
      'X-OpenRouter-Title': value(process.env.OPENROUTER_APP_TITLE) ?? 'THETA Agent',
    }),
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    baseUrl: () => value(process.env.OLLAMA_BASE_URL) ?? 'http://127.0.0.1:11434/v1',
    apiKey: () => value(process.env.OLLAMA_API_KEY),
    model: () => value(process.env.OLLAMA_MODEL),
    apiKeyRequired: false,
    local: true,
    maxTokensField: 'max_tokens',
  },
  {
    id: 'custom',
    displayName: 'Custom OpenAI-compatible',
    baseUrl: () => value(process.env.THETA_COMPAT_BASE_URL),
    apiKey: () => value(process.env.THETA_COMPAT_API_KEY),
    model: () => value(process.env.THETA_COMPAT_MODEL),
    apiKeyRequired: false,
    local: false,
    maxTokensField: 'max_tokens',
  },
];

export const inferenceSelectionFile = (): string =>
  path.resolve(
    process.env.THETA_INFERENCE_SELECTION_FILE ??
      path.join(
        process.env.THETA_AGENT_STATE_DIR ?? path.join(repositoryRoot, '.theta_agent'),
        'inference-selection.json',
      ),
  );

export const listInferenceProviders = (
  selectionFile = inferenceSelectionFile(),
): InferenceProviderStatus[] => {
  const active = resolveInferenceSelection({ selectionFile });
  return presets.map((preset) => {
    const baseUrl = preset.baseUrl() ?? '';
    const selectedModel =
      active?.providerId === preset.id ? active.model : preset.model();
    const credentialConfigured =
      !preset.apiKeyRequired || Boolean(preset.apiKey());
    return {
      id: preset.id,
      displayName: preset.displayName,
      protocol: 'openai-compatible',
      baseUrl,
      credentialConfigured,
      configured: Boolean(baseUrl && selectedModel && credentialConfigured),
      configuredModel: selectedModel ?? null,
      selected: active?.providerId === preset.id,
      local: preset.local,
    };
  });
};

export const resolveInferenceSelection = (
  options: { selectionFile?: string } = {},
): InferenceSelection | undefined => {
  const saved = readSelection(options.selectionFile ?? inferenceSelectionFile());
  if (saved) return { ...saved, source: 'saved' };

  const requestedProvider = value(process.env.THETA_LLM_PROVIDER);
  if (requestedProvider) {
    const preset = requirePreset(requestedProvider);
    const model = value(process.env.THETA_LLM_MODEL) ?? preset.model();
    return model
      ? { providerId: preset.id, model, source: 'environment' }
      : undefined;
  }

  for (const preset of presets) {
    const model = preset.model();
    if (model && credentialsAvailable(preset)) {
      return { providerId: preset.id, model, source: 'legacy' };
    }
  }
  return undefined;
};

export const selectInferenceModel = (
  providerId: string,
  model: string,
  selectionFile = inferenceSelectionFile(),
): InferenceSelection => {
  const preset = requirePreset(providerId);
  const normalizedModel = requiredModel(model);
  if (!preset.baseUrl()) {
    throw new Error(`${preset.displayName} requires its API base URL environment variable.`);
  }
  if (!credentialsAvailable(preset)) {
    throw new Error(
      `${preset.displayName} credentials are not configured. Add the provider API key to .env without committing it.`,
    );
  }
  const selection = { providerId: preset.id, model: normalizedModel };
  writeSelection(selectionFile, selection);
  return { ...selection, source: 'saved' };
};

export const resetInferenceSelection = (
  selectionFile = inferenceSelectionFile(),
): InferenceSelection | undefined => {
  try {
    writeFileSync(selectionFile, '', { flag: 'w', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return resolveInferenceSelection({ selectionFile });
};

export const isInferenceProviderConfigured = (): boolean =>
  createInferenceProviderFromEnv() !== undefined;

export const createInferenceProviderFromEnv = (
  options: InferenceProviderFactoryOptions = {},
): OpenAICompatibleInferenceProvider | undefined => {
  const selection =
    options.providerId || options.model
      ? explicitSelection(options)
      : resolveInferenceSelection({ selectionFile: options.selectionFile });
  if (!selection) return undefined;
  const preset = requirePreset(selection.providerId);
  const baseUrl = preset.baseUrl();
  if (!baseUrl || !credentialsAvailable(preset)) return undefined;
  return new OpenAICompatibleInferenceProvider({
    id: preset.id,
    displayName: preset.displayName,
    baseUrl,
    apiKey: preset.apiKey(),
    model: selection.model,
    timeoutMs:
      options.timeoutMs ??
      environmentTimeout(
        process.env[`${preset.id.toUpperCase()}_TIMEOUT_MS`] ??
          process.env.THETA_LLM_TIMEOUT_MS,
      ),
    fetchImpl: options.fetchImpl,
    headers: preset.headers?.(),
    maxTokensField: preset.maxTokensField,
    allowInsecureLocalhost: preset.local || preset.id === 'custom',
  });
};

const explicitSelection = (
  options: InferenceProviderFactoryOptions,
): InferenceSelection => {
  const current = resolveInferenceSelection({ selectionFile: options.selectionFile });
  const providerId = options.providerId ?? current?.providerId;
  if (!providerId) throw new Error('Inference provider ID is required.');
  const preset = requirePreset(providerId);
  const model = options.model ?? current?.model ?? preset.model();
  if (!model) throw new Error(`${preset.displayName} model is required.`);
  return { providerId: preset.id, model: requiredModel(model), source: 'environment' };
};

const readSelection = (
  filename: string,
): Omit<InferenceSelection, 'source'> | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.providerId !== 'string' || typeof parsed.model !== 'string') {
      return undefined;
    }
    return {
      providerId: requirePreset(parsed.providerId).id,
      model: requiredModel(parsed.model),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const writeSelection = (
  filename: string,
  selection: Omit<InferenceSelection, 'source'>,
): void => {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, filename);
};

const requirePreset = (providerId: string): ProviderPreset => {
  const normalized = providerId.trim().toLowerCase();
  const preset = presets.find((candidate) => candidate.id === normalized);
  if (!preset) {
    throw new Error(
      `Unknown inference provider '${providerId}'. Available: ${INFERENCE_PROVIDER_IDS.join(', ')}.`,
    );
  }
  return preset;
};

const credentialsAvailable = (preset: ProviderPreset): boolean =>
  (!preset.apiKeyRequired || Boolean(preset.apiKey())) && Boolean(preset.baseUrl());

const requiredModel = (model: string): string => {
  const normalized = model.trim();
  if (!normalized || normalized.length > 200 || /[\r\n\0]/u.test(normalized)) {
    throw new Error('Inference model must contain 1-200 safe characters.');
  }
  return normalized;
};

const environmentTimeout = (input: string | undefined): number => {
  if (!input?.trim()) return DEFAULT_TIMEOUT_MS;
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(
      `Provider timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
    );
  }
  return value;
};

const value = (input: string | undefined): string | undefined =>
  input?.trim() || undefined;
