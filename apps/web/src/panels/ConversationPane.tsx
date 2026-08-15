import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WebAgentInteraction,
  WebAttachment,
  WebMessage,
  WebReasoning,
  WebRunStatus,
  WebTokenUsage,
} from '../api/client.ts'
import { uploadDataset } from '../api/client.ts'
import { Button, JsonTree, StateDot, ThetaMark } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import { useInferenceSettings } from '../inference-settings.tsx'
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
  processingMessageId?: string
  onPrioritize: (id: string) => void
  onSend: (text: string, attachments: WebAttachment[]) => void
  onCreated: (runId: string) => void
  workspaceSessionId?: string
  entryInteraction?: WebAgentInteraction
  workspaceActivity?: { proposal?: unknown; semanticDecision?: unknown; steps?: unknown; result?: unknown; evidenceRefs?: unknown }
  reasoning?: WebReasoning
  runId?: string
  status?: WebRunStatus
  onApproved?: () => void
  attachments: WebAttachment[]
  onAttachmentsChange: (attachments: WebAttachment[]) => void
  liveAssistantMessageId?: string
  tokenUsage: WebTokenUsage
}

const formatTokenCount = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
      : String(value)

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

interface StoredAgentProgress {
  phase: 'thinking' | 'tool'
  label: string
  status: 'ongoing'
  step: number
  toolId?: string
}

