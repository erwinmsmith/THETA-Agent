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
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  reasoningMode?: 'auto' | 'chat' | 'reasoning';
  reasoningEffort?: 'low' | 'medium' | 'high';
  reasoningBudgetTokens?: number;
  supportsReasoningEffort?: boolean;
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
  private readonly defaultTemperature: number;
  private readonly defaultMaxTokens: number;
  private readonly reasoningMode: 'auto' | 'chat' | 'reasoning';
  private readonly reasoningEffort: 'low' | 'medium' | 'high';
  private readonly reasoningBudgetTokens?: number;
  private readonly supportsReasoningEffort: boolean;

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
    this.defaultTemperature = config.defaultTemperature ?? 0.1;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 800;
    this.reasoningMode = config.reasoningMode ?? 'auto';
    this.reasoningEffort = config.reasoningEffort ?? 'medium';
    this.reasoningBudgetTokens = config.reasoningBudgetTokens;
    this.supportsReasoningEffort = config.supportsReasoningEffort ?? false;
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
          body: JSON.stringify(this.requestBody(request, input, false)),
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
      if (process.env.THETA_DEBUG_PROVIDER_RESPONSES === '1') {
        console.error(
          `[theta-provider-debug] ${this.id} response:`,
          JSON.stringify(payload).slice(0, 6000),
        );
      }
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

  async *stream(request: InferenceRequest): AsyncIterable<InferenceResponse> {
    const input = providerInput(request.input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let fullContent = '';
    let usage: InferenceResponse['usage'];
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(this.requestBody(request, input, true)),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new InferenceProviderError(
          'provider_error',
          `${this.displayName} stream failed with HTTP ${response.status}.`,
        );
      }
      if (!response.body) {
        throw new InferenceProviderError('non_json_response', 'Provider stream has no response body.');
      }
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/u);
        buffer = events.pop() ?? '';
        for (const event of events) {
          const parsed = streamEvent(event);
          if (!parsed || parsed.done) continue;
          if (parsed.usage) usage = parsed.usage;
          if (!parsed.content) continue;
          fullContent += parsed.content;
          yield {
            id: parsed.id ?? `${this.id}-${Date.now()}`,
            output: { kind: 'text_delta', text: parsed.content },
            metadata: { providerId: this.id, model: this.model, stream: true, done: false },
          };
        }
      }
      buffer += decoder.decode();
      const finalEvent = streamEvent(buffer);
      if (finalEvent?.usage) usage = finalEvent.usage;
      yield {
        id: finalEvent?.id ?? `${this.id}-${Date.now()}-done`,
        output: { kind: 'stream_done', content: fullContent },
        usage,
        metadata: { providerId: this.id, model: this.model, stream: true, done: true },
      };
    } catch (error) {
      if (error instanceof InferenceProviderError) throw error;
      if (isAbortError(error)) {
        throw new InferenceProviderError('timeout', `${this.displayName} stream exceeded ${this.timeoutMs} ms.`);
      }
      throw new InferenceProviderError(
        'network_failure',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private requestBody(
    request: InferenceRequest,
    input: OpenAICompatibleProviderInput,
    stream: boolean,
  ): Record<string, unknown> {
    const extra = record(request.options?.extra);
    const reasoningMode = extra.reasoningMode === 'chat' || extra.reasoningMode === 'reasoning'
      ? extra.reasoningMode
      : this.reasoningMode;
    const reasoningEffort = extra.reasoningEffort === 'low' || extra.reasoningEffort === 'high'
      ? extra.reasoningEffort
      : this.reasoningEffort;
    const reasoning = reasoningMode === 'reasoning';
    return {
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
            tool_choice: compatibleToolChoice(request.options?.extra?.toolChoice),
          }
        : {}),
      ...(!reasoning ? { temperature: request.options?.temperature ?? this.defaultTemperature } : {}),
      [this.maxTokensField]: Math.min(request.options?.maxTokens ?? this.defaultMaxTokens, 131_072),
      ...(reasoning && this.supportsReasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(reasoning && this.reasoningBudgetTokens
        ? { metadata: { theta_reasoning_budget_tokens: this.reasoningBudgetTokens } }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
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
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content;
  }
  // Reasoning-capable providers (the deepseek-reasoner family) may emit the
  // final answer only through the reasoning channel while leaving `content`
  // empty. Reuse that text so the structured parsers below can extract the
  // JSON payload.
  if (
    typeof message.reasoning_content === 'string' &&
    message.reasoning_content.trim()
  ) {
    return message.reasoning_content;
  }
  throw new InferenceProviderError(
    'non_json_response',
    'Provider response did not contain message content.',
  );
};

const streamEvent = (event: string): {
  id?: string;
  content?: string;
  usage?: InferenceResponse['usage'];
  done: boolean;
} | undefined => {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return undefined;
  if (data === '[DONE]') return { done: true };
  try {
    const payload = record(JSON.parse(data));
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const delta = record(record(choices[0]).delta);
    const providerUsage = record(payload.usage);
    const usage = Object.keys(providerUsage).length > 0
      ? {
          inputTokens: optionalNumber(providerUsage.prompt_tokens),
          outputTokens: optionalNumber(providerUsage.completion_tokens),
          totalTokens: optionalNumber(providerUsage.total_tokens),
        }
      : undefined;
    return {
      ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
      ...(typeof delta.content === 'string' && delta.content ? { content: delta.content } : {}),
      ...(usage ? { usage } : {}),
      done: false,
    };
  } catch {
    return undefined;
  }
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
