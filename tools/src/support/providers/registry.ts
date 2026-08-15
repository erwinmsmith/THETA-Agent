import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from '../repository-paths.js';
import { OpenAICompatibleInferenceProvider } from './openai-compatible.js';
import {
  readInferenceSecrets,
  readInferenceSettings,
  updateInferenceSettings,
  type InferenceReasoningEffort,
  type InferenceReasoningMode,
  type InferenceSettingsFiles,
  type InferenceSettingsUpdate,
} from './settings.js';

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
  category: 'direct' | 'router' | 'local' | 'compatible';
  models: string[];
  capabilities: {
    streaming: boolean;
    reasoning: boolean;
    reasoningEffort: boolean;
  };
}

export interface InferenceSettingsView {
  llm: {
    providerId: InferenceProviderId | null;
    model: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
    reasoningMode: InferenceReasoningMode;
    reasoningEffort: InferenceReasoningEffort;
    reasoningBudgetTokens: number | null;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    streaming: boolean;
    typewriter: boolean;
    typewriterSpeedMs: number;
  };
  embedding: {
    enabled: boolean;
    providerId: string;
    model: string;
    baseUrl: string;
    dimensions: number | null;
    apiKeyConfigured: boolean;
  };
}

export interface InferenceProviderFactoryOptions {
  providerId?: string;
  model?: string;
  timeoutMs?: number;
  selectionFile?: string;
  fetchImpl?: typeof fetch;
  settingsFile?: string;
  secretsFile?: string;
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
  category: InferenceProviderStatus['category'];
  reasoning: boolean;
  reasoningEffort: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

const presets: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: () => value(process.env.DEEPSEEK_BASE_URL) ?? 'https://api.deepseek.com/v1',
    apiKey: () => value(process.env.DEEPSEEK_API_KEY),
    model: () => value(process.env.DEEPSEEK_MODEL) ?? 'deepseek-chat',
    apiKeyRequired: true,
    local: false,
    maxTokensField: 'max_tokens',
    category: 'direct',
    reasoning: true,
    reasoningEffort: false,
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
    category: 'direct',
    reasoning: true,
    reasoningEffort: false,
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
    category: 'direct',
    reasoning: true,
    reasoningEffort: true,
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
    category: 'router',
    reasoning: true,
    reasoningEffort: true,
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
    category: 'local',
    reasoning: true,
    reasoningEffort: false,
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
    category: 'compatible',
    reasoning: true,
    reasoningEffort: true,
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
  files: InferenceSettingsFiles = {},
): InferenceProviderStatus[] => {
  const active = resolveInferenceSelection({ selectionFile });
  const settings = readInferenceSettings(files);
  const secrets = readInferenceSecrets(files);
  return presets.map((preset) => {
    const override = settings.llm.providerOverrides[preset.id];
    const baseUrl = override?.baseUrl ?? preset.baseUrl() ?? '';
    const selectedModel =
      active?.providerId === preset.id ? active.model : preset.model();
    const credentialConfigured =
      !preset.apiKeyRequired || Boolean(secrets.llmApiKeys[preset.id] ?? preset.apiKey());
    const models = [...new Set([
      ...(override?.models ?? []),
      ...(selectedModel ? [selectedModel] : []),
      ...(preset.model() ? [preset.model()!] : []),
    ])];
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
      category: preset.category,
      models,
      capabilities: {
        streaming: true,
        reasoning: preset.reasoning,
        reasoningEffort: preset.reasoningEffort,
      },
    };
  });
};

