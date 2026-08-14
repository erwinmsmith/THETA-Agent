import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { WebAgentInteraction, WebMessage, WebReasoning, WebRunStatus } from '../api/client.ts'
import { Button, StateDot } from '../ui/index.ts'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { DatasetIntakeCard } from './DatasetIntakeCard.tsx'
import { FsmReasoningTrace } from './FsmReasoningTrace.tsx'
import css from '../styles/app.module.css'

const MarkdownText = lazy(async () => {
  const module = await import('../ui/markdown/MarkdownText.tsx')
  return { default: module.MarkdownText }
})

const HUMAN_KINDS: ReadonlySet<string> = new Set([
  'research.initial-direction',
  'dataset.confirmation',
  'dataset.correction',
  'research.decision-answer',
  'research.intent-confirmation',
  'conversation.text',
])

interface ConversationPaneProps {
  messages: WebMessage[]
  sending: boolean
  onSend: (text: string) => void
  onCreate: () => void
  onCreated: (runId: string) => void
  entryInteraction?: WebAgentInteraction
  reasoning?: WebReasoning
  runId?: string
  status?: WebRunStatus
  onApproved?: () => void
}

const messageTime = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

export const ConversationPane = ({
  messages,
  sending,
  onSend,
  onCreate,
  onCreated,
  entryInteraction,
  reasoning,
  runId,
  status,
  onApproved,
}: ConversationPaneProps): React.ReactElement => {
  const [draft, setDraft] = useState('')
  const threadRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const followTail = useRef(true)

  useEffect(() => {
    if (followTail.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, sending, status?.pendingActionRef])

  useEffect(() => {
    setDraft('')
    followTail.current = true
  }, [runId])

  const submit = (): void => {
    const text = draft.trim()
    if (!text || sending || !runId) return
    setDraft('')
    if (textareaRef.current != null) textareaRef.current.style.height = 'auto'
    followTail.current = true
    onSend(text)
  }

  if (runId == null) {
    if (entryInteraction == null) {
      return <div className={css.catalogLoading}><span /><strong>正在读取 FSM 入口状态</strong></div>
    }
    return (
      <div className={css.intakeWorkspace}>
        <div className={css.intakeIntro}>
          <span className={css.eyebrow}>AUTONOMOUS TOPIC RESEARCH</span>
          <h1>数据进入之后，<br />让 Agent 决定下一步。</h1>
          <p>卡片来自 FSM 状态，不由按钮关键词触发。每次 Tool 选择都会被状态 allowlist 和 Hypha 策略再次约束。</p>
          <Button variant="ghost" onClick={onCreate}>在弹窗中创建</Button>
        </div>
        <div className={css.intakeFlow}>
          <FsmReasoningTrace interaction={entryInteraction} />
          <DatasetIntakeCard interaction={entryInteraction} onCreated={onCreated} />
        </div>
      </div>
    )
  }

  return (
    <div className={css.conversation}>
      <div className={css.conversationHeader}>
        <div>
          <span className={css.eyebrow}>AGENT THREAD</span>
          <strong>{status?.presentation?.title ?? '正在连接研究任务…'}</strong>
        </div>
        <div className={css.agentState}>
          <StateDot
            size={8}
            state={status?.status === 'failed' ? 'error' : status?.status === 'waiting_human' ? 'warning' : 'ongoing'}
          />
          {status?.status === 'waiting_human' ? '等待确认' : status?.status === 'completed' ? '已完成' : status?.currentState ?? '正在同步'}
        </div>
      </div>

      <div
        ref={threadRef}
        className={css.thread}
        aria-live="polite"
        onScroll={() => {
          const element = threadRef.current
          if (element == null) return
          followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
        }}
      >
        {messages.length === 0 && (
          <div className={css.loadingThread}>
            <span />
            <p>正在载入 Agent 对话与运行上下文…</p>
          </div>
        )}
        {messages.map((message) => {
          const human = HUMAN_KINDS.has(message.messageKind) || message.role === 'user'
          return (
            <article
              key={message.messageId}
              className={`${css.message} ${human ? css.messageUser : css.messageAssistant}`}
            >
              {!human && <div className={css.messageAvatar}>θ</div>}
              <div className={css.messageBody}>
                <div className={css.messageMeta}>
                  <strong>{human ? '你' : 'THETA Agent'}</strong>
                  <span>{message.messageKind}</span>
                  <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
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
        {sending && (
          <div className={`${css.message} ${css.messageAssistant}`}>
            <div className={css.messageAvatar}>θ</div>
            <div className={css.thinking}><span /><span /><span /> Agent 正在思考与编排工具</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {status?.interaction != null && onApproved != null && (
        <div className={css.approvalDock}>
          <FsmReasoningTrace interaction={status.interaction} events={reasoning?.reasoningEvents} />
          <ApprovalPanel
            runId={runId}
            interaction={status.interaction}
            reasoning={reasoning}
            onApproved={onApproved}
          />
        </div>
      )}

      <div className={css.composerWrap}>
        <div className={css.composer}>
          <textarea
            ref={textareaRef}
            id="theta-composer"
            className={css.composerInput}
            rows={1}
            aria-label="给 THETA Agent 发送消息"
            placeholder="询问研究状态，修正数据理解，或描述你希望分析的问题…"
            value={draft}
            disabled={sending}
            onChange={(event) => {
              setDraft(event.target.value)
              event.target.style.height = 'auto'
              event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <Button variant="primary" className={css.sendButton} disabled={sending || draft.trim().length === 0} onClick={submit}>
            {sending ? '处理中' : '发送'}
          </Button>
        </div>
        <div className={css.composerHint}>
          <span>Enter 发送 · Shift + Enter 换行</span>
          <span>所有工具调用遵循 Hypha 治理策略</span>
        </div>
      </div>
    </div>
  )
}
