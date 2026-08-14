import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type {
  WebAgentInteraction,
  WebAttachment,
  WebMessage,
  WebReasoning,
  WebRunStatus,
} from '../api/client.ts'
import { Button, JsonTree, StateDot, ThetaMark } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import { AgentActivityTrace } from './AgentActivityTrace.tsx'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { DatasetIntakeCard } from './DatasetIntakeCard.tsx'
import { InferenceSelector } from './InferenceSelector.tsx'
import css from '../styles/app.module.css'

const MarkdownText = lazy(async () => {
  const module = await import('../ui/markdown/MarkdownText.tsx')
  return { default: module.MarkdownText }
})

const HUMAN_KINDS: ReadonlySet<string> = new Set([
  'research.initial-direction', 'dataset.confirmation', 'dataset.correction',
  'research.decision-answer', 'research.intent-confirmation', 'conversation.text',
  'result.analysis.question', 'human.review.rejected',
])

export interface QueuedChatMessage { id: string; text: string; attachments: WebAttachment[] }

interface ConversationPaneProps {
  messages: WebMessage[]
  sending: boolean
  queued: QueuedChatMessage[]
  onSend: (text: string, attachments: WebAttachment[]) => void
  onCreated: (runId: string) => void
  workspaceSessionId?: string
  entryInteraction?: WebAgentInteraction
  workspaceActivity?: { proposal?: unknown; result?: unknown; evidenceRefs?: unknown }
  reasoning?: WebReasoning
  runId?: string
  status?: WebRunStatus
  onApproved?: () => void
  attachments: WebAttachment[]
  onAttachmentsChange: (attachments: WebAttachment[]) => void
}

const messageTime = (value: string, locale: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
}

const artifactActivity = (message: WebMessage): WebAttachment[] | undefined => {
  if (message.messageKind !== 'activity.artifacts.viewed') return undefined
  try {
    const value = JSON.parse(message.content) as { attachments?: WebAttachment[] }
    return Array.isArray(value.attachments) ? value.attachments : []
  } catch {
    return []
  }
}

interface StoredToolActivity {
  toolId: string
  phases: Array<{ id: string; type: string; timestamp: string }>
  result?: unknown
}

const storedToolActivity = (message: WebMessage): StoredToolActivity | undefined => {
  if (message.messageKind !== 'activity.tool.trace') return undefined
  try {
    const value = JSON.parse(message.content) as StoredToolActivity
    return typeof value.toolId === 'string' && Array.isArray(value.phases) ? value : undefined
  } catch {
    return undefined
  }
}

const storedPhaseTitle = (type: string, locale: string): string => {
  const labels: Record<string, [string, string]> = {
    'tool.call.requested': ['请求执行工具', 'Tool requested'],
    'tool.policy.checked': ['权限策略校验通过', 'Policy check passed'],
    'tool.call.started': ['开始执行工具', 'Tool started'],
    'tool.output.validated': ['输出契约校验通过', 'Output contract validated'],
    'tool.call.completed': ['工具执行完成', 'Tool completed'],
    'tool.call.failed': ['工具执行失败', 'Tool failed'],
  }
  const label = labels[type]
  return label ? (locale === 'zh-CN' ? label[0] : label[1]) : type
}

