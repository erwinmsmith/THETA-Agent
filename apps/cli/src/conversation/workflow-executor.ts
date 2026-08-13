import path from 'node:path';
import type { FrameworkEvent } from '@hypha/core';
import { THETA_APPROVAL_KEYS } from '../theta-domain.js';
import {
  ThetaWorkflowService,
  type ThetaWorkflowEvidence,
  type ThetaWorkflowRunResult,
  type ThetaWorkflowStatus,
} from '../theta-workflow-service.js';
import type { ConversationCommand } from './contracts.js';
import {
  commandNeedsActiveRun,
  noActiveRunResult,
} from './no-active-run.js';

export interface ConversationExecutionContext {
  activeRunId?: string;
  runtimeDb?: string;
  plannerConsent?: boolean;
}

export interface ConversationExecutionResult {
  value: unknown;
  activeRunId?: string;
}

export class ThetaConversationWorkflowExecutor {
  constructor(private readonly workflow = new ThetaWorkflowService()) {}

  async execute(
    command: ConversationCommand,
    context: ConversationExecutionContext,
  ): Promise<ConversationExecutionResult> {
    if (command.kind === 'start') {
      const result = await this.workflow.run({
        input: {
          filePath: path.resolve(process.cwd(), command.filePath),
          plannerMode: context.plannerConsent ? 'minimax' : 'deterministic',
        },
        ...(context.runtimeDb ? { runtimeDb: context.runtimeDb } : {}),
      });
      return withRun(result);
    }
    if (commandNeedsActiveRun(command, context.activeRunId)) {
      return { value: noActiveRunResult(command.kind) };
    }
    if (command.kind === 'status') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return withRun(
        await this.workflow.status(runId, context.runtimeDb),
      );
    }
    if (command.kind === 'why') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      const status = await this.workflow.status(runId, context.runtimeDb);
      const evidence = await this.workflow.evidence(runId, context.runtimeDb);
      let plan: Record<string, unknown> | undefined;
      try {
        plan = record(await this.workflow.plan(runId, context.runtimeDb));
      } catch {
        // Status explanations are still available before a plan exists.
      }
      return {
        value: explain(status, evidence, plan, command.section),
        activeRunId: runId,
      };
    }
    if (command.kind === 'evidence') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return {
        value: await this.workflow.evidence(runId, context.runtimeDb),
        activeRunId: runId,
      };
    }
    if (command.kind === 'plan') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return {
        value: {
          kind: 'plan.review',
          ...(await this.workflow.plan(runId, context.runtimeDb)),
        },
        activeRunId: runId,
      };
    }
    if (
      command.kind === 'approve' ||
      command.kind === 'approvePlan' ||
      command.kind === 'startTraining'
    ) {
      const runId = resolveRunId(command.runId, context.activeRunId);
      const status = await this.workflow.status(runId, context.runtimeDb);
      if (
        command.kind === 'approvePlan' &&
        status.pendingActionRef !== THETA_APPROVAL_KEYS.planReview
      ) {
        throw new Error('当前不是训练方案审批阶段。请先使用 /status 查看当前步骤。');
      }
      if (
        command.kind === 'startTraining' &&
        status.pendingActionRef !== THETA_APPROVAL_KEYS.trainingReview
      ) {
        throw new Error('当前不是训练启动审批阶段。请先使用 /status 查看当前步骤。');
      }
      if (command.kind === 'approvePlan') {
        const plan = await this.workflow.plan(runId, context.runtimeDb);
        const recommendation = record(plan.recommendation);
        const degradation = record(recommendation.degradation);
        const priorAdjustment = record(plan.planAdjustment);
        const candidate =
          record(plan.validatedPlan) ?? record(plan.candidatePlan);
        const selectedModel = stringField(candidate, 'modelId')?.toLowerCase();
        const compatibleModels = Array.isArray(recommendation.recommendations)
          ? recommendation.recommendations
              .map(record)
              .map((item) => stringField(item, 'modelId')?.toLowerCase())
              .filter((modelId): modelId is string => Boolean(modelId))
          : [];
        if (
          selectedModel &&
          compatibleModels.length > 0 &&
          !compatibleModels.includes(selectedModel)
        ) {
          return {
            value: {
              kind: 'plan.approval.blocked',
              response: `当前候选模型 ${selectedModel.toUpperCase()} 不属于本次可审批集合。请先选择 ${compatibleModels
                .map((modelId) => modelId.toUpperCase())
                .join('、')} 之一并应用设置。`,
            },
            activeRunId: runId,
          };
        }
        const requiresDegradation = degradation.required === true;
        const accepted =
          command.acceptDegradation || priorAdjustment.acceptDegradation === true;
        if (requiresDegradation && !accepted) {
          const unmet = strings(degradation.unmetRequirements).join('、');
          throw new Error(
            `当前方案不能满足全部研究目标（${unmet || '能力缺口'}）。请先调整模型，或使用 /approve-plan --accept-degradation 明确接受降级。`,
          );
        }
        if (requiresDegradation && command.acceptDegradation) {
          await this.workflow.resume({
            runId,
            ...(context.runtimeDb ? { runtimeDb: context.runtimeDb } : {}),
            planAdjustment: { acceptDegradation: true },
            approvedBy: 'local_user',
          });
        }
      }
      const result = await this.workflow.resume({
        runId,
        ...(context.runtimeDb ? { runtimeDb: context.runtimeDb } : {}),
        approve: true,
        approvedBy: 'local_user',
      });
      return withRun(result);
    }
    if (command.kind === 'save') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return {
        value: {
          kind: 'replay.fixture',
          destination: 'terminal',
          replay: await this.workflow.replay(runId, context.runtimeDb),
        },
        activeRunId: runId,
      };
    }
    if (command.kind === 'next') {
      const runId = resolveRunId(undefined, context.activeRunId);
      return withRun(await this.workflow.status(runId, context.runtimeDb));
    }
    throw new Error(`Command ${command.kind} is handled by the REPL shell.`);
  }
}

