export interface StateLabel {
  title: string;
  explanation: string;
  step: number;
}

export const WORKFLOW_TOTAL_STEPS = 7;

export const stateLabelsZhCN: Readonly<Record<string, StateLabel>> = {
  Intake: {
    title: '读取研究任务',
    explanation: '正在建立本次分析的研究档案。',
    step: 1,
  },
  ResearchClarification: {
    title: '完善研究设置',
    explanation: '需要通过对话了解数据背景、研究目标和分析要求。',
    step: 1,
  },
  InspectDataset: {
    title: '检查数据集',
    explanation: '正在读取数据结构并识别可用列，不会把原始数据发送给语言模型。',
    step: 2,
  },
  AnalyzeDataset: {
    title: '理解数据内容',
    explanation: '正在通过受限的数据查看工具分析列结构和最多十条脱敏样本。',
    step: 2,
  },
  AwaitDatasetUnderstandingConfirmation: {
    title: '确认数据理解',
    explanation: '请确认数据规模、领域方向、分析单位和列角色；有误可直接用自然语言修正。',
    step: 2,
  },
  ResearchIntentInterview: {
    title: '明确研究意图',
    explanation: '正在围绕已确认的数据内容补齐会影响模型和评价方案的研究决策。',
    step: 3,
  },
  AwaitResearchIntentConfirmation: {
    title: '确认研究意图',
    explanation: '请核对研究问题、比较用途、时间用途、交付内容和约束；确认后才会生成方案。',
    step: 3,
  },
  ColumnConfirmation: {
    title: '确认数据列',
    explanation: '请确认正文、时间、ID 和元数据列，系统不会替你做业务语义决定。',
    step: 2,
  },
  RecommendModel: {
    title: '生成模型建议',
    explanation: '正在根据研究目标、数据规模和本地资源筛选模型。',
    step: 3,
  },
  ValidatePlan: {
    title: '验证训练方案',
    explanation: '正在检查模型、参数、数据列和资源约束是否一致。',
    step: 4,
  },
  AwaitPlanCreationApproval: {
    title: '审批 1/2：确认训练方案',
    explanation: '候选方案已通过验证。批准后会固化正式计划，但不会启动训练。',
    step: 4,
  },
  CreatePlan: {
    title: '创建正式计划',
    explanation: '正在把方案绑定到数据哈希、列确认和审批记录。',
    step: 4,
  },
  DryRun: {
    title: '训练前检查',
    explanation: '正在检查 Python、命令、输出路径和预期产物，不会启动训练。',
    step: 5,
  },
  AwaitTrainingStartApproval: {
    title: '审批 2/2：启动真实训练',
    explanation: '训练前检查已通过。批准后会启动本地 Python 训练进程并写入结果。',
    step: 5,
  },
  StartTraining: {
    title: '启动训练',
    explanation: '正在启动受治理的本地训练进程。',
    step: 6,
  },
  MonitorTraining: {
    title: '模型训练中',
    explanation: '训练正在后台运行，退出跟踪不会取消训练。',
    step: 6,
  },
  Completed: {
    title: '训练完成',
    explanation: '训练和产物验证已经完成。',
    step: 7,
  },
  Failed: {
    title: '运行失败',
    explanation: '工作流遇到错误，请先查看原因和恢复建议。',
    step: 7,
  },
  Cancelled: {
    title: '训练已取消',
    explanation: '训练已按用户请求停止。',
    step: 7,
  },
  Quarantined: {
    title: '运行需要人工处理',
    explanation: '运行状态无法安全恢复，已被隔离以避免错误重启。',
    step: 7,
  },
};

export const stateLabel = (state: unknown): StateLabel => {
  const key = typeof state === 'string' ? state : '';
  return (
    stateLabelsZhCN[key] ?? {
      title: '处理任务',
      explanation: 'THETA 正在处理当前步骤。',
      step: 1,
    }
  );
};
