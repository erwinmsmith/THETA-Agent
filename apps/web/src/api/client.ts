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
  results?: Record<string, unknown>;
}

export interface WebPostMessageResult {
  runId: string;
  activeRunId: string;
  messages: WebMessage[];
  status: WebRunStatus;
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
  const response = await fetch(`${BASE_URL}${route}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = (await response.json()) as WebEnvelope<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }
  if (payload.data === undefined) throw new Error('API 响应缺少 data 字段。');
  return payload.data;
};

export const listRuns = (): Promise<{ runs: WebRunSummary[] }> =>
  request('/api/v2/runs?limit=30');

export const getRun = (runId: string): Promise<WebRunDetail> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}`);

export const getStatus = (runId: string): Promise<WebRunStatus & Record<string, unknown>> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/status`);

export const getConversation = (runId: string): Promise<{ runId: string; messages: WebMessage[] }> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/conversation?limit=200`);

export const postMessage = (
  runId: string,
  text: string,
  useLanguageProvider = true,
): Promise<WebPostMessageResult> =>
  request(`/api/v2/runs/${encodeURIComponent(runId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, useLanguageProvider }),
  });

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
  source.onerror = () => handlers.onError?.(new Error('实时流连接中断，将自动重连。'));
  return source;
};
