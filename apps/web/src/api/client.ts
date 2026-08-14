/**
 * Typed client for the THETA 2.0 API (apps/api). All shapes mirror
 * agent/src/api/contracts.ts so the web UI and the API stay in sync.
 */

export interface WebMessage {
  messageId: string;
  role: 'user' | 'assistant';
  messageKind: string;
  content: string;
  sequenceNumber: number;
  createdAt: string;
}

export interface WebRunStatus {
  runId: string;
  status: string;
  currentState?: string;
  pendingReason?: string;
  pendingActionRef?: string;
  statePath?: string[];
  lastEventAt?: string;
  presentation?: WebPresentation;
  interaction?: WebAgentInteraction;
}

export interface WebAgentInteraction {
  source: 'fsm';
  state: string;
  status: string;
  reasoning: {
    goal: string;
    observation: string;
    decision: string;
    nextStates: string[];
    allowedTools: string[];
    policyRefs: string[];
  };
  card?: {
    kind:
      | 'dataset_upload'
      | 'research_question'
      | 'dataset_review'
      | 'column_review'
      | 'research_intent_review'
      | 'plan_review'
      | 'training_review';
    title: string;
    description: string;
    actionRef: string;
    requiresHumanAction: true;
  };
}

export interface WebPresentation {
  kind?: string;
  title: string;
  summary: string;
  progress?: { current: number; total: number; label: string; percent?: number };
  sections?: Array<{ title: string; lines: string[] }>;
  nextActions: Array<{
    id: string;
    label: string;
    description: string;
    recommended?: boolean;
    destructive?: boolean;
    command?: string;
  }>;
}

export interface WebRunSummary {
  runId: string;
  updatedAt: string;
  status: string;
  currentState?: string;
  pendingReason?: string;
  identity?: { displayName?: string; datasetName?: string; researchQuestion?: string };
  presentation?: WebPresentation;
}

export interface WebRunEvent {
  id: string;
  source: 'orchestration' | 'tool';
  type: string;
  title: string;
  detail?: string;
  timestamp: string;
  payload?: unknown;
}

export interface WebReasoningToolCall {
  eventId: string;
  invocationId?: string;
  toolId: string;
  phase: 'requested' | 'started' | 'policy' | 'completed' | 'failed' | 'validated';
  label: string;
  timestamp: string;
  payload: unknown;
}

export interface WebReasoning {
  runId: string;
  researchIntent?: Record<string, unknown>;
  intentSummary?: Record<string, unknown>;
  currentDecisionGap?: string;
  decisionGaps: Array<{
    question: string;
    answers: Array<{ content: string; createdAt: string }>;
    resolved: boolean;
  }>;
  recommendation?: Record<string, unknown>;
  plan?: { state: string; presentation?: WebPresentation };
  toolCalls: WebReasoningToolCall[];
  reasoningEvents: WebRunEvent[];
}

export interface WebRunDetail {
  runId: string;
  status: WebRunStatus;
  identity?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  results?: WebRunResults;
}

export interface WebResultVisualization {
  id: string;
  label: string;
  relativePath: string;
  format: 'image' | 'interactive';
  scope: 'global' | 'topic';
  topicId?: string;
  sizeBytes: number;
}

export interface WebRunResults {
  status: string;
  progress: number;
  message: string;
  visualizations: WebResultVisualization[];
  metrics: Record<string, unknown>;
  topics: Array<{ id: string; name: string; strength?: number; keywords: string[] }>;
  warnings: string[];
  topicTable?: string;
  researchStatus?: string;
}

export interface WebAttachment {
  kind: 'visualization' | 'topic' | 'metric' | 'table';
  id: string;
  label: string;
}

export interface WebConversationMemory {
  sessionId: string;
  summary: string;
  recentUserGoals: string[];
  sourceMessageCount: number;
  updatedAt: string;
}

export interface WebWorkspaceTurn {
  sessionId: string;
  messages: WebMessage[];
  memory?: WebConversationMemory;
  interaction: WebAgentInteraction;
  activity?: {
    proposal?: unknown;
    result?: unknown;
    evidenceRefs?: unknown;
  };
}