const withRun = (
  result: ThetaWorkflowRunResult | ThetaWorkflowStatus,
): ConversationExecutionResult => ({
  value: result,
  activeRunId: result.runId,
});

const resolveRunId = (
  requested: string | undefined,
  active: string | undefined,
): string => {
  const runId = requested ?? active;
  if (!runId) {
    throw new Error('No active Run. Pass a runId or use /start <dataset>.');
  }
  return runId;
};

const explain = (
  status: ThetaWorkflowStatus,
  evidence: ThetaWorkflowEvidence,
  plan: Record<string, unknown> | undefined,
  section: 'all' | 'model' | 'parameters' | 'protocol' | 'evidence',
): Record<string, unknown> => {
  const failed = latestEvent(evidence.orchestrationEvents, 'run.failed');
  const failedPayload = record(failed?.payload);
  const workflowFailure = record(failedPayload.error);
  const policy = latestEvent(evidence.toolEvents, 'tool.policy.checked');
  const receipt = record(status.trainingReceipt);
  const trainingFailure = record(receipt.failure);
  const reasonCode =
    stringField(trainingFailure, 'code') ??
    stringField(workflowFailure, 'code') ??
    stringField(failed?.payload, 'reasonCode') ??
    stringField(failed?.payload, 'code') ??
    (status.pendingActionRef
      ? 'HUMAN_ACTION_REQUIRED'
      : status.status === 'completed'
        ? 'RUN_COMPLETED'
        : status.status === 'waiting_timer'
          ? 'TIMER_WAIT_ACTIVE'
          : status.status === 'failed'
            ? 'RUN_FAILED'
            : 'RUN_ACTIVE');
  const rawReason =
    stringField(trainingFailure, 'summary') ??
    status.pendingReason ??
    stringField(workflowFailure, 'message') ??
    stringField(failed?.payload, 'message') ??
    stringField(failed?.payload, 'reason');
  const explanationSections = explainPlanDecision(plan, section);
  return {
    kind: 'run.explanation',
    runId: status.runId,
    status: status.status,
    currentState: status.currentState ?? null,
    reasonCode,
    reason: humanReason(status, rawReason),
    ...(rawReason && humanReason(status, rawReason) !== rawReason
      ? { rawReason }
      : {}),
    pendingActionRef: status.pendingActionRef ?? null,
    stage:
      stringField(trainingFailure, 'stage') ??
      stringField(workflowFailure, 'stateId') ??
      stringField(receipt, 'currentStep') ??
      null,
    technicalDetail:
      stringField(trainingFailure, 'technicalDetail') ?? null,
    suggestedCommands: strings(trainingFailure.suggestedCommands),
    partialArtifactsAvailable:
      trainingFailure.partialArtifactsAvailable === true,
    logPath: stringField(receipt, 'logPath') ?? null,
    guard: policy?.payload ?? null,
    evidenceRefs: [
      ...evidence.orchestrationEvents.slice(-3).map((event) => event.id),
      ...evidence.toolEvents.slice(-3).map((event) => event.id),
    ],
    explanationSection: section,
    explanationSections,
  };
};

