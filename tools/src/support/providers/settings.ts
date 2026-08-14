import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from '../repository-paths.js';

export type InferenceReasoningMode = 'auto' | 'chat' | 'reasoning';
export type InferenceReasoningEffort = 'low' | 'medium' | 'high';

export interface LlmRuntimeSettings {
  reasoningMode: InferenceReasoningMode;
  reasoningEffort: InferenceReasoningEffort;
  reasoningBudgetTokens: number | null;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  streaming: boolean;
  typewriter: boolean;
  typewriterSpeedMs: number;
  providerOverrides: Record<string, {
    baseUrl?: string;
    models?: string[];
  }>;
}

export interface EmbeddingApiSettings {
  enabled: boolean;
  providerId: string;
  model: string;
  baseUrl: string;
  dimensions: number | null;
}

export interface InferenceSettings {
  version: 1;
  llm: LlmRuntimeSettings;
  embedding: EmbeddingApiSettings;
}

export interface InferenceSecrets {
  version: 1;
  llmApiKeys: Record<string, string>;
  embeddingApiKey?: string;
}

export interface InferenceSettingsFiles {
  settingsFile?: string;
  secretsFile?: string;
}

export interface InferenceSettingsUpdate {
  llm?: Partial<Omit<LlmRuntimeSettings, 'providerOverrides'>> & {
    providerId?: string;
    baseUrl?: string;
    models?: string[];
    apiKey?: string;
    clearApiKey?: boolean;
  };
  embedding?: Partial<EmbeddingApiSettings> & {
    apiKey?: string;
    clearApiKey?: boolean;
  };
}

const DEFAULT_SETTINGS: InferenceSettings = {
  version: 1,
  llm: {
    reasoningMode: 'auto',
    reasoningEffort: 'medium',
    reasoningBudgetTokens: null,
    temperature: 0.1,
    maxTokens: 800,
    timeoutMs: 60_000,
    streaming: true,
    typewriter: true,
    typewriterSpeedMs: 18,
    providerOverrides: {},
  },
  embedding: {
    enabled: false,
    providerId: 'openai',
    model: '',
    baseUrl: 'https://api.openai.com/v1',
    dimensions: null,
  },
};

const stateRoot = (): string =>
  path.resolve(
    process.env.THETA_AGENT_STATE_DIR ?? path.join(repositoryRoot, '.theta_agent'),
  );

export const inferenceSettingsFile = (): string =>
  path.resolve(process.env.THETA_INFERENCE_SETTINGS_FILE ?? path.join(stateRoot(), 'inference-settings.json'));

export const inferenceSecretsFile = (): string =>
  path.resolve(process.env.THETA_INFERENCE_SECRETS_FILE ?? path.join(stateRoot(), 'inference-secrets.json'));

export const readInferenceSettings = (
  files: InferenceSettingsFiles = {},
): InferenceSettings => {
  const parsed = readJson(files.settingsFile ?? inferenceSettingsFile());
  const llm = record(parsed?.llm);
  const embedding = record(parsed?.embedding);
  return {
    version: 1,
    llm: {
      reasoningMode: reasoningMode(llm.reasoningMode),
      reasoningEffort: reasoningEffort(llm.reasoningEffort),
      reasoningBudgetTokens: nullableInteger(llm.reasoningBudgetTokens, 256, 131_072),
      temperature: finiteNumber(llm.temperature, 0, 2, DEFAULT_SETTINGS.llm.temperature),
      maxTokens: integer(llm.maxTokens, 64, 131_072, DEFAULT_SETTINGS.llm.maxTokens),
      timeoutMs: integer(llm.timeoutMs, 1_000, 600_000, DEFAULT_SETTINGS.llm.timeoutMs),
      streaming: boolean(llm.streaming, DEFAULT_SETTINGS.llm.streaming),
      typewriter: boolean(llm.typewriter, DEFAULT_SETTINGS.llm.typewriter),
      typewriterSpeedMs: integer(llm.typewriterSpeedMs, 0, 100, DEFAULT_SETTINGS.llm.typewriterSpeedMs),
      providerOverrides: providerOverrides(llm.providerOverrides),
    },
    embedding: {
      enabled: boolean(embedding.enabled, DEFAULT_SETTINGS.embedding.enabled),
      providerId: safeText(embedding.providerId, 80) ?? DEFAULT_SETTINGS.embedding.providerId,
      model: safeText(embedding.model, 200) ?? DEFAULT_SETTINGS.embedding.model,
      baseUrl: safeText(embedding.baseUrl, 500) ?? DEFAULT_SETTINGS.embedding.baseUrl,
      dimensions: nullableInteger(embedding.dimensions, 1, 65_536),
    },
  };
};