export interface WebWorkspaceSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebPostMessageResult {
  runId: string;
  activeRunId: string;
  messages: WebMessage[];
  status: WebRunStatus;
}

export interface WebDataset {
  datasetRef: string;
  name: string;
  sizeBytes: number;
  suffix: string;
  createdAt: string;
}

export interface WebInferenceProvider {
  id: string;
  displayName: string;
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

export interface WebInferenceCatalog {
  kind: 'inference.provider.list';
  providers: WebInferenceProvider[];
  selection: { providerId: string; model: string; source: string } | null;
}

export type WebReasoningMode = 'auto' | 'chat' | 'reasoning';
export type WebReasoningEffort = 'low' | 'medium' | 'high';

export interface WebInferenceSettings {
  llm: {
    providerId: string | null;
    model: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
    reasoningMode: WebReasoningMode;
    reasoningEffort: WebReasoningEffort;
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

export interface WebInferenceSettingsUpdate {
  llm?: Partial<Omit<WebInferenceSettings['llm'], 'apiKeyConfigured'>> & {
    providerId?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    models?: string[];
  };
  embedding?: Partial<Omit<WebInferenceSettings['embedding'], 'apiKeyConfigured'>> & {
    apiKey?: string;
    clearApiKey?: boolean;
  };
}

export interface WebRuntimeProfile {
  service: 'theta-agent-runtime';
  version: 'v2';
  compute: {
    backend: 'local';
    defaultDevice: 'cpu' | 'gpu';
    scheduler: { supported: false; enabled: false };
  };
  capabilities: {
    domains: number;
    tools: number;
    skills: number;
  };
  entryInteraction: WebAgentInteraction;
}

export interface WebEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const BASE_URL =
  (import.meta.env.VITE_THETA_API_BASE as string | undefined) ??
  `${window.location.protocol}//${window.location.hostname}:4318`;

const request = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
  const isFormData = init.body instanceof FormData;
  const response = await fetch(`${BASE_URL}${route}`, {
    ...init,
    headers: {
      ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => undefined) as WebEnvelope<T> | undefined;
  if (payload === undefined) throw new Error(`API returned an invalid response (HTTP ${response.status}).`);
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }
  if (payload.data === undefined) throw new Error('API response is missing the data field.');
  return payload.data;
};

export const listRuns = (): Promise<{ runs: WebRunSummary[] }> =>
  request('/api/v2/runs?limit=30');

export const createRun = (input: {
  datasetRef: string;
  researchGoal?: string;
  useLanguageProvider?: boolean;
  sourceSessionId?: string;
}): Promise<{ runId: string }> => request('/api/v2/runs', {
  method: 'POST',
  body: JSON.stringify(input),
});

export const deleteRun = (runId: string): Promise<{ runId: string }> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });

export const renameRun = (runId: string, displayName: string): Promise<{ runId: string; displayName: string }> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  });

export const createWorkspaceSession = (): Promise<{ sessionId: string; interaction: WebAgentInteraction }> =>
  request('/api/v2/workspace/sessions', { method: 'POST', body: JSON.stringify({}) });

export const listWorkspaceSessions = (): Promise<{ sessions: WebWorkspaceSummary[] }> =>
  request('/api/v2/workspace/sessions?limit=30');

export const renameWorkspaceSession = (sessionId: string, displayName: string): Promise<WebWorkspaceSummary> =>
  request(`/api/v2/workspace/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  });

export const deleteWorkspaceSession = (sessionId: string): Promise<{ sessionId: string }> =>
  request(`/api/v2/workspace/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });

export const getWorkspaceConversation = (sessionId: string): Promise<WebWorkspaceTurn> =>
  request(`/api/v2/workspace/sessions/${encodeURIComponent(sessionId)}/conversation?limit=100`);

