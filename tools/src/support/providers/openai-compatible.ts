import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
  PromptMessage,
} from '@codesoul-co/hypha-inference';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

export interface OpenAICompatibleProviderConfig {
  id: string;
  displayName: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  allowInsecureLocalhost?: boolean;
}

interface OpenAICompatibleProviderInput {
  messages: PromptMessage[];
}

export class OpenAICompatibleInferenceProvider implements InferenceProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';

  constructor(config: OpenAICompatibleProviderConfig) {
    this.id = required(config.id, 'Provider ID');
    this.displayName = required(config.displayName, 'Provider name');
    this.apiKey = config.apiKey?.trim() || undefined;
    this.baseUrl = normalizeBaseUrl(
      config.baseUrl,
      config.allowInsecureLocalhost === true,
    );
    this.model = required(config.model, 'Provider model');
    this.timeoutMs = positiveInteger(
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Provider timeout',
    );
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.headers = { ...config.headers };
    this.maxTokensField = config.maxTokensField ?? 'max_tokens';
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const input = providerInput(request.input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            'Content-Type': 'application/json',
            ...this.headers,
          },
          body: JSON.stringify({
            model: this.model,
            messages: input.messages.map(apiMessage),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  })),
                  tool_choice: compatibleToolChoice(
                    request.options?.extra?.toolChoice,
                  ),
                }
              : {}),
            temperature: request.options?.temperature ?? 0.2,
            [this.maxTokensField]: Math.min(
              request.options?.maxTokens ?? 800,
              4096,
            ),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new InferenceProviderError(
          'provider_error',
          `${this.displayName} request failed with HTTP ${response.status}.`,
        );
      }
      const payload = await responseJson(response);
      const toolCalls = responseToolCalls(payload);
      const output = toolCalls.length
        ? { kind: 'tool_calls', toolCalls }
        : parseJsonObject(responseContent(payload));
      const usage = record(payload.usage);
      return {
        id:
          typeof payload.id === 'string'
            ? payload.id
            : `${this.id}-${Date.now()}`,
        output,
        usage: {
          inputTokens: optionalNumber(usage.prompt_tokens),
          outputTokens: optionalNumber(usage.completion_tokens),
          totalTokens: optionalNumber(usage.total_tokens),
        },
        metadata: {
          providerId: this.id,
          model: this.model,
        },
      };
    } catch (error) {
      if (error instanceof InferenceProviderError) throw error;
      if (isAbortError(error)) {
        throw new InferenceProviderError(
          'timeout',
          `${this.displayName} request exceeded ${this.timeoutMs} ms.`,
        );
      }
      throw new InferenceProviderError(
        'network_failure',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class InferenceProviderError extends Error {
  constructor(
    readonly code:
      | 'network_failure'
      | 'timeout'
      | 'provider_error'
      | 'non_json_response',
    message: string,
  ) {
    super(message);
  }
}

const providerInput = (value: unknown): OpenAICompatibleProviderInput => {
  if (!value || typeof value !== 'object' || !('messages' in value)) {
    throw new InferenceProviderError(
      'provider_error',
      'OpenAI-compatible inference input must contain messages.',
    );
  }
  const messages = (value as { messages?: unknown }).messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !messages.every(
      (message) =>
        Boolean(message) &&
        typeof message === 'object' &&
        typeof (message as PromptMessage).role === 'string' &&
        typeof (message as PromptMessage).content === 'string',
    )
  ) {
    throw new InferenceProviderError(
      'provider_error',
      'OpenAI-compatible inference messages are invalid.',
    );
  }
  return { messages: messages as PromptMessage[] };
};

const apiRole = (
  role: PromptMessage['role'],
): 'system' | 'user' | 'assistant' | 'tool' =>
  role === 'system' || role === 'assistant' || role === 'tool' ? role : 'user';

const apiMessage = (message: PromptMessage): Record<string, unknown> => {
  const metadata = record(message.metadata);
  const toolCalls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
  return {
    role: apiRole(message.role),
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.role === 'tool' && typeof metadata.toolCallId === 'string'
      ? { tool_call_id: metadata.toolCallId }
      : {}),
    ...(message.role === 'assistant' && toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((rawCall) => {
            const call = record(rawCall);
            return {
              id: String(call.id ?? ''),
              type: 'function',
              function: {
                name: String(call.name ?? ''),
                arguments: JSON.stringify(record(call.arguments)),
              },
            };
          }),
        }
      : {}),
  };
};

const compatibleToolChoice = (value: unknown): 'auto' | 'none' =>
  value === 'none' ? 'none' : 'auto';

const responseJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  try {
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Response is not an object.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new InferenceProviderError(
      'non_json_response',
      error instanceof Error ? error.message : String(error),
    );
  }
};

const responseContent = (payload: Record<string, unknown>): string => {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = record(choices[0]);
  const message = record(first.message);
  if (typeof message.content !== 'string' || !message.content.trim()) {
    throw new InferenceProviderError(
      'non_json_response',
      'Provider response did not contain message content.',
    );
  }
  return message.content;
};

const responseToolCalls = (
  payload: Record<string, unknown>,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> => {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = record(record(choices[0]).message);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.map((rawCall, index) => {
    const call = record(rawCall);
    const fn = record(call.function);
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) {
      throw new InferenceProviderError(
        'non_json_response',
        'Provider tool call did not contain a function name.',
      );
    }
    let args: unknown = fn.arguments;
    if (typeof args === 'string') {
      try {
        args = parseJsonWithConservativeRepair(args);
      } catch (error) {
        throw new InferenceProviderError(
          'non_json_response',
          `Provider tool arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new InferenceProviderError(
        'non_json_response',
        'Provider tool arguments must be a JSON object.',
      );
    }
    return {
      id: typeof call.id === 'string' ? call.id : `tool-call-${index + 1}`,
      name,
      arguments: args as Record<string, unknown>,
    };
  });
};

const parseJsonObject = (content: string): Record<string, unknown> => {
  const withoutThinking = content
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const start = withoutThinking.indexOf('{');
  const end = withoutThinking.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new InferenceProviderError(
      'non_json_response',
      'Provider response did not contain a JSON object.',
    );
  }
  const candidate = withoutThinking.slice(start, end + 1);
  try {
    const value = parseJsonWithConservativeRepair(candidate);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Parsed response is not an object.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new InferenceProviderError(
      'non_json_response',
      error instanceof Error ? error.message : String(error),
    );
  }
};

/**
 * Some compatible providers return otherwise valid JSON with a trailing comma
 * or full-width structural punctuation. Repair only punctuation outside quoted
 * strings; never attempt to invent a missing field or value.
 */
const parseJsonWithConservativeRepair = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    const normalized = normalizeJsonPunctuation(value)
      .replace(/,\s*([}\]])/gu, '$1');
    return JSON.parse(normalized);
  }
};

const normalizeJsonPunctuation = (value: string): string => {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (quoted) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      result += character;
      continue;
    }
    result += character === '，' ? ',' : character === '：' ? ':' : character;
  }
  return result;
};

const normalizeBaseUrl = (
  value: string,
  allowInsecureLocalhost: boolean,
): string => {
  const url = new URL(required(value, 'Provider API base URL'));
  const localHttp =
    allowInsecureLocalhost &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(
      'Provider API base URL must use HTTPS unless it targets local Ollama.',
    );
  }
  return url.toString().replace(/\/+$/u, '');
};

const required = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return value;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