const agentProgress = (message: WebMessage): StoredAgentProgress | undefined => {
  if (message.messageKind !== 'activity.agent.progress') return undefined
  try {
    const value = JSON.parse(message.content) as Partial<StoredAgentProgress>
    if ((value.phase !== 'thinking' && value.phase !== 'tool') || typeof value.label !== 'string') return undefined
    return {
      phase: value.phase,
      label: value.label,
      status: 'ongoing',
      step: typeof value.step === 'number' ? value.step : 1,
      ...(typeof value.toolId === 'string' ? { toolId: value.toolId } : {}),
    }
  } catch {
    return undefined
  }
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

const orderCompletedActivityAfterReply = (messages: WebMessage[]): WebMessage[] => {
  const ordered: WebMessage[] = []
  let pendingToolActivity: WebMessage[] = []
  for (const message of messages) {
    if (message.messageKind === 'activity.tool.trace') {
      pendingToolActivity.push(message)
      continue
    }
    if (message.role === 'user' && pendingToolActivity.length > 0) {
      ordered.push(...pendingToolActivity)
      pendingToolActivity = []
    }
    ordered.push(message)
    if (
      message.role === 'assistant' &&
      !message.messageKind.startsWith('activity.') &&
      pendingToolActivity.length > 0
    ) {
      ordered.push(...pendingToolActivity)
      pendingToolActivity = []
    }
  }
  return [...ordered, ...pendingToolActivity]
}

export const ConversationPane = ({
  messages,
  sending,
  queued,
  processingMessageId,
  onPrioritize,
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
  liveAssistantMessageId,
  tokenUsage,
}: ConversationPaneProps): React.ReactElement => {
  const { locale, t } = usePreferences()
  const { settings } = useInferenceSettings()
  const [draft, setDraft] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string>()
  const [draggingFiles, setDraggingFiles] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const followTail = useRef(true)
  const activeInteraction = runId ? status?.interaction : entryInteraction

  useEffect(() => {
    if (!followTail.current) return
    const frame = window.requestAnimationFrame(() => {
      const thread = threadRef.current
      if (thread == null) return
      thread.scrollTo({
        top: thread.scrollHeight,
        behavior: sending ? 'smooth' : 'auto',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages.length, sending, queued.length, status?.pendingActionRef, reasoning?.toolCalls.length, reasoning?.reasoningEvents.length])

  useEffect(() => {
    setDraft('')
    followTail.current = true
  }, [runId, workspaceSessionId])

  useEffect(() => {
    const thread = threadRef.current
    if (thread == null) return
    let frame: number | undefined
    const scrollTail = (): void => {
      if (!followTail.current) return
      window.cancelAnimationFrame(frame ?? 0)
      frame = window.requestAnimationFrame(() => {
        thread.scrollTop = thread.scrollHeight
      })
    }
    const resizeObserver = new ResizeObserver(scrollTail)
    const observeChildren = (): void => {
      for (const child of thread.children) resizeObserver.observe(child)
    }
    const mutationObserver = new MutationObserver(() => {
      observeChildren()
      scrollTail()
    })
    observeChildren()
    mutationObserver.observe(thread, { childList: true, subtree: true })
    return () => {
      window.cancelAnimationFrame(frame ?? 0)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [])

  const submitText = (value = draft): void => {
    const text = value.trim()
    if (!text) return
    setDraft('')
    if (textareaRef.current != null) textareaRef.current.style.height = 'auto'
    followTail.current = true
    onSend(text, attachments)
    onAttachmentsChange([])
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    if (files.length === 0 || uploading) return
    setUploading(true)
    setUploadError(undefined)
    try {
      const uploaded: WebAttachment[] = []
      for (const file of Array.from(files)) {
        const dataset = await uploadDataset(file)
        uploaded.push({ kind: 'dataset', id: dataset.datasetRef, label: file.name })
      }
      onAttachmentsChange([...attachments, ...uploaded].filter((item, index, all) => all.findIndex((entry) => entry.id === item.id) === index).slice(-12))
      textareaRef.current?.focus()
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setUploading(false)
    }
  }

  const dropAttachment = (event: React.DragEvent): void => {
    event.preventDefault()
    setDraggingFiles(false)
    const encoded = event.dataTransfer.getData('application/x-theta-artifact')
    if (!encoded && event.dataTransfer.files.length > 0) {
      void addFiles(event.dataTransfer.files)
      return
    }
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
  const currentProgress = [...messages].reverse().map(agentProgress).find(Boolean)
  const orderedMessages = useMemo(() => orderCompletedActivityAfterReply(messages), [messages])

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

        {orderedMessages.map((message) => {
          if (message.messageKind === 'activity.agent.progress') return null
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
              <div key={message.messageId} className={`${css.activityTrace} ${css.activityTraceCompleted}`}>
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
                    <TypewriterMarkdown
                      text={message.content}
                      active={message.messageId === liveAssistantMessageId && settings?.llm.typewriter === true}
                      speedMs={settings?.llm.typewriterSpeedMs ?? 18}
                    />
                  </Suspense>
                </div>
              </div>
            </article>
          )
        })}

        {(sending || runId != null) && (
          <AgentActivityTrace
            interaction={activeInteraction}
            reasoning={reasoning}
            workspaceActivity={workspaceActivity}
            working={sending}
            currentProgress={currentProgress}
          />
        )}
        <div ref={bottomRef} />
      </div>

      {!showStarter && activeInteraction?.card?.kind === 'dataset_upload' && (
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

      <div
        className={`${css.composerWrap} ${showStarter ? css.startComposerWrap : ''} ${draggingFiles ? css.composerWrapDragging : ''}`}
        onDragEnter={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDraggingFiles(true) }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false) }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropAttachment}
      >
        {queued.length > 0 && (
          <div className={css.queueDock} aria-label={locale === 'zh-CN' ? '消息队列' : 'Message queue'}>
            {queued.map((item, index) => {
              const processing = item.id === processingMessageId
              return (
                <div key={item.id} className={`${css.queueItem} ${processing ? css.queueItemActive : ''}`}>
                  {processing ? <span className={css.activitySpinner} /> : <span className={css.queueIndex}>{index}</span>}
                  <span>{processing ? (locale === 'zh-CN' ? '正在执行' : 'Running') : (locale === 'zh-CN' ? '已排队' : 'Queued')}</span>
                  <p>{item.text}</p>
                  {!processing && index > 1 && <button type="button" onClick={() => onPrioritize(item.id)}>{locale === 'zh-CN' ? '插队' : 'Prioritize'}</button>}
                </div>
              )
            })}
          </div>
        )}
        <div className={css.composer}>
          <input
            ref={fileInputRef}
            className={css.visuallyHidden}
            type="file"
            multiple
            accept=".csv,.tsv,.txt,.json,.jsonl,.xlsx,.xls,.parquet,.zip"
            onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }}
          />
          {attachments.length > 0 && (
            <div className={css.composerAttachments}>
              {attachments.map((attachment) => (
                <button key={`${attachment.kind}-${attachment.id}`} type="button" onClick={() => onAttachmentsChange(attachments.filter((item) => item !== attachment))}>
                  <span>{attachment.kind === 'visualization' ? '◇' : attachment.kind === 'dataset' ? '⌁' : '≡'}</span>{attachment.label}<b>×</b>
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
            <button className={css.addButton} type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()} title={locale === 'zh-CN' ? '选择文件或将文件拖到输入框' : 'Choose files or drop them onto the composer'}>{uploading ? '…' : '+'}</button>
            <InferenceSelector />
            <Button variant="primary" className={css.sendButton} disabled={draft.trim().length === 0} onClick={() => submitText()}>
              {sending ? t('queued') : t('send')}
            </Button>
          </div>
        </div>
        {uploadError && <div className={css.composerUploadError} role="alert">{uploadError}</div>}
        <div className={css.composerHint}>
          <span>Enter · Shift + Enter</span>
          <div className={css.composerMeta}>
            <span
              className={css.tokenUsage}
              title={locale === 'zh-CN' ? '当前对话的累计语言模型 Token 用量' : 'Cumulative language-model token usage for this conversation'}
            >
              <b>Input</b> {formatTokenCount(tokenUsage.inputTokens)}
              <i aria-hidden="true">·</i>
              <b>Output</b> {formatTokenCount(tokenUsage.outputTokens)}
            </span>
            <span className={css.queueHint}>{locale === 'zh-CN' ? '消息可在 Agent 处理时继续排队' : 'Messages queue while the Agent is working'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const TypewriterMarkdown = ({ text, active, speedMs }: { text: string; active: boolean; speedMs: number }): React.ReactElement => {
  const [visible, setVisible] = useState(active ? 0 : Number.POSITIVE_INFINITY)
  const characters = Array.from(text)

  useEffect(() => {
    if (!active || window.matchMedia('(prefers-reduced-motion: reduce)').matches || speedMs === 0) {
      setVisible(Number.POSITIVE_INFINITY)
      return
    }
    setVisible(0)
    const chunkSize = Math.max(1, Math.ceil(24 / Math.max(speedMs, 1)))
    const timer = window.setInterval(() => {
      setVisible((current) => {
        const next = current + chunkSize
        if (next >= characters.length) window.clearInterval(timer)
        return next
      })
    }, Math.max(8, speedMs))
    return () => window.clearInterval(timer)
  }, [active, speedMs, text, characters.length])

  const complete = visible >= characters.length
  return (
    <span className={!complete ? css.typewriterLive : undefined}>
      <MarkdownText text={complete ? text : characters.slice(0, visible).join('')} />
    </span>
  )
}
