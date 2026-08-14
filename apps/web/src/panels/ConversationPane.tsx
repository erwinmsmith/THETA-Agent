import { useRef, useState } from 'react'
import type { WebMessage, WebRunStatus } from '../api/client.ts'
import { Button, Input, MarkdownText } from '../ui/index.ts'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import css from '../styles/app.module.css'

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
  runId?: string
  status?: WebRunStatus
  onApproved?: () => void
}

export const ConversationPane = ({
  messages,
  sending,
  onSend,
  runId,
  status,
  onApproved,
}: ConversationPaneProps): React.ReactElement => {
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const submit = (): void => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    onSend(text)
  }

  return (
    <div className={css.center}>
      <div className={css.thread}>
        {messages.length === 0 && <div className={css.empty}>还没有对话内容</div>}
        {messages.map((message) => (
          <div
            key={message.messageId}
            className={`${css.message} ${
              HUMAN_KINDS.has(message.messageKind) || message.role === 'user'
                ? css.messageUser
                : css.messageAssistant
            }`}
          >
            <div
              className={`${css.bubble} ${
                HUMAN_KINDS.has(message.messageKind) || message.role === 'user'
                  ? css.bubbleUser
                  : css.bubbleAssistant
              }`}
            >
              <MarkdownText text={message.content} />
            </div>
            <div className={css.messageMeta}>
              <span>{message.role === 'user' ? '你' : 'THETA'}</span>
              <span>{message.messageKind}</span>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {runId != null && status != null && onApproved != null && (
        <div style={{ padding: '0 16px 8px' }}>
          <ApprovalPanel runId={runId} status={status} onApproved={onApproved} />
        </div>
      )}
      <div className={css.composer}>
        <Input
          id="theta-composer"
          className={css.composerInput}
          placeholder="用自然语言与研究助手对话，例如：把正文列改成 content…"
          value={draft}
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <Button variant="primary" disabled={sending || draft.trim().length === 0} onClick={submit}>
          {sending ? '处理中…' : '发送'}
        </Button>
      </div>
    </div>
  )
}
