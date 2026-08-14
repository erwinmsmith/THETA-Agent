import type {
  InferenceProvider,
  PromptMessage,
} from '@codesoul-co/hypha-inference';
import { ZodError } from 'zod';
import {
  LANGUAGE_CONTRACT_VERSION,
  languageProviderOutputSchema,
  languageResultSchema,
  type LanguageFallbackReason,
  type LanguageProviderOutput,
  type LanguageRequest,
  type LanguageResult,
} from '@theta-agent/domain/language/contracts.js';
import {
  deterministicLanguageResult,
  languageFactsHash,
} from './fallback.js';
import { sanitizeLanguageRequest } from './sanitizer.js';

export interface LanguageServiceOptions {
  provider?: InferenceProvider;
  modelAlias?: string;
}

export class ThetaLanguageService {
  constructor(private readonly options: LanguageServiceOptions = {}) {}

  async generate(request: LanguageRequest): Promise<LanguageResult> {
    const sanitized = sanitizeLanguageRequest(request);
    if (!this.options.provider) {
      return deterministicLanguageResult(
        sanitized,
        'provider_not_configured',
      );
    }
    try {
      const response = await this.options.provider.infer({
        runId: `theta-language-${languageFactsHash(sanitized).slice(0, 16)}`,
        stepId: sanitized.task,
        modelAlias: this.options.modelAlias ?? 'configured-language-model',
        input: {
          messages: promptMessages(sanitized),
        },
        options: {
          temperature: 0.2,
          maxTokens: 800,
        },
        trace: true,
        metadata: {
          purpose: sanitized.task,
          schemaVersion: LANGUAGE_CONTRACT_VERSION,
        },
      });
      const output = languageProviderOutputSchema.parse(response.output);
      validateProviderOutput(sanitized, output);
      return languageResultSchema.parse({
        schemaVersion: LANGUAGE_CONTRACT_VERSION,
        task: sanitized.task,
        source: 'provider',
        text: output.text,
        ...('intent' in output ? { intent: output.intent } : {}),
        factsHash: languageFactsHash(sanitized),
      });
    } catch (error) {
      return deterministicLanguageResult(sanitized, fallbackReason(error));
    }
  }
}

const promptMessages = (request: LanguageRequest): PromptMessage[] => [
  {
    role: 'system',
    content: [
      'You are a bounded language component inside THETA.',
      'Return one JSON object only.',
      'You may classify a read-only intent, improve question wording, or explain an existing deterministic recommendation.',
      'Never select a model, change a parameter, create or approve a plan, start or cancel training, choose a tool, or request more privileges.',
      'Do not add fields outside the requested response shape.',
      responseShape(request),
    ].join(' '),
  },
  {
    role: 'user',
    content: JSON.stringify(request),
  },
];

const responseShape = (request: LanguageRequest): string =>
  request.task === 'classify_intent'
    ? 'Shape: {"task":"classify_intent","intent":"read_status|explain_reason|read_evidence|request_help|unknown","text":"..."}.'
    : `Shape: {"task":"${request.task}","text":"..."}.`;

const validateProviderOutput = (
  request: LanguageRequest,
  output: LanguageProviderOutput,
): void => {
  if (request.task !== output.task) {
    throw new LanguageOutputError(
      'schema_validation_failed',
      'Provider changed the requested language task.',
    );
  }
  if (request.task === 'classify_intent' && !('intent' in output)) {
    throw new LanguageOutputError(
      'illegal_intent',
      'Provider omitted the bounded intent.',
    );
  }
  if (attemptsControlAction(output.text)) {
    throw new LanguageOutputError(
      'output_rejected',
      'Provider output attempted to control plans, parameters, tools, or training.',
    );
  }
};

const attemptsControlAction = (text: string): boolean =>
  /(?:\b(?:set|change|update|approve|start|cancel|execute|select)\b.{0,48}\b(?:model|parameter|plan|training|tool)\b)|(?:(?:设置|修改|调整|批准|启动|取消|执行|选择).{0,24}(?:模型|参数|计划|训练|工具))/iu.test(
    text,
  );

class LanguageOutputError extends Error {
  constructor(
    readonly reason: LanguageFallbackReason,
    message: string,
  ) {
    super(message);
  }
}

const fallbackReason = (error: unknown): LanguageFallbackReason => {
  if (error instanceof LanguageOutputError) return error.reason;
  if (error instanceof ZodError) return 'schema_validation_failed';
  if (isReason(error, 'timeout')) return 'timeout';
  if (isReason(error, 'network_failure')) return 'network_failure';
  if (isReason(error, 'non_json_response')) return 'non_json_response';
  return 'provider_error';
};

const isReason = (error: unknown, reason: string): boolean =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === reason,
  );
