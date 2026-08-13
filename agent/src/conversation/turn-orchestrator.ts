import { createHash, randomUUID } from 'node:crypto';
import {
  researchBriefSchema,
  type DatasetProfile,
  type InformationGap,
  type PlannedQuestion,
} from '@theta-agent/domain/research/contracts.js';
import { ResearchBriefMerger } from '../research/research-brief-merger.js';
import {
  THETA_APPROVAL_KEYS,
  THETA_WORKFLOW_STATES,
} from '@theta-agent/domain/domain.js';
import {
  ThetaWorkflowService,
  type ThetaWorkflowConversationContext,
} from '../theta-workflow-service.js';
import { ThetaNaturalLanguageService } from '@theta-agent/tools/support/language/natural-service.js';
import { guardCriticalResearchPatch } from '@theta-agent/tools/support/language/research-answer-guards.js';
import { sanitizeLanguageText } from '@theta-agent/tools/support/language/sanitizer.js';
import {
  NATURAL_LANGUAGE_CONTRACT_VERSION,
  naturalLanguageResultSchema,
  type ConversationIntent,
  type NaturalLanguageRequest,
  type NaturalLanguageResult,
  type ReadonlyToolProposal,
} from '@theta-agent/domain/conversation/natural-contracts.js';
import type {
  ConversationMessage,
  ConversationStore,
} from './message-store.js';
import type { ConversationCommand } from './contracts.js';
import {
  runApprovedThetaConversationLanguage,
  runThetaModelCatalog,
  runThetaRagSearch,
} from '@theta-agent/tools/hypha-runner.js';
import { ThetaConversationWorkflowExecutor } from './workflow-executor.js';
import {
  commandNeedsActiveRun,
  noActiveRunResult,
} from './no-active-run.js';

import {
  parsePlanAdjustmentRequest,
  type CurrentPlanAdjustmentValues,
  type PlanAdjustmentIntent,
} from './plan-adjustment.js';

export { parsePlanAdjustment } from './plan-adjustment.js';

const workflowCriticalLanguageTasks = new Set<NaturalLanguageRequest['task']>([
  'interpret_research_answer',
  'generate_grilling_question',
  'interpret_column_confirmation',
  'classify_conversation_intent',
]);

const workflowCriticalLanguageTask = (
  task: NaturalLanguageRequest['task'],
): boolean => workflowCriticalLanguageTasks.has(task);

const formatResearchIntentSummary = (
  summary: NonNullable<ThetaWorkflowConversationContext['researchIntentSummary']>,
): string => [
  '请确认下面的研究意图：',
  `研究问题：${summary.researchQuestion}`,
  `比较：${summary.comparison.enabled
    ? `${summary.comparison.dimensions.join('、')}（${summary.comparison.purpose === 'model' ? '进入模型估计' : '仅结果展示'}）`
    : '不做分组比较'}`,
  `时间：${summary.temporal.enabled
    ? `${summary.temporal.columns.join('、') || '时间列'}（${summary.temporal.purpose === 'topic_evolution' ? '模型学习主题演化' : '训练后绘制趋势'}）`
    : '不做时间分析'}`,
  `主题粒度：${summary.topicGranularity === 'coarse' ? '少量宽泛主题' : summary.topicGranularity === 'fine' ? '更多细粒度主题' : '中等粒度'}`,
  `成功标准：${summary.successCriteria.join('；') || '采用系统建议'}`,
  `交付内容：${summary.deliverables.join('、') || '主题表、关键词和代表文本'}`,
  `约束：${summary.constraints.join('；') || '无额外约束'}`,
  '确认无误请输入 /approve；需要修改时，直接说明“把……改为……”。',
].join('\n');

export interface TurnContext {
  sessionId: string;
  activeRunId?: string;
  runtimeDb: string;
}

export interface TurnResult {
  value: unknown;
  activeRunId?: string;
}

export class ThetaTurnOrchestrator {
  private readonly merger = new ResearchBriefMerger();

  constructor(
    private readonly store: ConversationStore,
    private readonly workflow = new ThetaWorkflowService(),
    private readonly deterministicLanguage = new ThetaNaturalLanguageService(),
    private readonly deterministicExecutor = new ThetaConversationWorkflowExecutor(
      workflow,
    ),
  ) {}

