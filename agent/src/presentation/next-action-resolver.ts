import type { HumanNextAction } from './contracts.js';

const action = (
  id: string,
  label: string,
  description: string,
  command?: string,
  recommended = false,
  destructive = false,
): HumanNextAction => ({
  id,
  label,
  description,
  ...(command ? { command } : {}),
  ...(recommended ? { recommended } : {}),
  ...(destructive ? { destructive } : {}),
});

export const resolveNextActions = (
  state: unknown,
  status?: unknown,
  hasActiveRun = true,
): HumanNextAction[] => {
  if (!hasActiveRun) {
    return [
      action(
        'start',
        '创建分析任务',
        '选择一个本地数据文件，开始研究设置。',
        '/start <数据文件>',
        true,
      ),
      action('runs', '查看本地任务', '查看并连接已有的持久化任务。', '/runs'),
      action('help', '查看可用命令', '显示当前可用的交互命令。', '/help'),
    ];
  }
  if (status === 'failed') {
    return [
      action('why', '查看失败原因', '查看错误原因和建议的修复方式。', '/why', true),
      action('retry', '修复后重试', '创建新的恢复 Run，并保留已经确认的研究信息。', '/retry'),
      action('status', '查看技术状态', '查看当前失败阶段和持久化状态。', '/status'),
    ];
  }
  const current = typeof state === 'string' ? state : '';
  switch (current) {
    case 'ResearchClarification':
      return [
        action(
          'answer',
          '回答当前问题',
          '直接输入自然语言即可；系统会更新研究档案并继续追问。',
          undefined,
          true,
        ),
        action('brief', '查看研究档案', '查看已经理解的信息和仍缺少的内容。', '/brief'),
        action('done', '结束扩展访谈', '必填信息完成后可要求开始分析。', '/done'),
      ];
    case 'ColumnConfirmation':
      return [
        action(
          'columns',
          '确认列角色',
          '分别说明正文、时间、ID、训练协变量和展示分组；系统不会在这些角色间自动转换。',
          '/columns <自然语言说明>',
          true,
        ),
        action('status', '查看数据状态', '查看当前数据检查结果。', '/status'),
      ];
    case 'AwaitDatasetUnderstandingConfirmation':
      return [
        action('confirm-dataset', '确认数据理解', '确认数据量、领域、分析单位和全部列角色。', undefined, true),
        action('correct-dataset', '自然语言修正', '直接说明领域或任一列角色的错误。'),
        action('status', '查看识别详情', '查看数据事实、识别来源和脱敏样本回执。', '/status'),
      ];
    case 'ResearchIntentInterview':
      return [
        action('answer', '回答当前问题', '用一段自然语言回答；可一次补充多个研究要求。', undefined, true),
        action('done', '采用建议并继续', '对仍未明确的非阻断项采用系统建议。', '/done'),
        action('status', '查看研究意图', '查看已提取的目标、比较维度和约束。', '/status'),
      ];
    case 'AwaitResearchIntentConfirmation':
      return [
        action('approve', '确认研究意图', '确认摘要无误并开始生成方案。', '/approve', true),
        action('answer', '自然语言修改', '直接说明需要修改的字段，例如“时间只用于画趋势”。'),
        action('status', '重新查看摘要', '查看规范化后的完整研究意图。', '/status'),
      ];
    case 'AwaitPlanCreationApproval':
      return [
        action('plan', '查看完整方案', '查看模型、参数、数据列、资源和风险。', '/plan', true),
        action(
          'approve-plan',
          '批准训练方案',
          '固化正式计划；本操作不会启动训练。',
          '/approve-plan',
        ),
        action('adjust', '调整方案', '用自然语言修改主题数、迭代次数或模型。', '/adjust <修改内容>'),
      ];
    case 'AwaitTrainingStartApproval':
      return [
        action(
          'start-training',
          '启动真实训练',
          '确认 dry-run 后启动本地 Python 进程并写入结果。',
          '/start-training',
          true,
        ),
        action('plan', '再次查看方案', '检查最终模型、参数和输出位置。', '/plan'),
        action('why', '查看检查说明', '了解为什么当前可以启动训练。', '/why'),
      ];
    case 'MonitorTraining':
    case 'StartTraining':
      return [
        action('follow', '继续跟踪训练', '自动轮询直到完成、失败或主动退出。', '/follow', true),
        action('logs', '查看最近日志', '只显示最近的关键训练日志。', '/logs'),
        action('cancel', '取消训练', '请求停止真实训练，需要显式确认。', '/cancel', false, true),
      ];
    case 'Completed':
      return [
        action('results', '查看训练结果', '显示指标、主题表和所有产物路径。', '/results', true),
        action('open-results', '打开结果目录', '在本机文件管理器中打开当前 Run 的结果。', '/open-results'),
        action('summary', '解释结果', '根据真实指标和主题表生成受事实约束的摘要。', '/summary'),
        action('reevaluate', '重新评估质量', '不重新训练，按当前落盘产物再次执行质量门。', '/reevaluate'),
      ];
    case 'Failed':
      return [
        action('why', '查看失败原因', '查看错误原因和建议的修复方式。', '/why', true),
        action('logs', '查看错误日志', '查看训练进程最近的日志。', '/logs'),
        action('retry', '修复后重试', '创建新的受治理重试，不隐式覆盖失败 Run。', '/retry'),
      ];
    case 'Quarantined':
      return [
        action('why', '查看隔离原因', '了解为什么该运行不能自动恢复。', '/why', true),
        action('evidence', '查看运行证据', '检查持久化事件与训练收据。', '/evidence'),
      ];
    case 'Cancelled':
      return [
        action('results', '查看已有产物', '查看取消前已经生成的文件。', '/results'),
        action('retry', '创建新训练', '基于当前方案创建新的训练尝试。', '/retry'),
      ];
    default:
      if (status === 'waiting_timer') {
        return [
          action('follow', '继续跟踪', '自动等待持久化计时器并刷新状态。', '/follow', true),
          action('status', '查看状态', '只读取当前状态，不推进工作流。', '/status'),
        ];
      }
      return [
        action('status', '查看当前状态', '查看任务进行到了哪一步。', '/status', true),
        action('help', '查看可用命令', '显示当前可用的交互命令。', '/help'),
      ];
  }
};
