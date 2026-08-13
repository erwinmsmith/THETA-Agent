import {
  agentInvocationSchema,
  conversationCommandSchema,
  type AgentInvocation,
  type ConversationCommand,
} from './contracts.js';
import { LANGUAGE_CONTRACT_VERSION } from '@theta-agent/domain/language/contracts.js';

const startValueOptions = new Set([
  'file',
  'input',
  'dataset-id',
  'goal',
  'sample-size',
  'run-id',
  'runtime-db',
  'approved-by',
]);
const startBooleanOptions = new Set([
  'approve-plans',
  'approve-training',
  'json',
]);
const resumeValueOptions = new Set([
  'run-id',
  'runtime-db',
  'approved-by',
  'answers',
  'columns',
]);
const resumeBooleanOptions = new Set(['approve', 'reject', 'json']);

export class ConversationService {
  parseInvocation(args: readonly string[]): AgentInvocation {
    const [command, ...rest] = args;
    if (command === 'doctor') {
      const options = parseOptions(rest, new Set(), new Set(['json']));
      return agentInvocationSchema.parse({
        kind: 'doctor',
        json: options.booleans.has('json'),
      });
    }
    if (command === 'start') {
      parseOptions(rest, startValueOptions, startBooleanOptions);
      return agentInvocationSchema.parse({
        kind: 'workflow',
        action: 'start',
        args: [...rest],
      });
    }
    if (command === 'resume') {
      parseOptions(rest, resumeValueOptions, resumeBooleanOptions);
      return agentInvocationSchema.parse({
        kind: 'workflow',
        action: 'resume',
        args: [...rest],
      });
    }
    if (command === 'status') {
      const options = parseOptions(
        rest,
        new Set(['run-id', 'runtime-db']),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: 'status',
        runId: requiredOption(options.values, 'run-id'),
        runtimeDb: options.values.get('runtime-db'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'audit') {
      if (rest[0] !== 'export') {
        throw new Error('Expected "audit export".');
      }
      const options = parseOptions(
        rest.slice(1),
        new Set(['run-id', 'runtime-db']),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: 'audit',
        runId: requiredOption(options.values, 'run-id'),
        runtimeDb: options.values.get('runtime-db'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'plan') {
      const action = rest[0];
      if (action !== 'show' && action !== 'approve') {
        throw new Error('Expected "plan show" or "plan approve".');
      }
      const options = parseOptions(
        rest.slice(1),
        new Set([
          'run-id',
          'runtime-db',
          ...(action === 'approve' ? ['approved-by'] : []),
        ]),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: action === 'show' ? 'planShow' : 'planApprove',
        runId: requiredOption(options.values, 'run-id'),
        runtimeDb: options.values.get('runtime-db'),
        approvedBy: options.values.get('approved-by'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'train') {
      const action = rest[0];
      if (action === 'status') {
        const options = parseOptions(
          rest.slice(1),
          new Set(['run-id', 'log-limit']),
          new Set(['json']),
        );
        const logLimit = optionalPositiveInteger(
          options.values.get('log-limit'),
          'log-limit',
          500,
        );
        return agentInvocationSchema.parse({
          kind: 'trainingStatus',
          trainingRunId: requiredOption(options.values, 'run-id'),
          logLimit,
          json: options.booleans.has('json'),
        });
      }
      if (action === 'cancel') {
        const options = parseOptions(
          rest.slice(1),
          new Set(['run-id', 'reason']),
          new Set(['approve', 'json']),
        );
        return agentInvocationSchema.parse({
          kind: 'trainingCancel',
          trainingRunId: requiredOption(options.values, 'run-id'),
          reason: requiredOption(options.values, 'reason'),
          approve: options.booleans.has('approve'),
          json: options.booleans.has('json'),
        });
      }
      throw new Error('Expected "train status" or "train cancel".');
    }
    if (command === 'evidence') {
      if (rest[0] !== 'show') {
        throw new Error('Expected "evidence show".');
      }
      const options = parseOptions(
        rest.slice(1),
        new Set(['run-id', 'runtime-db']),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: 'evidenceShow',
        runId: requiredOption(options.values, 'run-id'),
        runtimeDb: options.values.get('runtime-db'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'rag') {
      const action = rest[0];
      if (action !== 'build' && action !== 'status') {
        throw new Error('Expected "rag build" or "rag status".');
      }
      const options = parseOptions(
        rest.slice(1),
        new Set(),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: action === 'build' ? 'ragBuild' : 'ragStatus',
        json: options.booleans.has('json'),
      });
    }
    if (command === 'model') {
      const action = rest[0] ?? 'current';
      if (!['list', 'current', 'use', 'reset'].includes(action)) {
        throw new Error('Expected "model list", "model current", "model use", or "model reset".');
      }
      const options = parseOptions(
        rest.slice(1),
        new Set(action === 'use' ? ['provider', 'model'] : []),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: 'model',
        action,
        ...(action === 'use'
          ? {
              providerId: requiredOption(options.values, 'provider'),
              model: requiredOption(options.values, 'model'),
            }
          : {}),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'language') {
      const action = rest[0];
      if (
        action !== 'intent' &&
        action !== 'question' &&
        action !== 'explain'
      ) {
        throw new Error(
          'Expected "language intent", "language question", or "language explain".',
        );
      }
      const options = parseOptions(
        rest.slice(1),
        new Set([
          'text',
          ...(action === 'question' ? ['field', 'reason'] : []),
          ...(action === 'explain'
            ? [
                'model-id',
                'score',
                'confidence',
                'reason-codes',
                'warnings',
                'evidence',
              ]
            : []),
        ]),
        new Set(['approve', 'json']),
      );
      const request =
        action === 'intent'
          ? {
              schemaVersion: LANGUAGE_CONTRACT_VERSION,
              task: 'classify_intent' as const,
              sourceText: requiredOption(options.values, 'text'),
            }
          : action === 'question'
            ? {
                schemaVersion: LANGUAGE_CONTRACT_VERSION,
                task: 'word_question' as const,
                field: requiredOption(options.values, 'field'),
                reason: requiredOption(options.values, 'reason'),
                draftQuestion: requiredOption(options.values, 'text'),
              }
            : {
                schemaVersion: LANGUAGE_CONTRACT_VERSION,
                task: 'explain_recommendation' as const,
                recommendation: {
                  modelId: requiredOption(options.values, 'model-id'),
                  score: requiredBoundedInteger(
                    options.values,
                    'score',
                    0,
                    100,
                  ),
                  confidence: requiredConfidence(options.values),
                  reasonCodes: requiredCsv(options.values, 'reason-codes'),
                  warnings: optionalCsv(options.values.get('warnings')),
                },
                evidence: options.values.get('evidence')
                  ? [
                      {
                        evidenceId: 'cli-evidence-1',
                        authority: 'L3' as const,
                        excerpt: requiredOption(options.values, 'evidence'),
                      },
                    ]
                  : [],
              };
      return agentInvocationSchema.parse({
        kind: 'languageGenerate',
        request,
        approve: options.booleans.has('approve'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'answer' || command === 'columns') {
      const options = parseOptions(
        rest,
        new Set(['text', 'run-id', 'runtime-db', 'session-id']),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: 'conversationTurn',
        action: command,
        text: requiredOption(options.values, 'text'),
        runId: requiredOption(options.values, 'run-id'),
        runtimeDb: options.values.get('runtime-db'),
        sessionId: options.values.get('session-id'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'repl') {
      const options = parseOptions(
        rest,
        new Set(['run-id', 'runtime-db']),
        new Set(),
      );
      return agentInvocationSchema.parse({
        kind: 'repl',
        runId: options.values.get('run-id'),
        runtimeDb: options.values.get('runtime-db'),
      });
    }
    throw new Error(`Unsupported THETA Agent command: ${command ?? '(empty)'}`);
  }

  parseReplLine(line: string): ConversationCommand {
    const trimmed = line.trim();
    if (!trimmed) return conversationCommandSchema.parse({ kind: 'help' });
    const separator = trimmed.search(/\s/);
    const name = (separator === -1 ? trimmed : trimmed.slice(0, separator))
      .toLowerCase()
      .replace(/^\//, '');
    const argument =
      separator === -1 ? undefined : optional(trimmed.slice(separator + 1));

    if (name === 'help') {
      requireNoArgument(name, argument);
      return conversationCommandSchema.parse({ kind: 'help' });
    }
    if (name === 'answer' || name === 'columns') {
      if (!argument) throw new Error(`/${name} requires natural-language text.`);
      return conversationCommandSchema.parse({ kind: name, text: argument });
    }
    if (name === 'llm') {
      if (argument !== 'on' && argument !== 'off') {
        throw new Error('/llm requires "on" or "off".');
      }
      return conversationCommandSchema.parse({
        kind: 'llm',
        enabled: argument === 'on',
      });
    }
    if (name === 'model') {
      const parts = argument?.split(/\s+/u).filter(Boolean) ?? [];
      const action = parts[0] ?? 'current';
      if (action === 'list' || action === 'current' || action === 'reset') {
        if (parts.length > 1) throw new Error(`/model ${action} does not accept arguments.`);
        return conversationCommandSchema.parse({ kind: 'model', action });
      }
      if (action !== 'use' || parts.length !== 3) {
        throw new Error('/model requires "list", "current", "reset", or "use <provider> <model>".');
      }
      return conversationCommandSchema.parse({
        kind: 'model',
        action,
        providerId: parts[1],
        model: parts[2],
      });
    }
    if (name === 'history' || name === 'brief') {
      requireNoArgument(name, argument);
      return conversationCommandSchema.parse({ kind: name });
    }
    if (
      name === 'next' ||
      name === 'done' ||
      name === 'follow' ||
      name === 'logs' ||
      name === 'results' ||
      name === 'summary' ||
      name === 'runs' ||
      name === 'retry' ||
      name === 'reevaluate'
    ) {
      requireNoArgument(name, argument);
      return conversationCommandSchema.parse({ kind: name });
    }
    if (name === 'details') {
      const parts = argument?.split(/\s+/u).filter(Boolean) ?? [];
      const pageText = parts.at(-1);
      const hasPage = Boolean(pageText && /^\d+$/u.test(pageText));
      return conversationCommandSchema.parse({
        kind: 'details',
        ...(parts.length - (hasPage ? 1 : 0) > 0
          ? { section: parts.slice(0, hasPage ? -1 : undefined).join('.') }
          : {}),
        page: hasPage ? Number(pageText) : 1,
      });
    }
    if (name === 'open-results') {
      requireNoArgument(name, argument);
      return conversationCommandSchema.parse({ kind: 'openResults' });
    }
    if (name === 'adjust') {
      if (!argument) {
        throw new Error('/adjust requires a natural-language change.');
      }
      return conversationCommandSchema.parse({ kind: 'adjust', text: argument });
    }
    if (name === 'cancel') {
      if (!argument) {
        throw new Error(
          '/cancel requires a reason, for example /cancel 参数设置错误',
        );
      }
      const confirm = /(?:^|\s)--confirm(?:\s|$)/u.test(argument);
      return conversationCommandSchema.parse({
        kind: 'cancel',
        text: argument.replace(/(?:^|\s)--confirm(?:\s|$)/gu, ' ').trim(),
        confirm,
      });
    }
    if (name === 'start') {
      if (!argument) throw new Error('/start requires a dataset path.');
      return conversationCommandSchema.parse({
        kind: 'start',
        filePath: argument,
      });
    }
    if (name === 'why') {
      const parts = (argument ?? '').split(/\s+/u).filter(Boolean);
      const sections = new Set(['all', 'model', 'parameters', 'protocol', 'evidence']);
      const section = parts[0] && sections.has(parts[0]) ? parts.shift() : 'all';
      return conversationCommandSchema.parse({
        kind: 'why',
        section,
        ...(parts[0] ? { runId: parts[0] } : {}),
      });
    }
    if (
      name === 'status' ||
      name === 'evidence' ||
      name === 'plan' ||
      name === 'approve' ||
      name === 'save'
    ) {
      return conversationCommandSchema.parse({
        kind: name,
        runId: argument,
      });
    }
    if (name === 'approve-plan' || name === 'start-training') {
      const acceptDegradation =
        name === 'approve-plan' &&
        /(?:^|\s)--accept-degradation(?:\s|$)/u.test(argument ?? '');
      const runId = argument
        ?.replace(/(?:^|\s)--accept-degradation(?:\s|$)/gu, ' ')
        .trim();
      return conversationCommandSchema.parse({
        kind: name === 'approve-plan' ? 'approvePlan' : 'startTraining',
        ...(runId ? { runId } : {}),
        ...(name === 'approve-plan' ? { acceptDegradation } : {}),
      });
    }
    if (name === 'back' || name === 'exit') {
      requireNoArgument(name, argument);
      return conversationCommandSchema.parse({ kind: name });
    }
    if (!trimmed.startsWith('/')) {
      return conversationCommandSchema.parse({
        kind: 'natural',
        text: trimmed,
      });
    }
    throw new Error(`Unsupported REPL command "${name}". Use /help.`);
  }
}

interface ParsedOptions {
  values: Map<string, string>;
  booleans: Set<string>;
}

const parseOptions = (
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
): ParsedOptions => {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (booleanOptions.has(name)) {
      if (equals !== -1) {
        throw new Error(`Boolean option --${name} does not accept a value.`);
      }
      booleans.add(name);
      continue;
    }
    if (!valueOptions.has(name)) {
      throw new Error(`Unknown option --${name}.`);
    }
    const value =
      equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (!value || (equals === -1 && value.startsWith('--'))) {
      throw new Error(`Option --${name} requires a value.`);
    }
    values.set(name, value);
    if (equals === -1) index += 1;
  }
  return { values, booleans };
};

const requiredOption = (values: Map<string, string>, name: string): string => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
};

const optional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed || undefined;
};

const optionalPositiveInteger = (
  value: string | undefined,
  name: string,
  maximum: number,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `Option --${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return parsed;
};

const requiredBoundedInteger = (
  values: Map<string, string>,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number(requiredOption(values, name));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Option --${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
};

const requiredConfidence = (
  values: Map<string, string>,
): 'low' | 'medium' | 'high' => {
  const value = requiredOption(values, 'confidence');
  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new Error('Option --confidence must be low, medium, or high.');
  }
  return value;
};

const requiredCsv = (
  values: Map<string, string>,
  name: string,
): string[] => {
  const entries = optionalCsv(requiredOption(values, name));
  if (entries.length === 0) {
    throw new Error(`Option --${name} must contain at least one value.`);
  }
  return entries;
};

const optionalCsv = (value: string | undefined): string[] =>
  value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

const requireNoArgument = (
  command: string,
  argument: string | undefined,
): void => {
  if (argument) throw new Error(`/${command} does not accept an argument.`);
};