export const readInferenceSecrets = (
  files: InferenceSettingsFiles = {},
): InferenceSecrets => {
  const parsed = readJson(files.secretsFile ?? inferenceSecretsFile());
  const keys = record(parsed?.llmApiKeys);
  return {
    version: 1,
    llmApiKeys: Object.fromEntries(
      Object.entries(keys)
        .map(([id, value]) => [id, safeSecret(value)] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    ),
    ...(safeSecret(parsed?.embeddingApiKey)
      ? { embeddingApiKey: safeSecret(parsed?.embeddingApiKey) }
      : {}),
  };
};

export const updateInferenceSettings = (
  update: InferenceSettingsUpdate,
  files: InferenceSettingsFiles = {},
): InferenceSettings => {
  const current = readInferenceSettings(files);
  const secrets = readInferenceSecrets(files);
  const next: InferenceSettings = structuredClone(current);
  const llm = update.llm;
  if (llm) {
    if (llm.reasoningMode !== undefined) next.llm.reasoningMode = reasoningMode(llm.reasoningMode);
    if (llm.reasoningEffort !== undefined) next.llm.reasoningEffort = reasoningEffort(llm.reasoningEffort);
    if (llm.reasoningBudgetTokens !== undefined) next.llm.reasoningBudgetTokens = nullableInteger(llm.reasoningBudgetTokens, 256, 131_072);
    if (llm.temperature !== undefined) next.llm.temperature = finiteNumber(llm.temperature, 0, 2, current.llm.temperature);
    if (llm.maxTokens !== undefined) next.llm.maxTokens = integer(llm.maxTokens, 64, 131_072, current.llm.maxTokens);
    if (llm.timeoutMs !== undefined) next.llm.timeoutMs = integer(llm.timeoutMs, 1_000, 600_000, current.llm.timeoutMs);
    if (llm.streaming !== undefined) next.llm.streaming = Boolean(llm.streaming);
    if (llm.typewriter !== undefined) next.llm.typewriter = Boolean(llm.typewriter);
    if (llm.typewriterSpeedMs !== undefined) next.llm.typewriterSpeedMs = integer(llm.typewriterSpeedMs, 0, 100, current.llm.typewriterSpeedMs);
    const providerId = safeText(llm.providerId, 80);
    if (providerId) {
      const override = { ...(next.llm.providerOverrides[providerId] ?? {}) };
      if (llm.baseUrl !== undefined) override.baseUrl = safeText(llm.baseUrl, 500) ?? undefined;
      if (llm.models !== undefined) override.models = safeModels(llm.models);
      next.llm.providerOverrides[providerId] = override;
      if (llm.clearApiKey) delete secrets.llmApiKeys[providerId];
      const apiKey = safeSecret(llm.apiKey);
      if (apiKey) secrets.llmApiKeys[providerId] = apiKey;
    }
  }
  const embedding = update.embedding;
  if (embedding) {
    if (embedding.enabled !== undefined) next.embedding.enabled = Boolean(embedding.enabled);
    if (embedding.providerId !== undefined) next.embedding.providerId = requiredText(embedding.providerId, 'Embedding provider', 80);
    if (embedding.model !== undefined) next.embedding.model = safeText(embedding.model, 200) ?? '';
    if (embedding.baseUrl !== undefined) next.embedding.baseUrl = requiredText(embedding.baseUrl, 'Embedding base URL', 500);
    if (embedding.dimensions !== undefined) next.embedding.dimensions = nullableInteger(embedding.dimensions, 1, 65_536);
    if (embedding.clearApiKey) delete secrets.embeddingApiKey;
    const apiKey = safeSecret(embedding.apiKey);
    if (apiKey) secrets.embeddingApiKey = apiKey;
  }
  writePrivateJson(files.settingsFile ?? inferenceSettingsFile(), next);
  writePrivateJson(files.secretsFile ?? inferenceSecretsFile(), secrets);
  return next;
};

const writePrivateJson = (filename: string, value: unknown): void => {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, filename);
};

const readJson = (filename: string): Record<string, unknown> | undefined => {
  try {
    return record(JSON.parse(readFileSync(filename, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const boolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const integer = (value: unknown, min: number, max: number, fallback: number): number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;

const nullableInteger = (value: unknown, min: number, max: number): number | null =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isInteger(value) && Number(value) >= min && Number(value) <= max
      ? Number(value)
      : null;

const finiteNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

const safeText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max && !/[\r\n\0]/u.test(normalized) ? normalized : undefined;
};

const requiredText = (value: unknown, label: string, max: number): string => {
  const normalized = safeText(value, max);
  if (!normalized) throw new Error(`${label} must contain 1-${max} safe characters.`);
  return normalized;
};

const safeSecret = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value.trim().length <= 8_192 && !/[\r\n\0]/u.test(value)
    ? value.trim()
    : undefined;

const safeModels = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map((item) => safeText(item, 200)).filter((item): item is string => Boolean(item)))].slice(0, 40)
    : [];

const providerOverrides = (value: unknown): LlmRuntimeSettings['providerOverrides'] =>
  Object.fromEntries(
    Object.entries(record(value)).flatMap(([providerId, raw]) => {
      const override = record(raw);
      const baseUrl = safeText(override.baseUrl, 500);
      const models = safeModels(override.models);
      return safeText(providerId, 80)
        ? [[providerId, { ...(baseUrl ? { baseUrl } : {}), ...(models.length ? { models } : {}) }]]
        : [];
    }),
  );

const reasoningMode = (value: unknown): InferenceReasoningMode =>
  value === 'chat' || value === 'reasoning' ? value : 'auto';

const reasoningEffort = (value: unknown): InferenceReasoningEffort =>
  value === 'low' || value === 'high' ? value : 'medium';