export const ConversationPane = ({
  messages,
  sending,
  queued,
  onSend,
  onCreated,
  workspaceSessionId,
  entryInteraction,
  workspaceActivity,
  reasoning,
  runId,
  status,
  onApproved,
  attachments,
  onAttachmentsChange,
}: ConversationPaneProps): React.ReactElement => {
  const { locale, t } = usePreferences()
  const [draft, setDraft] = useState('')
  const threadRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const followTail = useRef(true)
  const activeInteraction = runId ? status?.interaction : entryInteraction

  useEffect(() => {
    if (followTail.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, sending, queued.length, status?.pendingActionRef])

  useEffect(() => {
    setDraft('')
    followTail.current = true
  }, [runId, workspaceSessionId])

  const submitText = (value = draft): void => {
    const text = value.trim()
    if (!text) return
    setDraft('')
    if (textareaRef.current != null) textareaRef.current.style.height = 'auto'
    followTail.current = true
    onSend(text, attachments)
    onAttachmentsChange([])
  }

  const dropAttachment = (event: React.DragEvent): void => {
    event.preventDefault()
    const encoded = event.dataTransfer.getData('application/x-theta-artifact')
    if (!encoded) return
    try {
      const attachment = JSON.parse(encoded) as WebAttachment
      if (!attachment.id || !attachment.label) return
      onAttachmentsChange([...attachments.filter((item) => item.id !== attachment.id), attachment].slice(-12))
      textareaRef.current?.focus()
    } catch {
      // Ignore unrelated drag payloads.
    }
  }

  const showStarter = runId == null && messages.length === 0 && !sending
  const latestUserGoal = [...messages].reverse().find((message) => message.role === 'user')?.content
  const suggestions = [t('howStart'), t('capabilities'), t('modelAdvice'), t('analyzeData')]

  return (
    <div className={css.conversation}>
      {runId != null && (
        <div className={css.conversationHeader}>
          <div>
            <strong>{status?.presentation?.title ?? (locale === 'zh-CN' ? '正在连接研究任务…' : 'Connecting to research…')}</strong>
          </div>
          <div className={css.agentState}>
            <StateDot size={8} state={status?.status === 'failed' ? 'error' : status?.status === 'waiting_human' ? 'warning' : 'ongoing'} />
            {status?.status === 'waiting_human' ? (locale === 'zh-CN' ? '等待确认' : 'Needs review') : status?.status === 'completed' ? (locale === 'zh-CN' ? '已完成' : 'Completed') : status?.currentState ?? (locale === 'zh-CN' ? '正在同步' : 'Syncing')}
          </div>
        </div>
      )}

      <div
        ref={threadRef}
        className={`${css.thread} ${showStarter ? css.startThread : ''}`}
        aria-live="polite"
        onScroll={() => {
          const element = threadRef.current
          if (element == null) return
          followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
        }}
      >
        {showStarter && (
          <div className={css.startSurface}>
            <div className={css.startMark}><ThetaMark size={42} /></div>
            <h1>{t('welcome')}</h1>
            <p>{locale === 'zh-CN' ? '从问题开始。Agent 会判断是否需要数据、选择工具，并在关键步骤等待你确认。' : 'Start with a question. The Agent decides when data or tools are needed and pauses at governed review points.'}</p>
            <div className={css.promptGrid}>
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => submitText(suggestion)}>{suggestion}<span>↗</span></button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => {
          const viewedArtifacts = artifactActivity(message)
          if (viewedArtifacts) {
            const visualizations = viewedArtifacts.filter((item) => item.kind === 'visualization').length
            return (
              <div key={message.messageId} className={css.artifactActivity}>
                <span>◇</span>
                <strong>{locale === 'zh-CN'
                  ? `已查看 ${viewedArtifacts.length} 个研究产物${visualizations > 0 ? `（${visualizations} 个可视化）` : ''}`
                  : `Viewed ${viewedArtifacts.length} research artifact${viewedArtifacts.length === 1 ? '' : 's'}${visualizations > 0 ? ` (${visualizations} visualization${visualizations === 1 ? '' : 's'})` : ''}`}</strong>
                <small>{viewedArtifacts.map((item) => item.label).join(' · ')}</small>
              </div>
            )
          }
          const toolActivity = storedToolActivity(message)
          if (toolActivity) {
            const search = /search|rag|retriev/i.test(toolActivity.toolId)
            const failed = toolActivity.phases.some((phase) => phase.type === 'tool.call.failed')
            return (
              <div key={message.messageId} className={css.activityTrace}>
                <details className={css.activityDisclosure}>
                  <summary>
                    <StateDot size={7} state={failed ? 'error' : 'done'} />
                    <span className={css.activityToolIcon} aria-hidden="true">{search ? '⌕' : '⌁'}</span>
                    <span className={css.activityToolText}>
                      <strong>{search ? (locale === 'zh-CN' ? '已检索研究知识库' : 'Searched research knowledge') : (locale === 'zh-CN' ? '工具调用已完成' : 'Tool call completed')}</strong>
                      <small><code>{toolActivity.toolId}</code> · {toolActivity.phases.length} {locale === 'zh-CN' ? '个可审计阶段' : 'auditable stages'}</small>
                    </span>
                    <span>›</span>
                  </summary>
                  <div className={css.activityStages}>
                    {toolActivity.phases.map((phase) => (
                      <div key={phase.id} className={css.activityStage}>
                        <StateDot size={6} state={phase.type === 'tool.call.failed' ? 'error' : 'done'} />
                        <span>{storedPhaseTitle(phase.type, locale)}</span>
                        <time>{new Date(phase.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                      </div>
                    ))}
                    {toolActivity.result != null && <div className={css.activityPayload}><JsonTree data={toolActivity.result as object} copyable={false} /></div>}
                  </div>
                </details>
              </div>
            )
          }
          const human = HUMAN_KINDS.has(message.messageKind) || message.role === 'user'
          return (
            <article key={message.messageId} className={`${css.message} ${human ? css.messageUser : css.messageAssistant}`}>
              {!human && <div className={css.messageAvatar}><ThetaMark size={17} /></div>}
              <div className={css.messageBody}>
                <div className={css.messageMeta}>
                  <strong>{human ? t('you') : t('agent')}</strong>
                  <time dateTime={message.createdAt}>{messageTime(message.createdAt, locale)}</time>
                </div>
                <div className={`${css.bubble} ${human ? css.bubbleUser : css.bubbleAssistant}`}>
                  <Suspense fallback={<div className={css.markdownFallback}>{message.content}</div>}>
                    <MarkdownText text={message.content} />
                  </Suspense>
                </div>
              </div>
            </article>
          )
        })}

        {(messages.length > 0 || runId != null) && (
          <AgentActivityTrace
            interaction={activeInteraction}
            reasoning={reasoning}
            workspaceActivity={workspaceActivity}
            working={sending}
          />
        )}
        {queued.map((item, index) => (
          <div key={item.id} className={css.queuedMessage}>
            <span>{t('queued')} {index + 1}</span>
            <p>{item.text}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {activeInteraction?.card?.kind === 'dataset_upload' && (
        <div className={css.approvalDock}>
          <DatasetIntakeCard
            interaction={activeInteraction}
            sourceSessionId={workspaceSessionId}
            initialGoal={latestUserGoal}
            onCreated={onCreated}
          />
        </div>
      )}

      {runId != null && status?.interaction != null && onApproved != null && (
        <div className={css.approvalDock}>
          <ApprovalPanel runId={runId} interaction={status.interaction} reasoning={reasoning} onApproved={onApproved} />
        </div>
      )}

      <div className={`${css.composerWrap} ${showStarter ? css.startComposerWrap : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={dropAttachment}>
        <div className={css.composer}>
          {attachments.length > 0 && (
            <div className={css.composerAttachments}>
              {attachments.map((attachment) => (
                <button key={`${attachment.kind}-${attachment.id}`} type="button" onClick={() => onAttachmentsChange(attachments.filter((item) => item !== attachment))}>
                  <span>{attachment.kind === 'visualization' ? '◇' : '≡'}</span>{attachment.label}<b>×</b>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            id="theta-composer"
            className={css.composerInput}
            rows={1}
            aria-label={locale === 'zh-CN' ? '给 THETA Agent 发送消息' : 'Message THETA Agent'}
            placeholder={t('placeholder')}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              event.target.style.height = 'auto'
              event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitText() }
            }}
          />
          <div className={css.composerBar}>
            <span className={css.addButton} title={locale === 'zh-CN' ? '由 Agent 判断何时需要数据' : 'The Agent requests data when needed'}>+</span>
            <InferenceSelector />
            <Button variant="primary" className={css.sendButton} disabled={draft.trim().length === 0} onClick={() => submitText()}>
              {sending ? t('queued') : t('send')}
            </Button>
          </div>
        </div>
        <div className={css.composerHint}>
          <span>Enter · Shift + Enter</span>
          <span>{locale === 'zh-CN' ? '消息可在 Agent 处理时继续排队' : 'Messages queue while the Agent is working'}</span>
        </div>
      </div>
    </div>
  )
}
