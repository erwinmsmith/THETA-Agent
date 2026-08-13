import { z } from 'zod';
import {
  columnConfirmationDraftSchema,
  researchBriefPatchSchema,
} from '../research/contracts.js';

export const NATURAL_LANGUAGE_CONTRACT_VERSION = '1.0.0';

const boundedText = z.string().trim().min(1).max(2000);
const recentMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: boundedText,
  })
  .strict();

export const naturalLanguageRequestSchema = z.discriminatedUnion('task', [
  z
    .object({
      schemaVersion: z.literal(NATURAL_LANGUAGE_CONTRACT_VERSION),
      task: z.literal('interpret_research_answer'),
      gapId: z.string().trim().min(1).max(160),
      field: z.string().trim().min(1).max(160),
      question: boundedText,
      answer: boundedText,
      currentBrief: z.record(z.unknown()),
      nextGapCandidates: z
        .array(
          z
            .object({
              gapId: z.string().trim().min(1).max(160),
              field: z.string().trim().min(1).max(160),
              reason: boundedText,
              draftQuestion: boundedText,
            })
            .strict(),
        )
        .max(8)
        .default([]),
      recentMessages: z.array(recentMessageSchema).max(12),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(NATURAL_LANGUAGE_CONTRACT_VERSION),
      task: z.literal('generate_grilling_question'),
      gapId: z.string().trim().min(1).max(160),
      field: z.string().trim().min(1).max(160),
      reason: boundedText,
      draftQuestion: boundedText,
      attempt: z.number().int().min(1).max(8),
      currentBrief: z.record(z.unknown()),
      recentMessages: z.array(recentMessageSchema).max(12),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(NATURAL_LANGUAGE_CONTRACT_VERSION),
      task: z.literal('interpret_column_confirmation'),
      answer: boundedText,
      datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
      columns: z.array(z.string().trim().min(1).max(240)).min(1).max(500),
      candidates: z
        .object({
          text: z.array(z.string()).max(50),
          time: z.array(z.string()).max(50),
          metadata: z.array(z.string()).max(50),
        })
        .strict(),
      columnProfiles: z
        .array(
          z
            .object({
              name: z.string().min(1),
              inferredType: z.enum(['empty', 'number', 'datetime', 'text', 'string']),
              nonEmptySampleCount: z.number().int().nonnegative(),
              uniqueSampleCount: z.number().int().nonnegative(),
              avgLength: z.number().nonnegative(),
              maxLength: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .max(500)
        .default([]),
      recentMessages: z.array(recentMessageSchema).max(12),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(NATURAL_LANGUAGE_CONTRACT_VERSION),
      task: z.literal('classify_conversation_intent'),
      text: boundedText,
      currentState: z.string().trim().min(1).max(160).optional(),
      pendingActionRef: z.string().trim().min(1).max(160).optional(),
      currentQuestion: boundedText.optional(),
      recentMessages: z.array(recentMessageSchema).max(12).default([]),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(NATURAL_LANGUAGE_CONTRACT_VERSION),
      task: z.literal('propose_readonly_tool'),
      text: boundedText,
      currentState: z.string().trim().min(1).max(160).optional(),
      allowedToolIds: z
        .array(
          z.enum([
            'theta.status.read',
            'theta.evidence.read',
            'theta.rag.search',
            'theta.model.catalog',
          ]),
        )
        .max(4),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(NATURAL_LANGUAGE_CONTRACT_VERSION),
      task: z.literal('compose_grounded_response'),
      userText: boundedText,
      toolId: z.string().trim().min(1).max(160).nullable(),
      facts: z.record(z.unknown()),
      evidence: z
        .array(
          z
            .object({
              evidenceId: z.string().trim().min(1).max(160),
              excerpt: boundedText,
            })
            .strict(),
        )
        .max(5),
      recentMessages: z.array(recentMessageSchema).max(12),
    })
    .strict(),
]);

const researchAnswerOutputSchema = z
  .object({
    task: z.literal('interpret_research_answer'),
    patch: researchBriefPatchSchema,
    answeredFields: z.array(z.string().trim().min(1).max(160)).max(30),
    unresolvedFields: z.array(z.string().trim().min(1).max(160)).max(30),
    confidenceByField: z.record(z.number().min(0).max(1)),
    evidenceSpans: z
      .record(z.array(z.string().trim().min(1).max(1000)).max(5))
      .default({}),
    remainingQuestions: z.array(boundedText).max(8).default([]),
    needsConfirmation: z.boolean(),
    explanation: boundedText,
    questionSuggestions: z
      .array(
        z
          .object({
            gapId: z.string().trim().min(1).max(160),
            field: z.string().trim().min(1).max(160),
            question: boundedText,
            examples: z.array(z.string().trim().min(1).max(500)).max(3),
            answerHint: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict();

const grillingQuestionOutputSchema = z
  .object({
    task: z.literal('generate_grilling_question'),
    gapId: z.string().trim().min(1).max(160),
    field: z.string().trim().min(1).max(160),
    question: boundedText,
    reason: boundedText,
    examples: z.array(z.string().trim().min(1).max(500)).max(3),
    answerHint: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const columnOutputSchema = z
  .object({
    task: z.literal('interpret_column_confirmation'),
    draft: columnConfirmationDraftSchema.optional(),
    unknownMentions: z.array(z.string().trim().min(1).max(240)).max(30),
    ambiguousMentions: z.array(z.string().trim().min(1).max(240)).max(30),
    confidence: z.number().min(0).max(1),
    needsClarification: z.boolean(),
    explanation: boundedText,
  })
  .strict();

export const conversationIntentSchema = z.enum([
  'read_status',
  'read_evidence',
  'search_evidence',
  'list_models',
  'explain_current',
  'approve_current',
  'reject_current',
  'help',
  'chat',
  'research_answer',
  'unknown',
]);

const intentOutputSchema = z
  .object({
    task: z.literal('classify_conversation_intent'),
    intent: conversationIntentSchema,
    response: boundedText,
  })
  .strict();

const groundedResponseOutputSchema = z
  .object({
    task: z.literal('compose_grounded_response'),
    text: boundedText,
    evidenceIds: z.array(z.string().trim().min(1).max(160)).max(5),
  })
  .strict();

export const readonlyToolProposalSchema = z
  .object({
    task: z.literal('propose_readonly_tool'),
    intent: conversationIntentSchema,
    toolId: z
      .enum([
        'theta.status.read',
        'theta.evidence.read',
        'theta.rag.search',
        'theta.model.catalog',
      ])
      .nullable(),
    arguments: z.record(z.unknown()),
    reason: boundedText,
    confidence: z.number().min(0).max(1),
    requiresConfirmation: z.boolean(),
  })
  .strict();

export const naturalLanguageProviderOutputSchema = z.discriminatedUnion(
  'task',
  [
    researchAnswerOutputSchema,
    grillingQuestionOutputSchema,
    columnOutputSchema,
    intentOutputSchema,
    readonlyToolProposalSchema,
    groundedResponseOutputSchema,
  ],
);

export const naturalLanguageResultSchema = z
  .object({
    schemaVersion: z.literal(NATURAL_LANGUAGE_CONTRACT_VERSION),
    source: z.preprocess(
      (value) => value === 'minimax' ? 'provider' : value,
      z.enum(['provider', 'deterministic']),
    ),
    fallbackReason: z.string().optional(),
    factsHash: z.string().regex(/^[a-f0-9]{64}$/),
    telemetry: z
      .object({
        providerId: z.string().min(1),
        model: z.string().min(1).nullable(),
        durationMs: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
        fallback: z.boolean(),
      })
      .strict()
      .default({
        providerId: 'deterministic',
        model: null,
        durationMs: 0,
        fallback: true,
      }),
    output: naturalLanguageProviderOutputSchema,
  })
  .strict();

export type NaturalLanguageRequest = z.input<
  typeof naturalLanguageRequestSchema
>;
export type NaturalLanguageProviderOutput = z.infer<
  typeof naturalLanguageProviderOutputSchema
>;
export type NaturalLanguageResult = z.infer<
  typeof naturalLanguageResultSchema
>;
export type ConversationIntent = z.infer<typeof conversationIntentSchema>;
export type ReadonlyToolProposal = z.infer<typeof readonlyToolProposalSchema>;