export const getInferenceSettingsView = (
  files: InferenceSettingsFiles & { selectionFile?: string } = {},
): InferenceSettingsView => {
  const settings = readInferenceSettings(files);
  const secrets = readInferenceSecrets(files);
  const selection = resolveInferenceSelection({ selectionFile: files.selectionFile });
  const preset = selection ? requirePreset(selection.providerId) : undefined;
  const override = preset ? settings.llm.providerOverrides[preset.id] : undefined;
  return {
    llm: {
      providerId: selection?.providerId ?? null,
      model: selection?.model ?? '',
      baseUrl: override?.baseUrl ?? preset?.baseUrl() ?? '',
      apiKeyConfigured: Boolean(
        preset && (!preset.apiKeyRequired || secrets.llmApiKeys[preset.id] || preset.apiKey()),
      ),
      reasoningMode: settings.llm.reasoningMode,
      reasoningEffort: settings.llm.reasoningEffort,
      reasoningBudgetTokens: settings.llm.reasoningBudgetTokens,
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.maxTokens,
      timeoutMs: settings.llm.timeoutMs,
      streaming: settings.llm.streaming,
      typewriter: settings.llm.typewriter,
      typewriterSpeedMs: settings.llm.typewriterSpeedMs,
    },
    embedding: {
      ...settings.embedding,
      apiKeyConfigured: Boolean(
        secrets.embeddingApiKey || embeddingEnvironmentKey(settings.embedding.providerId),
      ),
    },
  };
};

export const configureInferenceSettings = (
  update: InferenceSettingsUpdate & { llm?: InferenceSettingsUpdate['llm'] & { model?: string } },
  files: InferenceSettingsFiles & { selectionFile?: string } = {},
): InferenceSettingsView => {
  if (update.llm?.providerId) requirePreset(update.llm.providerId);
  updateInferenceSettings(update, files);
  if (update.llm?.providerId && update.llm.model) {
    selectInferenceModel(update.llm.providerId, update.llm.model, files.selectionFile, files);
  }
  return getInferenceSettingsView(files);
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
  files: InferenceSettingsFiles = {},
): InferenceSelection => {
  const preset = requirePreset(providerId);
  const settings = readInferenceSettings(files);
  const secrets = readInferenceSecrets(files);
  const normalizedModel = requiredModel(model);
  if (!(settings.llm.providerOverrides[preset.id]?.baseUrl ?? preset.baseUrl())) {
    throw new Error(`${preset.displayName} requires its API base URL environment variable.`);
  }
  if (!credentialsAvailable(preset, secrets, settings)) {
    throw new Error(
      `${preset.displayName} credentials are not configured. Add the API key in local model settings or .env; never commit it.`,
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
  const files = { settingsFile: options.settingsFile, secretsFile: options.secretsFile };
  const settings = readInferenceSettings(files);
  const secrets = readInferenceSecrets(files);
  const baseUrl = settings.llm.providerOverrides[preset.id]?.baseUrl ?? preset.baseUrl();
  if (!baseUrl || !credentialsAvailable(preset, secrets, settings)) return undefined;
  return new OpenAICompatibleInferenceProvider({
    id: preset.id,
    displayName: preset.displayName,
    baseUrl,
    apiKey: secrets.llmApiKeys[preset.id] ?? preset.apiKey(),
    model: selection.model,
    timeoutMs:
      options.timeoutMs ?? settings.llm.timeoutMs ??
      environmentTimeout(
        process.env[`${preset.id.toUpperCase()}_TIMEOUT_MS`] ??
          process.env.THETA_LLM_TIMEOUT_MS,
      ),
    fetchImpl: options.fetchImpl,
    headers: preset.headers?.(),
    maxTokensField: preset.maxTokensField,
    allowInsecureLocalhost: preset.local || preset.id === 'custom',
    defaultTemperature: settings.llm.temperature,
    defaultMaxTokens: settings.llm.maxTokens,
    reasoningMode: settings.llm.reasoningMode,
    reasoningEffort: settings.llm.reasoningEffort,
    reasoningBudgetTokens: settings.llm.reasoningBudgetTokens ?? undefined,
    supportsReasoningEffort: preset.reasoningEffort,
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

const credentialsAvailable = (
  preset: ProviderPreset,
  secrets: ReturnType<typeof readInferenceSecrets> = readInferenceSecrets(),
  settings: ReturnType<typeof readInferenceSettings> = readInferenceSettings(),
): boolean =>
  (!preset.apiKeyRequired || Boolean(secrets.llmApiKeys[preset.id] ?? preset.apiKey())) &&
  Boolean(settings.llm.providerOverrides[preset.id]?.baseUrl ?? preset.baseUrl());

const embeddingEnvironmentKey = (providerId: string): string | undefined => {
  const preset = presets.find((candidate) => candidate.id === providerId);
  return preset?.apiKey();
};

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