  async execute(
    command: ConversationCommand,
    context: TurnContext,
  ): Promise<TurnResult> {
    const session = this.store.getOrCreateSession(context.sessionId, {
      activeRunId: context.activeRunId,
    });
    const activeRunId = context.activeRunId ?? session.activeRunId;

    if (command.kind === 'llm') {
      const updated = this.store.updateSession(context.sessionId, {
        languageConsent: command.enabled,
        providerMode: command.enabled ? 'minimax' : 'deterministic',
      });
      return {
        value: {
          kind: 'language.consent',
          enabled: updated.languageConsent,
          providerMode: updated.providerMode,
          scope: [
            'interpret_research_answer',
            'generate_grilling_question',
            'interpret_column_confirmation',
            'classify_conversation_intent',
            'propose_readonly_tool',
            'compose_grounded_response',
            'draft_training_plan',
          ],
          trainingApprovalGranted: false,
          hasActiveRun: Boolean(activeRunId),
        },
        activeRunId,
      };
    }
    if (command.kind === 'history') {
      const messages = this.store.listRecentMessages(context.sessionId, 100);
      const recoverableTurns = this.store.listRecoverableTurns(context.sessionId);
      return {
        value: {
          kind: 'conversation.history',
          sessionId: context.sessionId,
          messages: activeRunId
            ? messages.filter((message) => message.runId === activeRunId)
            : messages,
          recoverableTurns: activeRunId
            ? recoverableTurns.filter((turn) => turn.runId === activeRunId)
            : recoverableTurns,
          hasActiveRun: Boolean(activeRunId),
        },
        activeRunId,
      };
    }
    if (commandNeedsActiveRun(command, activeRunId)) {
      return { value: noActiveRunResult(command.kind) };
    }
    if (command.kind === 'brief') {
      const runId = requiredRun(activeRunId);
      const workflowContext = await this.workflow.conversationContext(
        runId,
        context.runtimeDb,
      );
      return {
        value: {
          kind: 'research.brief',
          current: workflowContext.researchBrief,
          currentState: workflowContext.status.currentState,
          status: workflowContext.status.status,
          revisions: this.store.listBriefRevisions(runId),
        },
        activeRunId: runId,
      };
    }
    if (command.kind === 'done') {
      return this.finishResearchInterview({
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'adjust') {
      return this.adjustPlan(command.text, {
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'answer') {
      return this.answer(command.text, {
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'columns') {
      return this.columns(command.text, {
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'natural') {
      if (activeRunId) {
        const current = await this.workflow.conversationContext(
          activeRunId,
          context.runtimeDb,
        );
        if (
          current.status.pendingActionRef ===
          THETA_APPROVAL_KEYS.researchClarification
        ) {
          return this.researchNaturalTurn(command.text, current, {
            ...context,
            activeRunId,
          });
        }
        if (
          current.status.pendingActionRef ===
          THETA_APPROVAL_KEYS.columnConfirmation
        ) {
          return this.columns(command.text, { ...context, activeRunId });
        }
        if (
          current.status.pendingActionRef === THETA_APPROVAL_KEYS.researchIntent ||
          current.status.pendingActionRef === THETA_APPROVAL_KEYS.researchIntentReview
        ) {
          return this.answerV2Intent(command.text, { ...context, activeRunId });
        }
      }
      return this.freeText(command.text, { ...context, activeRunId });
    }

    const result = await this.deterministicExecutor.execute(command, {
      activeRunId,
      runtimeDb: context.runtimeDb,
      plannerConsent: session.languageConsent,
    });
    if (result.activeRunId) {
      this.store.updateSession(context.sessionId, {
        activeRunId: result.activeRunId,
      });
    }
    return result;
  }

  private async answer(text: string, context: TurnContext): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.conversationContext(
      runId,
      context.runtimeDb,
    );
    if (
      current.status.pendingActionRef === THETA_APPROVAL_KEYS.researchIntent ||
      current.status.pendingActionRef === THETA_APPROVAL_KEYS.researchIntentReview
    ) {
      return this.answerV2Intent(text, context, current);
    }
    if (
      current.status.pendingActionRef !==
      THETA_APPROVAL_KEYS.researchClarification
    ) {
      throw new Error('The active Run is not waiting for a research answer.');
    }
    const brief = researchBriefSchema.parse(current.researchBrief);
    const { gap, question } = activeResearchQuestion(current);
    const message = this.userMessage(context, runId, 'research.answer', text);
    const turn = this.startTurn(context, runId, message);
    const inferredAnswer = inferableUncertaintyAnswer(
      gap.field,
      text,
      current.datasetProfile,
    );
    const answerForInterpretation = inferredAnswer ?? text;
    try {
      const language = await this.language(
        {
          schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
          task: 'interpret_research_answer',
          gapId: gap.id,
          field: gap.field,
          question: question.question,
          answer: answerForInterpretation,
          currentBrief: brief,
          nextGapCandidates: researchGapCandidates(current, gap.id),
          recentMessages: recent(this.store, context.sessionId, runId),
        },
        context.sessionId,
        runId,
        message.messageId,
      );
      this.store.updateTurn(turn.turnId, 'interpreted');
      const interpretation = language.output;
      if (interpretation.task !== 'interpret_research_answer') {
        throw new Error('Unexpected language result for research answer.');
      }
      const guarded = guardCriticalResearchPatch(
        gap.field,
        answerForInterpretation,
        interpretation.patch,
        interpretation.confidenceByField,
      );
      const merged = this.merger.merge(brief, guarded.patch);
      if (merged.changedFields.length === 0) {
        const response = unresolvedResearchClarification(
          gap.field,
          answerForInterpretation,
          question.question,
        );
        this.assistantMessage(
          context,
          runId,
          'research.clarification',
          response,
        );
        this.assistantMessage(
          context,
          runId,
          'research.note',
          `本轮没有修改研究档案：${interpretation.explanation}`,
        );
        this.store.updateTurn(turn.turnId, 'responded');
        return {
          value: {
            kind: 'research.answer.unresolved',
            explanation: interpretation.explanation,
            activeQuestion: question.question,
          },
          activeRunId: runId,
        };
      }
      const resumed = await this.workflow.resume({
        runId,
        runtimeDb: context.runtimeDb,
        researchAnswers: merged.patch as Record<string, unknown>,
        approvedBy: 'local_user',
      });
      this.store.updateTurn(turn.turnId, 'fsm_resumed');
      const parent = this.store.getLatestBrief(runId);
      this.store.appendBriefRevision({
        revisionId: `brief.${randomUUID()}`,
        runId,
        sessionId: context.sessionId,
        ...(parent ? { parentRevisionId: parent.revisionId } : {}),
        sourceMessageId: message.messageId,
        patch: merged.patch,
        brief: merged.brief,
        briefHash: merged.briefHash,
        interpretationHash: language.factsHash,
        fieldEvidence: Object.fromEntries(
          merged.changedFields.map((field) => [
            field,
            {
              sourceText: inferredAnswer
                ? `${message.content}（采用本地数据预检结论：${inferredAnswer}）`
                : message.content,
              confidence:
                guarded.correctedFields.includes(field)
                  ? 1
                  : (interpretation.confidenceByField[field] ?? 0),
              evidenceSpans:
                interpretation.evidenceSpans[field] ?? [answerForInterpretation],
            },
          ]),
        ),
        createdAt: new Date().toISOString(),
      });
      this.store.updateTurn(turn.turnId, 'brief_applied');
      const next = await this.workflow.conversationContext(
        runId,
        context.runtimeDb,
      );
      const nextQuestion = this.questionAfterAnswer(
        next,
        interpretation.questionSuggestions,
      );
      const note = [
        `已记录：${merged.changedFields.map(researchFieldLabel).join('、')}。`,
        guarded.correctedFields.length > 0
          ? `我按你的明确表述校正了${guarded.correctedFields
              .map(researchFieldLabel)
              .join('、')}，避免模型误读否定句。`
          : '',
        merged.conflictingFields.length > 0
          ? `本次回答更新了之前的${merged.conflictingFields
              .map(researchFieldLabel)
              .join('、')}。`
          : '',
        inferredAnswer
          ? '你表示暂不确定，因此我采用了本地数据预检中可验证的初步结论；之后仍可更正。'
          : '',
        guarded.confirmationFields.length > 0
          ? `仍需明确确认：${guarded.confirmationFields
              .map(researchFieldLabel)
              .join('、')}。`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      const response = nextQuestion || '研究设置已更新，系统正在进入下一步。';
      this.assistantMessage(context, runId, 'research.question', response);
      this.assistantMessage(context, runId, 'research.note', note);
      this.store.updateTurn(turn.turnId, 'responded');
      return {
        value: {
          kind: 'research.answer.applied',
          patch: merged.patch,
          changedFields: merged.changedFields,
          conflictingFields: merged.conflictingFields,
          briefHash: merged.briefHash,
          workflow: resumed,
          languageTelemetry: language.telemetry,
          response,
        },
        activeRunId: runId,
      };
    } catch (error) {
      this.store.updateTurn(turn.turnId, 'failed', errorRecord(error));
      throw error;
    }
  }

  private async answerV2Intent(
    text: string,
    context: TurnContext,
    existing?: ThetaWorkflowConversationContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = existing ?? await this.workflow.conversationContext(
      runId,
      context.runtimeDb,
    );
    if (
      current.status.pendingActionRef !== THETA_APPROVAL_KEYS.researchIntent &&
      current.status.pendingActionRef !== THETA_APPROVAL_KEYS.researchIntentReview
    ) {
      throw new Error('当前没有等待回答或修改的研究意图。');
    }
    const correction = current.status.pendingActionRef === THETA_APPROVAL_KEYS.researchIntentReview;
    const message = this.userMessage(
      context,
      runId,
      correction ? 'research.intent-correction' : 'research.decision-answer',
      text,
    );
    const turn = this.startTurn(context, runId, message);
    try {
      const resumed = await this.workflow.resume({
        runId,
        runtimeDb: context.runtimeDb,
        decisionAnswer: text,
        approvedBy: 'local_user',
      });
      this.store.updateTurn(turn.turnId, 'fsm_resumed');
      const next = await this.workflow.conversationContext(runId, context.runtimeDb);
      const response = next.decisionGap?.question ?? (
        next.researchIntentSummary
          ? formatResearchIntentSummary(next.researchIntentSummary)
          : next.status.pendingReason ?? '研究意图已更新。'
      );
      this.assistantMessage(
        context,
        runId,
        next.researchIntentSummary ? 'research.intent-summary' : 'research.decision-gap',
        response,
      );
      this.store.updateTurn(turn.turnId, 'responded');
      return {
        value: {
          kind: correction ? 'research.intent-revised' : 'research.intent-updated',
          workflow: resumed,
          researchIntent: next.researchIntent,
          researchIntentSummary: next.researchIntentSummary,
          response,
        },
        activeRunId: runId,
      };
    } catch (error) {
      this.store.updateTurn(turn.turnId, 'failed', errorRecord(error));
      throw error;
    }
  }

  private async researchNaturalTurn(
    text: string,
    current: ThetaWorkflowConversationContext,
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    if (isObviousAssistantRequest(text)) {
      return this.freeText(text, context, current);
    }
    const { question } = activeResearchQuestion(current);
    const routing = await this.language(
      {
        schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        task: 'classify_conversation_intent',
        text,
        currentState: current.status.currentState,
        pendingActionRef: current.status.pendingActionRef,
        currentQuestion: question.question,
        recentMessages: recent(this.store, context.sessionId, runId),
      },
      context.sessionId,
      runId,
    );
    if (
      routing.output.task === 'classify_conversation_intent' &&
      routing.output.intent !== 'research_answer'
    ) {
      return this.freeText(text, context, current);
    }
    return this.answer(text, context);
  }

  private async finishResearchInterview(
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.conversationContext(
      runId,
      context.runtimeDb,
    );
    if (
      current.status.pendingActionRef !==
      THETA_APPROVAL_KEYS.researchClarification
    ) {
      throw new Error('当前没有可以结束的研究访谈。');
    }
    const brief = researchBriefSchema.parse(current.researchBrief);
    const blocking = Array.isArray(current.researchAssessment?.gaps)
      ? current.researchAssessment.gaps
          .map(safeGap)
          .filter(
            (item): item is InformationGap =>
              item !== undefined && item.severity === 'blocking',
          )
      : [];
    if (blocking.length > 0) {
      const { question } = activeResearchQuestion(current);
      const response = `研究设置还缺 ${blocking.length} 项必填信息，暂时不会进入数据列确认。请先回答：${question.question}`;
      this.assistantMessage(
        context,
        runId,
        'research.clarification',
        response,
      );
      this.assistantMessage(
        context,
        runId,
        'research.note',
        `完整度检查未修改研究档案；当前仍有 ${blocking.length} 项阻塞信息。`,
      );
      return {
        value: {
          kind: 'research.answer.unresolved',
          explanation: `还有 ${blocking.length} 项必填信息未确认。`,
          activeQuestion: question.question,
          response,
        },
        activeRunId: runId,
      };
    }
    const message = this.userMessage(
      context,
      runId,
      'research.interview.done',
      '结束扩展访谈并开始分析',
    );
    const merged = this.merger.merge(brief, { interviewComplete: true });
    const parent = this.store.getLatestBrief(runId);
    this.store.appendBriefRevision({
      revisionId: `brief.${randomUUID()}`,
      runId,
      sessionId: context.sessionId,
      ...(parent ? { parentRevisionId: parent.revisionId } : {}),
      sourceMessageId: message.messageId,
      patch: merged.patch,
      brief: merged.brief,
      briefHash: merged.briefHash,
      interpretationHash: hash({ command: 'done', runId }),
      createdAt: new Date().toISOString(),
    });
    const resumed = await this.workflow.resume({
      runId,
      runtimeDb: context.runtimeDb,
      researchAnswers: { interviewComplete: true },
      approvedBy: 'local_user',
    });
    const response =
      '扩展研究访谈已结束。系统会保留已确认的信息，并开始检查数据集。';
    this.assistantMessage(
      context,
      runId,
      'research.interview.completed',
      response,
    );
    return {
      value: {
        kind: 'research.answer.applied',
        changedFields: ['interviewComplete'],
        patch: { interviewComplete: true },
        workflow: resumed,
        response,
      },
      activeRunId: runId,
    };
  }

  private async adjustPlan(
    text: string,
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.status(runId, context.runtimeDb);
    if (current.pendingActionRef !== THETA_APPROVAL_KEYS.planReview) {
      throw new Error('只有在训练方案审批阶段才能调整模型或参数。');
    }
    const plan = await this.workflow.plan(runId, context.runtimeDb);
    const currentValues = currentPlanAdjustmentValues(plan);
    const parsed = parsePlanAdjustmentRequest(text, currentValues);
    const message = this.userMessage(
      context,
      runId,
      'plan.adjustment',
      text,
    );
    if (parsed.clarificationReasons.length > 0) {
      const response = [
        '方案尚未修改，因为调整语句需要确认。',
        '',
        ...parsed.clarificationReasons.map((reason) => `- ${reason}`),
        '',
        '请重新输入明确的最终值，例如：`/adjust 主题数改为 8`。',
      ].join('\n');
      this.assistantMessage(
        context,
        runId,
        'plan.adjustment.clarification_required',
        response,
      );
      return {
        value: {
          kind: 'plan.adjustment.clarification_required',
          intents: parsed.intents,
          reasons: parsed.clarificationReasons,
          sourceMessageId: message.messageId,
          response,
        },
        activeRunId: runId,
      };
    }
    const adjustment = parsed.patch;
    const compatibleModels = recommendedModelIds(plan);
    const requestedModel =
      typeof adjustment.modelId === 'string'
        ? adjustment.modelId.toLowerCase()
        : undefined;
    if (
      requestedModel &&
      compatibleModels.length > 0 &&
      !compatibleModels.includes(requestedModel)
    ) {
      const response = `本次数据只允许选择已经通过能力约束的模型：${compatibleModels
        .map((modelId) => modelId.toUpperCase())
        .join('、')}。方案未修改。`;
      this.assistantMessage(context, runId, 'plan.adjustment.rejected', response);
      return {
        value: {
          kind: 'plan.adjustment.rejected',
          requestedModel,
          compatibleModels,
          sourceMessageId: message.messageId,
          response,
        },
        activeRunId: runId,
      };
    }
    if (isSamePlanAdjustment(adjustment, currentValues)) {
      const response = '模型设置与当前候选方案一致，无需重复应用。';
      this.assistantMessage(context, runId, 'plan.adjustment.unchanged', response);
      return {
        value: {
          kind: 'plan.adjustment.unchanged',
          sourceMessageId: message.messageId,
          response,
        },
        activeRunId: runId,
      };
    }
    const resumed = await this.workflow.resume({
      runId,
      runtimeDb: context.runtimeDb,
      planAdjustment: adjustment,
    });
    const changed = planAdjustmentSummary(
      parsed.intents,
      adjustment,
      currentValues,
    );
    const response = `已应用方案调整：${changed}。系统已重新验证候选计划，旧的待审批方案不会被直接复用。`;
    this.assistantMessage(context, runId, 'plan.adjusted', response);
    return {
      value: {
        kind: 'plan.adjusted',
        adjustment,
        intents: parsed.intents,
        sourceMessageId: message.messageId,
        workflow: resumed,
        response,
      },
      activeRunId: runId,
    };
  }

  private async columns(
    text: string,
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.conversationContext(
      runId,
      context.runtimeDb,
    );
    if (
      current.status.pendingActionRef !==
        THETA_APPROVAL_KEYS.columnConfirmation ||
      !current.datasetProfile
    ) {
      throw new Error('The active Run is not waiting for column confirmation.');
    }
    const profile = current.datasetProfile;
    const message = this.userMessage(context, runId, 'columns.answer', text);
    const turn = this.startTurn(context, runId, message);
    try {
      const language = await this.language(
        {
          schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
          task: 'interpret_column_confirmation',
          answer: text,
          datasetSha256: profile.datasetSha256,
          columns: profile.columns,
          candidates: {
            text: profile.columnCandidates.text.map((item) => item.name),
            time: profile.columnCandidates.time.map((item) => item.name),
            metadata: profile.columnCandidates.metadata.map((item) => item.name),
          },
          columnProfiles: profile.columnProfiles,
          recentMessages: recent(this.store, context.sessionId, runId),
        },
        context.sessionId,
        runId,
        message.messageId,
      );
      this.store.updateTurn(turn.turnId, 'interpreted');
      if (
        language.output.task !== 'interpret_column_confirmation' ||
        language.output.needsClarification ||
        !language.output.draft
      ) {
        const explanation =
          language.output.task === 'interpret_column_confirmation'
            ? language.output.explanation
            : '无法解释列确认。';
        this.assistantMessage(
          context,
          runId,
          'columns.clarification',
          explanation,
        );
        this.store.updateTurn(turn.turnId, 'responded');
        return {
          value: {
            kind: 'columns.unresolved',
            explanation,
            columns: profile.columns,
            ...(language.output.task === 'interpret_column_confirmation' && language.output.draft
              ? { proposedDraft: language.output.draft }
              : {}),
          },
          activeRunId: runId,
        };
      }
      const resumed = await this.workflow.resume({
        runId,
        runtimeDb: context.runtimeDb,
        columnConfirmation: language.output.draft,
        approvedBy: 'local_user',
      });
      this.store.updateTurn(turn.turnId, 'fsm_resumed');
      const response = `数据列已经确认：正文列 ${language.output.draft.textColumns.join('、')}，时间列 ${language.output.draft.timeColumn ?? '无'}，ID 列 ${language.output.draft.idColumn ?? '无'}，训练协变量 ${(language.output.draft.covariateColumns ?? []).join('、') || '无'}，描述元数据 ${language.output.draft.metadataColumns.join('、') || '无'}，展示分组 ${(language.output.draft.groupingColumns ?? []).join('、') || '无'}，评估标签 ${(language.output.draft.evaluationLabelColumns ?? []).join('、') || '无'}。`;
      this.assistantMessage(context, runId, 'columns.confirmed', response);
      this.store.updateTurn(turn.turnId, 'responded');
      return {
        value: {
          kind: 'columns.confirmed',
          draft: language.output.draft,
          datasetSha256: profile.datasetSha256,
          workflow: resumed,
          languageTelemetry: language.telemetry,
          response,
        },
        activeRunId: runId,
      };
    } catch (error) {
      this.store.updateTurn(turn.turnId, 'failed', errorRecord(error));
      throw error;
    }
  }

  private async freeText(
    text: string,
    context: TurnContext,
    suppliedWorkflowContext?: ThetaWorkflowConversationContext,
  ): Promise<TurnResult> {
    const runId = context.activeRunId;
    const workflowContext =
      suppliedWorkflowContext ??
      (runId
        ? await this.workflow.conversationContext(runId, context.runtimeDb)
        : undefined);
    const message = this.userMessage(context, runId, 'conversation.text', text);
    if (
      workflowContext?.status.pendingActionRef ===
        THETA_APPROVAL_KEYS.researchClarification &&
      asksHowToAnswer(text)
    ) {
      const active = activeResearchQuestion(workflowContext);
      const response = explainResearchQuestion(active.gap, active.question);
      this.assistantMessage(context, runId, 'conversation.response', response);
      return {
        value: {
          kind: 'conversation.turn',
          proposal: {
            task: 'propose_readonly_tool',
            intent: 'chat',
            toolId: null,
            arguments: {},
            reason: '解释当前待确认信息',
            confidence: 1,
            requiresConfirmation: false,
          },
          result: { currentQuestion: active.question.question },
          response,
          hasActiveRun: true,
          evidenceRefs: [],
        },
        activeRunId: runId,
      };
    }
    const proposal = fastReadonlyToolProposal(text, Boolean(runId));
    let toolResult: unknown;
    switch (proposal.toolId) {
      case 'theta.status.read':
        toolResult = await this.workflow.status(
          requiredRun(runId),
          context.runtimeDb,
        );
        break;
      case 'theta.evidence.read':
        toolResult = await this.workflow.evidence(
          requiredRun(runId),
          context.runtimeDb,
        );
        break;
      case 'theta.rag.search': {
        const result = await runThetaRagSearch({ query: text, limit: 5 });
        toolResult =
          result.status === 'completed'
            ? result.output
            : { status: result.status, error: result.error };
        break;
      }
      case 'theta.model.catalog': {
        const result = await runThetaModelCatalog({});
        toolResult =
          result.status === 'completed'
            ? result.output
            : { status: result.status, error: result.error };
        break;
      }
      default:
        toolResult = {
          assistant: 'THETA research-training assistant',
          capabilities: [
            '解释 THETA 当前阶段和下一步操作',
            '读取当前 Run 状态与审计证据',
            '检索 THETA 本地知识库并说明模型能力',
            '根据你的研究回答更新研究档案并调整后续问题',
            '解释训练方案、参数取舍、结果和研究限制',
          ],
          boundary:
            proposal.intent === 'approve_current' ||
            proposal.intent === 'reject_current'
              ? '我不会代替你审批方案或启动训练；这些操作必须由你显式确认。'
              : '我可以提供建议和只读分析，但不会代替你审批方案或启动训练。',
          currentState: workflowContext?.status.currentState,
          currentQuestion:
            workflowContext?.status.pendingActionRef ===
            THETA_APPROVAL_KEYS.researchClarification
              ? activeResearchQuestion(workflowContext).question.question
              : undefined,
        };
    }
    const grounding = safeGrounding(proposal.toolId, toolResult);
    const composed = await this.language(
      {
        schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        task: 'compose_grounded_response',
        userText: text,
        toolId: proposal.toolId,
        facts: grounding.facts,
        evidence: grounding.evidence,
        recentMessages: recent(this.store, context.sessionId, runId).slice(-6),
      },
      context.sessionId,
      runId,
      message.messageId,
    );
    const response =
      composed.output.task === 'compose_grounded_response'
        ? composed.output.text
        : '无法生成受事实约束的回复。';
    this.assistantMessage(context, runId, 'conversation.response', response);
    return {
      value: {
        kind: 'conversation.turn',
        proposal,
        result: toolResult,
        response,
        hasActiveRun: Boolean(runId),
        evidenceRefs:
          composed.output.task === 'compose_grounded_response'
            ? composed.output.evidenceIds
            : [],
      },
      activeRunId: runId,
    };
  }

  private async dynamicQuestion(
    context: ThetaWorkflowConversationContext,
    sessionId: string,
    runId: string,
  ): Promise<string> {
    if (
      context.status.currentState !==
        THETA_WORKFLOW_STATES.awaitResearchClarification ||
      context.status.pendingActionRef !==
        THETA_APPROVAL_KEYS.researchClarification
    ) {
      if (
        context.status.currentState ===
        THETA_WORKFLOW_STATES.awaitColumnConfirmation
      ) {
        return '接下来请确认正文列、时间列、ID 列和元数据列。';
      }
      return context.status.pendingReason
        ? `下一步：${context.status.pendingReason}`
        : '研究信息已经满足当前要求，系统正在进入下一步。使用 /status 可以查看进度。';
    }
    const { gap, question } = activeResearchQuestion(context);
    const generated = await this.language(
      {
        schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        task: 'generate_grilling_question',
        gapId: gap.id,
        field: gap.field,
        reason: gap.reason,
        draftQuestion: question.question,
        attempt: Math.min(8, questionAttempt(this.store, sessionId, runId)),
        currentBrief: context.researchBrief ?? {},
        recentMessages: recent(this.store, sessionId, runId),
      },
      sessionId,
      runId,
    );
    if (generated.output.task !== 'generate_grilling_question') {
      return question.question;
    }
    return [
      generated.output.question,
      generated.output.examples.length > 0
        ? `例如：${generated.output.examples.join('；')}`
        : '',
      generated.output.answerHint ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private questionAfterAnswer(
    context: ThetaWorkflowConversationContext,
    suggestions: Array<{
      gapId: string;
      field: string;
      question: string;
      examples: string[];
      answerHint?: string;
    }>,
  ): string {
    if (
      context.status.currentState !==
        THETA_WORKFLOW_STATES.awaitResearchClarification ||
      context.status.pendingActionRef !==
        THETA_APPROVAL_KEYS.researchClarification
    ) {
      if (
        context.status.currentState ===
        THETA_WORKFLOW_STATES.awaitColumnConfirmation
      ) {
        return '接下来请确认正文列、时间列、ID 列和元数据列。';
      }
      return context.status.pendingReason
        ? `下一步：${context.status.pendingReason}`
        : '研究信息已经满足当前要求，系统正在进入下一步。使用 /status 可以查看进度。';
    }
    const { gap, question } = activeResearchQuestion(context);
    const suggestion = suggestions.find(
      (item) => item.gapId === gap.id && item.field === gap.field,
    );
    return [
      suggestion?.question ?? question.question,
      suggestion?.examples.length
        ? `例如：${suggestion.examples.join('；')}`
        : '',
      suggestion?.answerHint ?? '请直接用自然语言回答。',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private async language(
    request: NaturalLanguageRequest,
    sessionId: string,
    runId?: string,
    sourceMessageId?: string,
  ): Promise<NaturalLanguageResult> {
    const session = this.store.getOrCreateSession(sessionId, {
      activeRunId: runId,
    });
    let generated: NaturalLanguageResult;
    if (!session.languageConsent) {
      generated = await this.deterministicLanguage.generate(request);
    } else {
      try {
        generated = await runApprovedThetaConversationLanguage(request, {
          userId: 'local_user',
        }).then((value) => {
          if (value.status !== 'completed' || !value.output) {
            throw new Error(
              typeof value.error === 'string'
                ? value.error
                : (value.error?.message ?? `Language status=${value.status}`),
            );
          }
          return naturalLanguageResultSchema.parse(value.output);
        });
      } catch (error) {
        const fallback = await this.deterministicLanguage.generate(request);
        generated = naturalLanguageResultSchema.parse({
          ...fallback,
          fallbackReason: workflowCriticalLanguageTask(request.task)
            ? 'governed_provider_failed'
            : 'assistant_provider_failed',
          telemetry: {
            ...fallback.telemetry,
            fallback: true,
          },
        });
      }
    }
    this.store.recordLanguageInterpretation({
      interpretationId: `interpretation.${randomUUID()}`,
      sessionId,
      ...(runId ? { runId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      task: request.task,
      provider: generated.source,
      requestHash: generated.factsHash,
      responseHash: hash(generated.output),
      structuredOutput: generated,
      status: generated.fallbackReason ? 'fallback' : 'completed',
      ...(generated.fallbackReason
        ? { fallbackReason: generated.fallbackReason }
        : {}),
      createdAt: new Date().toISOString(),
    });
    return generated;
  }

  private userMessage(
    context: TurnContext,
    runId: string | undefined,
    messageKind: string,
    content: string,
  ): ConversationMessage {
    return this.store.appendMessage({
      messageId: `message.${randomUUID()}`,
      sessionId: context.sessionId,
      ...(runId ? { runId } : {}),
      role: 'user',
      messageKind,
      content: sanitizeLanguageText(content, 4000),
      createdAt: new Date().toISOString(),
    });
  }

  private assistantMessage(
    context: TurnContext,
    runId: string | undefined,
    messageKind: string,
    content: string,
  ): ConversationMessage {
    return this.store.appendMessage({
      messageId: `message.${randomUUID()}`,
      sessionId: context.sessionId,
      ...(runId ? { runId } : {}),
      role: 'assistant',
      messageKind,
      content: sanitizeLanguageText(content, 4000),
      createdAt: new Date().toISOString(),
    });
  }

  private startTurn(
    context: TurnContext,
    runId: string,
    message: ConversationMessage,
  ) {
    const now = new Date().toISOString();
    const turn = {
      turnId: `turn.${randomUUID()}`,
      sessionId: context.sessionId,
      runId,
      userMessageId: message.messageId,
      status: 'received' as const,
      idempotencyKey: hash({
        sessionId: context.sessionId,
        runId,
        messageId: message.messageId,
      }),
      createdAt: now,
      updatedAt: now,
    };
    this.store.createTurn(turn);
    return turn;
  }
}

const activeResearchQuestion = (
  context: ThetaWorkflowConversationContext,
): { gap: InformationGap; question: PlannedQuestion } => {
  const assessment = context.researchAssessment ?? {};
  const gaps = Array.isArray(assessment.gaps)
    ? assessment.gaps
        .map(safeGap)
        .filter((item): item is InformationGap => item !== undefined)
    : [];
  const questions = Array.isArray(assessment.questions)
    ? assessment.questions
        .map(safeQuestion)
        .filter((item): item is PlannedQuestion => item !== undefined)
    : [];
  const question = questions[0];
  const gap =
    gaps.find((item) => item.id === question?.gapId) ??
    gaps.find((item) => item.severity === 'blocking');
  if (!gap) throw new Error('Research clarification has no active gap.');
  return {
    gap,
    question:
      question ?? {
        gapId: gap.id,
        field: gap.field,
        question: gap.question,
        severity: gap.severity,
        score: gap.informationGain,
      },
  };
};

const researchGapCandidates = (
  context: ThetaWorkflowConversationContext,
  activeGapId: string,
): Array<{
  gapId: string;
  field: string;
  reason: string;
  draftQuestion: string;
}> => {
  const assessment = context.researchAssessment ?? {};
  const gaps = Array.isArray(assessment.gaps)
    ? assessment.gaps
        .map(safeGap)
        .filter((item): item is InformationGap => item !== undefined)
    : [];
  const questions = Array.isArray(assessment.questions)
    ? assessment.questions
        .map(safeQuestion)
        .filter((item): item is PlannedQuestion => item !== undefined)
    : [];
  const questionByGap = new Map(
    questions.map((question) => [question.gapId, question.question]),
  );
  return gaps
    .filter((gap) => gap.id !== activeGapId)
    .sort(
      (left, right) =>
        (left.severity === right.severity
          ? right.informationGain - left.informationGain
          : left.severity === 'blocking'
            ? -1
            : 1),
    )
    .slice(0, 8)
    .map((gap) => ({
      gapId: gap.id,
      field: gap.field,
      reason: gap.reason,
      draftQuestion: questionByGap.get(gap.id) ?? gap.question,
    }));
};

const safeGap = (value: unknown): InformationGap | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.field !== 'string' ||
    typeof item.question !== 'string' ||
    typeof item.reason !== 'string' ||
    (item.severity !== 'blocking' && item.severity !== 'optional') ||
    typeof item.informationGain !== 'number'
  ) {
    return;
  }
  return item as unknown as InformationGap;
};

const safeQuestion = (value: unknown): PlannedQuestion | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    typeof item.gapId !== 'string' ||
    typeof item.field !== 'string' ||
    typeof item.question !== 'string' ||
    (item.severity !== 'blocking' && item.severity !== 'optional') ||
    typeof item.score !== 'number'
  ) {
    return;
  }
  return item as unknown as PlannedQuestion;
};

const recent = (
  store: ConversationStore,
  sessionId: string,
  runId?: string,
): Array<{ role: 'user' | 'assistant'; content: string }> =>
  store
    .listRecentMessages(sessionId, 12)
    .filter((message) => !runId || message.runId === runId)
    .filter(
      (
        message,
      ): message is ConversationMessage & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant',
    )
    .map(({ role, content }) => ({ role, content }));

const questionAttempt = (
  store: ConversationStore,
  sessionId: string,
  runId: string,
): number =>
  1 +
  store
    .listRecentMessages(sessionId, 100)
    .filter(
      (message) =>
        message.runId === runId &&
        ['research.progress', 'research.note'].includes(message.messageKind),
    ).length;

const requiredRun = (runId: string | undefined): string => {
  if (!runId) throw new Error('No active Run. Use /start <dataset> first.');
  return runId;
};

const currentPlanAdjustmentValues = (
  plan: {
    validatedPlan?: unknown;
    candidatePlan?: unknown;
    planRecord?: unknown;
  },
): CurrentPlanAdjustmentValues => {
  const candidate =
    asRecord(plan.validatedPlan) ??
    asRecord(plan.candidatePlan) ??
    asRecord(asRecord(plan.planRecord)?.canonicalPlan) ??
    {};
  const model = asRecord(candidate.model) ?? candidate;
  const parameters =
    asRecord(model.parameters) ?? asRecord(candidate.parameters) ?? {};
  const protocol =
    asRecord(candidate.experimentProtocol) ??
    asRecord(model.experimentProtocol);
  const primarySeeds = Array.isArray(protocol?.primarySeeds)
    ? protocol.primarySeeds
    : [];
  return {
    numTopics:
      finiteNumber(model.numTopics) ??
      finiteNumber(parameters.numTopics) ??
      finiteNumber(candidate.numTopics) ??
      (model.numTopics === null || candidate.numTopics === null
        ? null
        : undefined),
    model:
      typeof model.modelId === 'string'
        ? model.modelId
        : typeof candidate.modelId === 'string'
          ? candidate.modelId
          : undefined,
    seed: finiteNumber(primarySeeds[0]),
    iterations:
      finiteNumber(candidate.epochs) ??
      finiteNumber(parameters.epochs) ??
      finiteNumber(model.epochs),
    covariates: stringValues(
      candidate.covariateColumns ??
        asRecord(candidate.columns)?.covariateColumns,
    ),
    ...(protocol ? { experimentProtocol: protocol } : {}),
  };
};

export const isObviousAssistantRequest = (text: string): boolean => {
  const normalized = text.trim();
  if (/^(?:你能做什么|你可以做什么|你是谁|帮助|怎么用|如何使用|现在我需要做什么|我现在需要做什么|下一步(?:做什么)?|我该做什么|你想要什么答案|我要怎么回答|我该怎么回答|这个问题是什么意思|为什么要问)(?:[？?。！!]|$)/iu.test(normalized)) {
    return true;
  }
  const asksForHelp =
    /[？?]$/u.test(normalized) ||
    /^(?:请|帮我|告诉我|解释|查看|列出|搜索|检索|为什么|怎么|如何|能否|可以)/u.test(normalized);
  const thetaTopic =
    /THETA|模型|训练|任务状态|运行状态|进度|审计|证据|知识库|助手能力|当前步骤/iu.test(normalized);
  return asksForHelp && thetaTopic;
};

export const fastReadonlyToolProposal = (
  text: string,
  hasActiveRun: boolean,
): ReadonlyToolProposal => {
  const normalized = text.trim();
  let intent: ConversationIntent = 'chat';
  let toolId: ReadonlyToolProposal['toolId'] = null;

  if (
    hasActiveRun &&
    /(?:当前|任务|训练|运行|run).{0,12}(?:状态|进度|阶段)|(?:状态|进度).{0,12}(?:怎样|如何|多少|是什么)/iu.test(normalized)
  ) {
    intent = 'read_status';
    toolId = 'theta.status.read';
  } else if (
    hasActiveRun &&
    /(?:运行|审计|事件|失败|结论).{0,12}(?:证据|依据|记录)|(?:证据|审计记录)/u.test(normalized)
  ) {
    intent = 'read_evidence';
    toolId = 'theta.evidence.read';
  } else if (/(?:有哪些|支持|可用|推荐|选择|查看|列出).{0,12}模型|模型.{0,12}(?:能力|参数|适用|列表|目录)/u.test(normalized)) {
    intent = 'list_models';
    toolId = 'theta.model.catalog';
  } else if (/知识库|本地文档|研究方法|模型依据|适用场景|检索|搜索/u.test(normalized)) {
    intent = 'search_evidence';
    toolId = 'theta.rag.search';
  } else if (/批准|同意|开始训练/u.test(normalized)) {
    intent = 'approve_current';
  } else if (/拒绝|不同意|取消/u.test(normalized)) {
    intent = 'reject_current';
  } else if (/你能做什么|你可以做什么|你是谁|帮助|怎么用|如何使用/u.test(normalized)) {
    intent = 'help';
  } else if (/为什么|解释|当前步骤|现在我需要做什么|我现在需要做什么|下一步|我该做什么/u.test(normalized)) {
    intent = 'explain_current';
  }

  return {
    task: 'propose_readonly_tool',
    intent,
    toolId,
    arguments: toolId === 'theta.rag.search' ? { query: normalized } : {},
    reason: toolId
      ? '由本地确定性意图路由选择受治理的只读工具。'
      : '当前问题可直接依据 THETA 会话上下文回答。',
    confidence: toolId ? 0.94 : 0.86,
    requiresConfirmation: false,
  };
};

const recommendedModelIds = (plan: { recommendation?: unknown }): string[] => {
  const recommendation = asRecord(plan.recommendation);
  if (!recommendation || !Array.isArray(recommendation.recommendations)) {
    return [];
  }
  return recommendation.recommendations
    .map((item) => asRecord(item)?.modelId)
    .filter((modelId): modelId is string => typeof modelId === 'string')
    .map((modelId) => modelId.toLowerCase());
};

const isSamePlanAdjustment = (
  adjustment: Record<string, unknown>,
  current: CurrentPlanAdjustmentValues,
): boolean => {
  const keys = Object.keys(adjustment);
  if (
    keys.length === 0 ||
    keys.some(
      (key) => !['modelId', 'numTopics', 'topicCountMode'].includes(key),
    )
  ) {
    return false;
  }
  if (
    typeof adjustment.modelId === 'string' &&
    adjustment.modelId.toLowerCase() !== current.model?.toLowerCase()
  ) {
    return false;
  }
  if (
    typeof adjustment.numTopics === 'number' &&
    adjustment.numTopics !== current.numTopics
  ) {
    return false;
  }
  if (adjustment.numTopics === null && current.numTopics !== null) {
    return false;
  }
  return true;
};

const planAdjustmentSummary = (
  intents: PlanAdjustmentIntent[],
  adjustment: Record<string, unknown>,
  current: CurrentPlanAdjustmentValues,
): string => {
  const intentFields = new Set<string>();
  const summaries = intents.map((intent) => {
    const field =
      intent.parameter === 'model'
        ? 'modelId'
        : intent.parameter === 'iterations'
          ? 'epochs'
          : intent.parameter === 'seed'
            ? 'experimentProtocol'
            : intent.parameter === 'covariates'
              ? 'covariateColumns'
              : intent.parameter;
    intentFields.add(field);
    if (intent.parameter === 'model') {
      return valueTransition(
        '模型',
        intent.oldValue ?? current.model,
        intent.newValue,
      );
    }
    if (intent.parameter === 'numTopics') {
      return valueTransition(
        '主题数',
        intent.oldValue ?? current.numTopics,
        intent.newValue,
      );
    }
    if (intent.parameter === 'iterations') {
      return valueTransition(
        '迭代次数',
        intent.oldValue ?? current.iterations,
        intent.newValue,
      );
    }
    if (intent.parameter === 'seed') {
      return valueTransition(
        '主运行种子',
        intent.oldValue ?? current.seed,
        intent.newValue,
      );
    }
    return `协变量：${stringValues(intent.newValue).join('、')}`;
  });
  for (const [field, value] of Object.entries(adjustment)) {
    if (intentFields.has(field) || field === 'topicCountMode') continue;
    summaries.push(
      field === 'experimentProtocol'
        ? experimentProtocolAdjustmentLabel(asRecord(value) ?? {})
        : `${planFieldLabel(field)}=${String(value)}`,
    );
  }
  return [...new Set(summaries)].join('；');
};

const valueTransition = (
  label: string,
  oldValue: unknown,
  newValue: unknown,
): string =>
  oldValue === undefined || oldValue === null
    ? `${label}：设为 ${String(newValue)}`
    : `${label}：${String(oldValue)} → ${String(newValue)}`;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const stringValues = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const planFieldLabel = (field: string): string =>
  ({
    modelId: '模型',
    numTopics: '主题数',
    maxTopics: '最大主题数',
    topicCountMode: '主题数模式',
    epochs: '迭代次数',
    batchSize: '批大小',
    covariateColumns: '协变量',
    mode: '训练模式',
    experimentProtocol: '实验设计',
  })[field] ?? field;

const experimentProtocolAdjustmentLabel = (
  protocol: Record<string, unknown>,
): string => {
  const mode = String(protocol.mode ?? 'quick');
  const primarySeeds = Array.isArray(protocol.primarySeeds)
    ? protocol.primarySeeds.join('、')
    : '42';
  const baseline = typeof protocol.baselineModelId === 'string'
    ? `，对照 ${protocol.baselineModelId.toUpperCase()}（${Array.isArray(protocol.baselineSeeds) ? protocol.baselineSeeds.join('、') : '42'}）`
    : '';
  return `实验设计=${mode}，主模型种子 ${primarySeeds}${baseline}`;
};

const researchFieldLabel = (field: string): string =>
  ({
    researchQuestion: '研究问题',
    researchDomain: '研究领域',
    domainConfirmed: '领域方向',
    dataSources: '数据来源',
    collectionMethod: '数据产生方式',
    analysisUnit: '分析单位',
    timeRange: '时间范围',
    language: '数据语言',
    comparisonGroups: '比较对象',
    comparisonIntent: '比较需求',
    topicGranularity: '主题粒度',
    knownBiases: '已知偏差',
    sensitiveData: '敏感数据情况',
    successCriteria: '成功标准',
    hardwareLimit: '本地硬件条件',
    textFieldIntent: '正文含义',
    trendAnalysis: '时间趋势要求',
    offlineOnly: '离线要求',
    requestedEmbedding: '嵌入方式',
    timeLimitHours: '可用训练时间',
    interviewComplete: '研究访谈状态',
  })[field] ?? '研究设置';

const unresolvedResearchClarification = (
  field: string,
  answer: string,
  fallbackQuestion: string,
): string => {
  const delegated = /(?:按|按照).{0,8}(?:你的|系统的|建议).{0,8}(?:想法|判断|决定|标准)|你.{0,6}(?:判断|决定)|都可以|随便/u.test(
    answer,
  );
  if (field === 'successCriteria') {
    return delegated
      ? '成功标准需要由你最终确认。我建议采用：主题清晰可解释；每个主题提供关键词和代表文本；结果能够回答研究目标。你可以直接发送这段标准，或按需要修改。'
      : '我还不能把这句话作为可验证的成功标准。请至少说明你希望结果具备什么，例如：主题清晰可解释；每个主题提供关键词和代表文本；结果能够回答研究目标。';
  }
  if (field === 'comparisonGroups') {
    return '请明确要比较的来源、群体或时间阶段；如果不需要比较，可以直接回答“本次不做分组比较”。';
  }
  if (field === 'textFieldIntent') {
    return '请说明每条记录中真正需要分析的文本类型，例如商品评论、客服对话、新闻正文或日常词汇。只写内容类型即可。';
  }
  if (field === 'domainConfirmed') {
    return '我已经根据本地样本给出了一个初步领域判断。你只需回答“是”，或用“不是，更接近……”告诉我更合适的方向；如果确实不确定，我会先采用预判结果继续。';
  }
  if (/^(?:不知道|不清楚|不确定|无法判断|不了解)[。.]?$/u.test(answer.trim())) {
    return explainResearchQuestion(
      { field, question: fallbackQuestion } as InformationGap,
      { question: fallbackQuestion } as PlannedQuestion,
    );
  }
  return `我还不能安全地把这句话写入研究档案。${fallbackQuestion}`;
};

const uncertainAnswer = /^(?:不知道|不清楚|不确定|无法判断|不了解|你来判断|按你的判断)[。.]?$/u;

export const inferableUncertaintyAnswer = (
  field: string,
  answer: string,
  profile:
    | Pick<
        DatasetProfile,
        'rowCount' | 'columnCandidates' | 'languageDistribution' | 'inferredDomain'
      >
    | undefined,
): string | undefined => {
  if (!uncertainAnswer.test(answer.trim())) return undefined;
  const primaryText = profile?.columnCandidates.text[0]?.name;
  switch (field.split(',')[0] ?? field) {
    case 'domainConfirmed':
      return profile?.inferredDomain
        ? '是，这个领域判断可以作为当前分析的初步方向。'
        : undefined;
    case 'analysisUnit':
      return profile ? '每一行是一条独立文本记录。' : undefined;
    case 'textFieldIntent':
      return primaryText
        ? `分析 ${primaryText} 列中的主要文本内容。`
        : undefined;
    case 'language':
      return profile?.languageDistribution[0]?.language
        ? `数据语言为 ${profile.languageDistribution[0].language}。`
        : undefined;
    case 'successCriteria':
      return '主题清晰可解释，每个主题提供关键词和代表文本，并能够回答研究目标。';
    default:
      return undefined;
  }
};

const asksHowToAnswer = (text: string): boolean =>
  /你想要什么答案|(?:我|这个问题).{0,8}(?:怎么|如何|该怎样).{0,6}(?:回答|说明)|为什么要问|什么意思|要确认什么|需要我提供什么/u.test(
    text.trim(),
  );

const explainResearchQuestion = (
  gap: Pick<InformationGap, 'field' | 'question'>,
  question: Pick<PlannedQuestion, 'question'>,
): string => {
  const field = gap.field.split(',')[0] ?? gap.field;
  const guidance: Readonly<Record<string, string>> = {
    domainConfirmed: '我想先确认数据所属的大方向，以便后续使用贴近领域的词汇。回答“是”即可接受预判；不准确时直接说“不是，更接近……”。',
    sensitiveData: '我只需要确认数据里是否有个人信息、机密或敏感内容。回答“有”或“没有”即可；这会决定能否使用外部语言服务。',
    analysisUnit: '我想知道一行数据代表一条评论、一篇文章，还是其他对象。若你不确定，我会按本地结构预判继续。',
    textFieldIntent: '我想确认真正需要分析的文本内容是哪一列、属于什么类型；如果结构足够明确，我会使用正文候选列继续。',
    researchQuestion: '请用一句话说明你最终希望从数据中得到什么，例如识别主题、比较群体或观察时间变化。',
    comparisonGroups: '如果要比较不同来源、群体或时间阶段，请告诉我比较对象；不需要时直接说“不做分组比较”。',
    successCriteria: '请说明什么结果算成功；也可以让我采用“主题清晰、提供关键词和代表文本、能回答研究目标”的默认标准。',
  };
  return `${guidance[field] ?? '我只需要你补充当前无法从数据结构可靠判断的业务含义。'} 当前需要确认的是：${question.question}`;
};

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const errorRecord = (error: unknown): Record<string, string> => ({
  name: error instanceof Error ? error.name : 'Error',
  message: error instanceof Error ? error.message : String(error),
});

const safeGrounding = (
  toolId: string | null,
  value: unknown,
): {
  facts: Record<string, unknown>;
  evidence: Array<{ evidenceId: string; excerpt: string }>;
} => {
  const record = asRecord(value);
  if (toolId === 'theta.status.read') {
    return {
      facts: {
        runId: record.runId,
        status: record.status,
        currentState: record.currentState,
        pendingActionRef: record.pendingActionRef,
        pendingReason: record.pendingReason,
      },
      evidence: [],
    };
  }
  if (toolId === 'theta.evidence.read') {
    const orchestration = Array.isArray(record.orchestrationEvents)
      ? record.orchestrationEvents
      : [];
    const tools = Array.isArray(record.toolEvents) ? record.toolEvents : [];
    return {
      facts: {
        orchestrationEventCount: orchestration.length,
        toolEventCount: tools.length,
        recentEventTypes: orchestration
          .slice(-5)
          .map((event) => asRecord(event).type)
          .filter((item) => typeof item === 'string'),
      },
      evidence: [],
    };
  }
  if (toolId === 'theta.rag.search') {
    const evidence = Array.isArray(record.evidence)
      ? record.evidence.slice(0, 5).map((item) => {
          const entry = asRecord(item);
          return {
            evidenceId:
              typeof entry.evidenceId === 'string'
                ? entry.evidenceId
                : 'unknown-evidence',
            excerpt:
              typeof entry.excerpt === 'string'
                ? entry.excerpt
                : 'No excerpt available.',
          };
        })
      : [];
    return {
      facts: {
        query: record.query,
        noEvidence: record.noEvidence,
        evidenceCount: evidence.length,
      },
      evidence,
    };
  }
  if (toolId === 'theta.model.catalog') {
    const models = Array.isArray(record.models)
      ? record.models.slice(0, 30).map((item) => {
          const model = asRecord(item);
          return {
            id: model.id,
            name: model.name,
            type: model.type,
            runnable: model.runnable,
          };
        })
      : [];
    return { facts: { models }, evidence: [] };
  }
  return { facts: record, evidence: [] };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
