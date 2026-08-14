import {
  THETA_APPROVAL_KEYS,
  THETA_WORKFLOW_STATES,
  resolveThetaWorkflowStateDefinition,
  resolveThetaWorkflowTransitionTargets,
} from '@theta-agent/domain/domain.js';

export type ThetaAgentCardKind =
  | 'dataset_upload'
  | 'research_question'
  | 'dataset_review'
  | 'column_review'
  | 'research_intent_review'
  | 'plan_review'
  | 'training_review';

export interface ThetaAgentActionCard {
  kind: ThetaAgentCardKind;
  title: string;
  description: string;
  actionRef: string;
  requiresHumanAction: true;
}

export interface ThetaAgentInteraction {
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
  card?: ThetaAgentActionCard;
}

const cardByActionRef: Readonly<Record<string, Omit<ThetaAgentActionCard, 'actionRef'>>> = {
  [THETA_APPROVAL_KEYS.researchClarification]: {
    kind: 'research_question',
    title: '补充研究信息',
    description: '回答当前决策问题后，FSM 会重新评估信息缺口。',
    requiresHumanAction: true,
  },
  [THETA_APPROVAL_KEYS.datasetUnderstanding]: {
    kind: 'dataset_review',
    title: '确认数据理解',
    description: '核对领域、分析单位与每个数据列的角色。',
    requiresHumanAction: true,
  },
  [THETA_APPROVAL_KEYS.columnConfirmation]: {
    kind: 'column_review',
    title: '确认数据列',
    description: '确认正文、时间、ID、协变量和展示分组。',
    requiresHumanAction: true,
  },
  [THETA_APPROVAL_KEYS.researchIntent]: {
    kind: 'research_question',
    title: '完善研究意图',
    description: '回答当前规划问题，FSM 会决定是否继续追问。',
    requiresHumanAction: true,
  },
  [THETA_APPROVAL_KEYS.researchIntentReview]: {
    kind: 'research_intent_review',
    title: '确认研究意图',
    description: '确认规范化研究意图后才会进入模型规划。',
    requiresHumanAction: true,
  },
  [THETA_APPROVAL_KEYS.planReview]: {
    kind: 'plan_review',
    title: '确认训练方案',
    description: '审查模型、参数、资源、证据与风险；批准不会启动训练。',
    requiresHumanAction: true,
  },
  [THETA_APPROVAL_KEYS.trainingReview]: {
    kind: 'training_review',
    title: '确认启动训练',
    description: '核对 dry-run、设备、写入位置和计划哈希后启动训练。',
    requiresHumanAction: true,
  },
};

export const buildThetaWorkspaceInteraction = (): ThetaAgentInteraction => ({
  source: 'fsm',
  state: THETA_WORKFLOW_STATES.intake,
  status: 'waiting_human',
  reasoning: {
    goal: 'Receive a registered dataset and a bounded research direction.',
    observation: 'No active research Run exists in the workspace.',
    decision: 'Request a dataset before creating the governed FSM Run.',
    nextStates: resolveThetaWorkflowTransitionTargets(THETA_WORKFLOW_STATES.intake),
    allowedTools: [],
    policyRefs: [],
  },
  card: {
    kind: 'dataset_upload',
    title: '上传研究数据',
    description: '数据注册完成后，Agent 才会创建 Run 并进入 FSM 推理。',
    actionRef: 'theta.dataset.register',
    requiresHumanAction: true,
  },
});

export const buildThetaAgentInteraction = (value: unknown): ThetaAgentInteraction => {
  const status = record(value);
  const state = text(status.currentState) ?? THETA_WORKFLOW_STATES.intake;
  const runStatus = text(status.status) ?? 'running';
  const pendingActionRef = text(status.pendingActionRef);
  const definition = resolveThetaWorkflowStateDefinition(state);
  const cardTemplate = pendingActionRef ? cardByActionRef[pendingActionRef] : undefined;
  const nextStates = resolveThetaWorkflowTransitionTargets(state);
  return {
    source: 'fsm',
    state,
    status: runStatus,
    reasoning: {
      goal: definition?.goal ?? 'Evaluate the current governed research state.',
      observation: text(status.pendingReason) ?? `Run status is ${runStatus}.`,
      decision: pendingActionRef
        ? `Pause for the structured human action ${pendingActionRef}.`
        : nextStates.length > 0
          ? 'Continue only through a transition declared by the FSM.'
          : 'Remain in the current terminal state.',
      nextStates,
      allowedTools: [...(definition?.allowedTools ?? [])],
      policyRefs: [...(definition?.policyRefs ?? [])],
    },
    ...(cardTemplate && pendingActionRef
      ? { card: { ...cardTemplate, actionRef: pendingActionRef } }
      : {}),
  };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