export const postWorkspaceMessage = (
  sessionId: string,
  text: string,
  useLanguageProvider = true,
): Promise<WebWorkspaceTurn> =>
  request(`/api/v2/workspace/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, useLanguageProvider, attachments: [] }),
  });

export const listDatasets = (): Promise<{ datasets: WebDataset[] }> =>
  request('/api/v2/datasets');

export const uploadDataset = async (file: File): Promise<WebDataset> => {
  const body = new FormData();
  body.append('file', file);
  return request('/api/v2/datasets/upload', { method: 'POST', body });
};

export const getInferenceCatalog = (): Promise<WebInferenceCatalog> =>
  request('/api/v2/inference');

export const getInferenceSettings = (): Promise<WebInferenceSettings> =>
  request('/api/v2/inference/settings');

export const updateInferenceSettings = (
  input: WebInferenceSettingsUpdate,
): Promise<WebInferenceSettings> => request('/api/v2/inference/settings', {
  method: 'PATCH',
  body: JSON.stringify(input),
});

export const getRuntimeProfile = (): Promise<WebRuntimeProfile> =>
  request('/api/v2/runtime');

export const selectInferenceModel = (providerId: string, model: string): Promise<unknown> =>
  request('/api/v2/inference', {
    method: 'POST',
    body: JSON.stringify({ action: 'use', providerId, model }),
  });

export const getRun = (runId: string): Promise<WebRunDetail> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}`);

export const getStatus = (runId: string): Promise<WebRunStatus & Record<string, unknown>> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/status`);

export const getConversation = (runId: string): Promise<{ runId: string; messages: WebMessage[]; memory?: WebConversationMemory }> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/conversation?limit=200`);

export const postMessage = (
  runId: string,
  text: string,
  useLanguageProvider = true,
  attachments: WebAttachment[] = [],
): Promise<WebPostMessageResult> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, useLanguageProvider, attachments }),
  });

export const resultAssetUrl = (runId: string, relativePath: string): string =>
  `${BASE_URL}/api/v2/runs/${encodeURIComponent(runId)}/results/assets/${encodeURIComponent(relativePath)}`;

export const resultArchiveUrl = (runId: string): string =>
  `${BASE_URL}/api/v2/runs/${encodeURIComponent(runId)}/results/archive`;

export const getEvents = (
  runId: string,
  options: { after?: string; limit?: number } = {},
): Promise<{ runId: string; events: WebRunEvent[]; count: number; total: number }> => {
  const params = new URLSearchParams();
  if (options.after) params.set('after', options.after);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return request(`/api/v2/runs/${encodeURIComponent(runId)}/events${query}`);
};

export const getReasoning = (runId: string): Promise<WebReasoning> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/reasoning`);

export const postAction = <T = unknown>(
  runId: string,
  action: Record<string, unknown>,
): Promise<{ result: T; status: WebRunStatus }> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/actions`, {
    method: 'POST',
    body: JSON.stringify(action),
  });

export interface StreamHandlers {
  onOpen?: () => void;
  onSnapshot?: (data: { runId: string; status: WebRunStatus; lastEventId?: string }) => void;
  onStatus?: (data: { status: WebRunStatus }) => void;
  onEvents?: (data: { events: WebRunEvent[] }) => void;
  onMessages?: (data: { messages: WebMessage[] }) => void;
  onTraining?: (data: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
}

export const openRunStream = (runId: string, handlers: StreamHandlers): EventSource => {
  const source = new EventSource(
    `${BASE_URL}/api/v2/runs/${encodeURIComponent(runId)}/stream`,
  );
  const wire = (kind: string, handler: ((data: never) => void) | undefined): void => {
    if (!handler) return;
    source.addEventListener(kind, (event) => {
      try {
        handler(JSON.parse((event as MessageEvent).data) as never);
      } catch {
        // Ignore malformed frames; the next tick resyncs.
      }
    });
  };
  wire('snapshot', handlers.onSnapshot as never);
  wire('status', handlers.onStatus as never);
  wire('events', handlers.onEvents as never);
  wire('messages', handlers.onMessages as never);
  wire('training', handlers.onTraining as never);
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.(new Error('实时流连接中断，将自动重连。'));
  return source;
};