const explainPlanDecision = (
  plan: Record<string, unknown> | undefined,
  requested: 'all' | 'model' | 'parameters' | 'protocol' | 'evidence',
): Array<{ title: string; lines: string[] }> => {
  if (!plan) return [];
  const recommendation = record(plan.recommendation);
  const ranked = Array.isArray(recommendation.recommendations)
    ? recommendation.recommendations.map(record)
    : [];
  const proposalEnvelope = record(plan.planProposal);
  const proposal = record(proposalEnvelope.draft);
  const primary = record(proposal.primary);
  const selected =
    ranked.find((item) => item.modelId === primary.modelId) ?? ranked[0] ?? {};
  const sections: Array<{ key: string; title: string; lines: string[] }> = [];
  sections.push({
    key: 'model',
    title: '为什么选择这个模型',
    lines: [
      `主模型：${String(primary.modelId ?? selected.modelId ?? '尚未确定')}`,
      ...(typeof primary.choice === 'string' ? [primary.choice] : []),
      `成熟度：${String(selected.maturity ?? 'production')}`,
      ...stringList(selected.reasonCodes).map((item) => `推荐依据：${item}`),
      ...ranked.slice(1, 4).map(
        (item) =>
          `未作为主模型：${String(item.modelId)}（评分 ${String(item.score)}；${stringList(item.warnings).join('、') || '匹配度低于主方案'}）`,
      ),
    ],
  });
  sections.push({
    key: 'parameters',
    title: '为什么使用这些参数',
    lines: Array.isArray(primary.parameterCandidates)
      ? primary.parameterCandidates.map(record).map(
          (item) =>
            `${String(item.field)}=${String(item.value)}：${String(item.rationale ?? '采用能力表约束后的候选值')}；证据 ${stringList(item.evidenceRefs).join('、') || '不足，使用确定性默认值'}`,
        )
      : ['当前没有 MiniMax 参数覆盖，使用 Capability Registry 与确定性推荐器的值。'],
  });
  const protocol = record(proposal.experimentProtocol);
  sections.push({
    key: 'protocol',
    title: '为什么这样安排实验',
    lines: [
      `模式：${String(protocol.mode ?? 'quick')}`,
      `主模型随机种子：${numberList(protocol.primarySeeds).join('、') || '42'}`,
      `基线：${String(protocol.baselineModelId ?? '无')}`,
      String(protocol.rationale ?? '没有批准额外实验成本，先进行单次快速运行。'),
    ],
  });
  const evidenceBundle = record(plan.evidenceBundle);
  const evidenceItems = Array.isArray(evidenceBundle.evidence)
    ? evidenceBundle.evidence.map(record)
    : [];
  const receipts = Array.isArray(proposalEnvelope.evidenceSelectionReceipts)
    ? proposalEnvelope.evidenceSelectionReceipts.map(record)
    : [];
  sections.push({
    key: 'evidence',
    title: '证据如何绑定和校验',
    lines: [
      ...evidenceItems.slice(0, 8).map(
        (item) =>
          `${String(item.evidenceId)}：${String(item.title ?? item.sourceId)}（${String(item.authority ?? '未知权威')}）`,
      ),
      ...receipts.map(
        (item) =>
          `绑定回执 ${String(item.receiptId)}：${String(item.outcome)}，${Array.isArray(item.bindings) ? item.bindings.length : 0} 个决策目标。`,
      ),
    ],
  });
  return sections
    .filter((item) => requested === 'all' || item.key === requested)
    .map(({ title, lines }) => ({ title, lines }));
};

const latestEvent = (
  events: readonly FrameworkEvent[],
  type: string,
): FrameworkEvent | undefined =>
  [...events].reverse().find((event) => event.type === type);

const stringField = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
};
const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const numberList = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];

const humanReason = (
  status: ThetaWorkflowStatus,
  rawReason: string | undefined,
): string => {
  const byAction: Readonly<Record<string, string>> = {
    'theta.research.clarify': '研究档案还有待确认的信息；回答当前问题后，系统会继续下一项。',
    'theta.columns.confirm': '需要确认正文、时间、ID、训练元数据、展示分组和评估标签列。',
    'theta.plan.review': '候选方案已通过硬约束检查，正在等待你确认并固化训练计划。',
    'theta.training.review': '数据准备和 dry-run 已通过，真实训练仍需第二次明确批准。',
  };
  if (status.pendingActionRef && byAction[status.pendingActionRef]) {
    return byAction[status.pendingActionRef]!;
  }
  if (status.status === 'waiting_timer') return '训练正在后台运行，系统会按持久化计时器继续读取真实进度。';
  if (status.status === 'completed') return '训练执行已经结束；仍需结合质量门和研究目标验收结果。';
  if (rawReason && /[\u3400-\u9fff]/u.test(rawReason)) return rawReason;
  if (status.status === 'failed') return '当前任务执行失败；请查看下面的发生阶段、技术详情和建议处理。';
  return '任务正在按持久化工作流推进。';
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
