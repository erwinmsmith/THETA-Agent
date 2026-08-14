import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { WebMessage, WebRunStatus } from '../api/client.ts'
import { Button, FishLogo, StateDot } from '../ui/index.ts'
import { ApprovalPanel } from './ApprovalPanel.tsx'
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
    return (
      <div className={css.welcome}>
        <div className={css.welcomeMark}><FishLogo size={54} /></div>
        <span className={css.eyebrow}>AUTONOMOUS TOPIC RESEARCH</span>
        <h1>把原始文本变成<br />可解释的研究结论。</h1>
        <p>上传数据集，THETA Agent 会检查数据、澄清研究意图、选择主题模型，并在每个关键决策前等待你的确认。</p>
        <Button variant="primary" onClick={onCreate}>开始新的研究</Button>
        <div className={css.capabilityGrid}>
          <div><span>01</span><strong>理解数据</strong><small>自动识别正文、时间与分组字段</small></div>
          <div><span>02</span><strong>制定方案</strong><small>比较 LDA、STM、DTM、BERTopic 等模型</small></div>
          <div><span>03</span><strong>受控执行</strong><small>审批、工具轨迹和结果都可追溯</small></div>
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

      {status != null && onApproved != null && (
        <div className={css.approvalDock}>
          <ApprovalPanel runId={runId} status={status} onApproved={onApproved} />
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
