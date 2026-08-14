import { useMemo, useState } from 'react'
import type { WebAgentInteraction, WebReasoning, WebReasoningToolCall } from '../api/client.ts'
import { JsonTree, StateDot, ThetaMark } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import css from '../styles/app.module.css'

interface AgentActivityTraceProps {
  interaction?: WebAgentInteraction
  reasoning?: WebReasoning
  workspaceActivity?: { proposal?: unknown; steps?: unknown; result?: unknown; evidenceRefs?: unknown }
  working?: boolean
  currentProgress?: { phase: 'thinking' | 'tool'; label: string; step: number; toolId?: string }
}

interface ToolActivity {
  key: string
  toolId: string
  calls: WebReasoningToolCall[]
  latest: WebReasoningToolCall
  firstTimestamp: string
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const toolKind = (toolId: string): 'search' | 'visual' | 'tool' => {
  if (/search|rag|retriev/i.test(toolId)) return 'search'
  if (/plot|chart|visual|image|result/i.test(toolId)) return 'visual'
  return 'tool'
}

const toolTitle = (toolId: string, locale: string): string => {
  const known: Record<string, [string, string]> = {
    'theta.rag.search': ['检索研究知识库', 'Search research knowledge'],
    'theta.model.catalog': ['读取模型目录', 'Read model catalog'],
    'theta.model.recommend': ['生成模型建议', 'Recommend a model'],
    'theta.dataset.inspect': ['理解数据集', 'Inspect the dataset'],
    'theta.plan.propose': ['拟定研究计划', 'Propose a research plan'],
    'theta.training.start': ['启动受治理训练', 'Start governed training'],
  }
  const label = known[toolId]
  if (label) return locale === 'zh-CN' ? label[0] : label[1]
  if (toolKind(toolId) === 'search') return locale === 'zh-CN' ? '执行检索' : 'Search'
  if (toolKind(toolId) === 'visual') return locale === 'zh-CN' ? '生成研究产物' : 'Create research artifact'
  return locale === 'zh-CN' ? '调用工具' : 'Run tool'
}

const activityState = (phase: WebReasoningToolCall['phase']): 'error' | 'done' | 'ongoing' =>
  phase === 'failed' ? 'error' : phase === 'completed' || phase === 'validated' ? 'done' : 'ongoing'

const phaseTitle = (phase: WebReasoningToolCall['phase'], locale: string): string => {
  const labels: Record<WebReasoningToolCall['phase'], [string, string]> = {
    requested: ['请求执行工具', 'Tool requested'],
    started: ['开始执行工具', 'Tool started'],
    policy: ['权限策略校验通过', 'Policy check passed'],
    completed: ['工具执行完成', 'Tool completed'],
    failed: ['工具执行失败', 'Tool failed'],
    validated: ['输出契约校验通过', 'Output contract validated'],
  }
  return locale === 'zh-CN' ? labels[phase][0] : labels[phase][1]
}

const reasoningTitle = (type: string, fallback: string, locale: string): string => {
  const labels: Record<string, [string, string]> = {
    'thinking.started': ['开始分析请求', 'Started analyzing the request'],
    'thinking.completed': ['请求分析完成', 'Request analysis completed'],
    'agent.deliberation.started': ['开始规划下一步', 'Started planning the next step'],
    'agent.deliberation.completed': ['下一步规划完成', 'Next-step planning completed'],
    'agent.reasoning.started': ['开始生成决策摘要', 'Started producing a decision summary'],
    'agent.reasoning.completed': ['决策摘要已生成', 'Decision summary completed'],
    'reasoning.decision.recorded': ['已记录推理决策', 'Reasoning decision recorded'],
    'agent.action.selected': ['已选择下一步动作', 'Next action selected'],
    'inference.requested': ['请求模型推理', 'Model inference requested'],
    'inference.completed': ['模型推理完成', 'Model inference completed'],
    'inference.failed': ['模型推理失败', 'Model inference failed'],
    'model.call.completed': ['模型调用完成', 'Model call completed'],
    'human.review.requested': ['请求人工确认', 'Human review requested'],
    'human.review.approved': ['人工确认通过', 'Human review approved'],
    'human.review.rejected': ['人工确认拒绝', 'Human review rejected'],
    'human.review.resolved': ['人工确认已处理', 'Human review resolved'],
  }
  const label = labels[type]
  return label ? (locale === 'zh-CN' ? label[0] : label[1]) : fallback
}

const resultSummary = (activity: ToolActivity, locale: string): string => {
  const payloads = activity.calls.map((call) => record(call.payload))
  const query = payloads.map((payload) => payload.query).find((value) => typeof value === 'string')
  const evidenceCount = payloads
    .map((payload) => payload.evidenceCount ?? (Array.isArray(payload.evidence) ? payload.evidence.length : undefined))
    .find((value) => typeof value === 'number')
  if (toolKind(activity.toolId) === 'search') {
    if (typeof evidenceCount === 'number') {
      return locale === 'zh-CN' ? `找到 ${evidenceCount} 条证据` : `Found ${evidenceCount} evidence items`
    }
    if (typeof query === 'string') return query
  }
  const phases = activity.calls.length
  return locale === 'zh-CN' ? `${phases} 个可审计阶段` : `${phases} auditable stages`
}

export const AgentActivityTrace = ({
  interaction,
  reasoning,
  workspaceActivity,
  working = false,
  currentProgress,
}: AgentActivityTraceProps): React.ReactElement | null => {
  const { locale } = usePreferences()
  const [expanded, setExpanded] = useState<string>()
  const toolActivities = useMemo(() => {
    const grouped = new Map<string, WebReasoningToolCall[]>()
    for (const call of reasoning?.toolCalls.slice(-80) ?? []) {
      const key = call.invocationId ?? call.toolId
      grouped.set(key, [...(grouped.get(key) ?? []), call])
    }
    return [...grouped.entries()].map(([key, calls]): ToolActivity => ({
      key,
      toolId: calls[0]?.toolId ?? 'unknown-tool',
      calls,
      latest: calls.at(-1) as WebReasoningToolCall,
      firstTimestamp: calls[0]?.timestamp ?? '',
    })).slice(-6)
  }, [reasoning?.toolCalls])
  const reasoningEvents = reasoning?.reasoningEvents.slice(-8) ?? []
  const hasWorkspaceActivity = workspaceActivity?.proposal != null || workspaceActivity?.result != null
  if (!working && !interaction && toolActivities.length === 0 && reasoningEvents.length === 0 && !hasWorkspaceActivity) return null

  return (
    <div className={css.activityTrace} aria-label={locale === 'zh-CN' ? 'Agent 活动' : 'Agent activity'}>
      {working && (
        <div className={css.activityWorking}>
          <div className={`${css.messageAvatar} ${css.activityAvatar}`} aria-hidden="true">
            <ThetaMark size={17} />
          </div>
          <span className={css.activitySpinner} />
          <span className={css.activityToolText}>
            <strong>{currentProgress?.phase === 'tool' ? (locale === 'zh-CN' ? 'Tool · 正在调用工具' : 'Tool · Running') : 'Thinking'}</strong>
            <small>{currentProgress?.label ?? (locale === 'zh-CN' ? '正在分析请求并选择下一步能力' : 'Analyzing the request and selecting the next capability')}</small>
          </span>
        </div>
      )}
      {reasoningEvents.length > 0 && (
        <details className={css.activityDisclosure}>
          <summary>
            <StateDot size={7} state="done" />
            <span>{locale === 'zh-CN' ? `推理摘要 · ${reasoningEvents.length} 个事件` : `Reasoning summary · ${reasoningEvents.length} events`}</span>
          </summary>
          <div className={css.activityStages}>
            {reasoningEvents.map((event) => (
              <div key={event.id} className={css.activityStage}>
                <StateDot size={6} state={event.type.endsWith('.failed') ? 'error' : 'done'} />
                <span>{reasoningTitle(event.type, event.title, locale)}</span>
                {event.detail && <small>{event.detail}</small>}
              </div>
            ))}
            <p className={css.activitySafetyNote}>
              {locale === 'zh-CN' ? '这里展示可审计的决策摘要，不包含模型的隐藏思维链。' : 'This is an auditable decision summary, not hidden model chain-of-thought.'}
            </p>
          </div>
        </details>
      )}
      {interaction != null && (
        <details className={css.activityDisclosure}>
          <summary>
            <StateDot size={7} state={interaction.card ? 'warning' : 'done'} />
            <span>{locale === 'zh-CN' ? `FSM 决策 · ${interaction.state}` : `FSM decision · ${interaction.state}`}</span>
          </summary>
          <div className={css.activityDetail}>
            <p>{interaction.reasoning.observation}</p>
            <p>{interaction.reasoning.decision}</p>
            <code>{interaction.reasoning.allowedTools.join(' · ') || 'no tools allowed'}</code>
          </div>
        </details>
      )}
      {hasWorkspaceActivity && (
        <details className={css.activityDisclosure}>
          <summary>
            <StateDot size={7} state="done" />
            <span>{locale === 'zh-CN' ? '语义意图判断完成' : 'Semantic intent decision completed'}</span>
          </summary>
          <div className={css.activityPayload}><JsonTree data={workspaceActivity as object} copyable={false} /></div>
        </details>
      )}
      {toolActivities.map((activity) => {
        const key = activity.key
        const kind = toolKind(activity.toolId)
        return (
          <div key={key} className={css.activityDisclosure}>
            <button type="button" onClick={() => setExpanded((current) => current === key ? undefined : key)}>
              <StateDot size={7} state={activityState(activity.latest.phase)} />
              <span className={css.activityToolIcon} aria-hidden="true">{kind === 'search' ? '⌕' : kind === 'visual' ? '◇' : '⌁'}</span>
              <span className={css.activityToolText}>
                <strong>{toolTitle(activity.toolId, locale)}</strong>
                <small><code>{activity.toolId}</code> · {resultSummary(activity, locale)}</small>
              </span>
              <span className={css.activityPhase}>{locale === 'zh-CN' ? phaseTitle(activity.latest.phase, locale).replace('工具', '') : activity.latest.phase}</span>
              <span>›</span>
            </button>
            {expanded === key && (
              <div className={css.activityStages}>
                {activity.calls.map((call) => (
                  <details key={call.eventId} className={css.activityStageDisclosure}>
                    <summary>
                      <StateDot size={6} state={activityState(call.phase)} />
                      <span>{phaseTitle(call.phase, locale)}</span>
                      <time>{new Date(call.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                    </summary>
                    {call.payload != null && <div className={css.activityPayload}><JsonTree data={call.payload as object} copyable={false} /></div>}
                  </details>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
