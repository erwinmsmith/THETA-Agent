import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getConversation,
  getEvents,
  getReasoning,
  getRun,
  listRuns,
  openRunStream,
  postMessage,
  type WebMessage,
  type WebRunEvent,
  type WebRunStatus,
  type WebRunSummary,
  type WebReasoning,
} from './api/client.ts'
import { BrandWordmark, StateDot } from './ui/index.ts'
import { ConversationPane } from './panels/ConversationPane.tsx'
import { DetailPane } from './panels/DetailPane.tsx'
import css from './styles/app.module.css'

export const AppRoot = (): React.ReactElement => {
  const [runs, setRuns] = useState<WebRunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [messages, setMessages] = useState<WebMessage[]>([])
  const [status, setStatus] = useState<WebRunStatus>()
  const [events, setEvents] = useState<WebRunEvent[]>([])
  const [reasoning, setReasoning] = useState<WebReasoning>()
  const [sending, setSending] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const knownMessageIds = useRef(new Set<string>())
  const streamRef = useRef<EventSource>()

  const refreshRuns = useCallback(async () => {
    try {
      const data = await listRuns()
      setRuns(data.runs)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refreshRuns()
  }, [refreshRuns])

  const mergeMessages = useCallback((incoming: WebMessage[]) => {
    setMessages((current) => {
      const next = [...current]
      for (const message of incoming) {
        if (knownMessageIds.current.has(message.messageId)) continue
        knownMessageIds.current.add(message.messageId)
        next.push(message)
      }
      next.sort((left, right) => left.sequenceNumber - right.sequenceNumber)
      return next
    })
  }, [])

  useEffect(() => {
    if (!selectedRunId) return
    setLoadError(undefined)
    setMessages([])
    setEvents([])
    setReasoning(undefined)
    setStatus(undefined)
    knownMessageIds.current.clear()
    void (async () => {
      try {
        const [detail, conversation, eventData, reasoningData] = await Promise.all([
          getRun(selectedRunId),
          getConversation(selectedRunId),
          getEvents(selectedRunId, { limit: 300 }),
          getReasoning(selectedRunId),
        ])
        setStatus(detail.status)
        mergeMessages(conversation.messages)
        setEvents(eventData.events)
        setReasoning(reasoningData)
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
      }
    })()
    streamRef.current?.close()
    streamRef.current = openRunStream(selectedRunId, {
      onStatus: (data) => setStatus(data.status),
      onEvents: (data) =>
        setEvents((current) => {
          const known = new Set(current.map((event) => event.id))
          return [...current, ...data.events.filter((event) => !known.has(event.id))].sort(
            (left, right) => left.timestamp.localeCompare(right.timestamp),
          )
        }),
      onMessages: (data) => mergeMessages(data.messages),
    })
    return () => {
      streamRef.current?.close()
    }
  }, [selectedRunId, mergeMessages])

  const send = useCallback(
    async (text: string) => {
      if (!selectedRunId || sending) return
      setSending(true)
      setLoadError(undefined)
      try {
        const result = await postMessage(selectedRunId, text)
        setStatus(result.status)
        mergeMessages(result.messages)
        void refreshRuns()
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        setSending(false)
      }
    },
    [selectedRunId, sending, mergeMessages, refreshRuns],
  )

  const refreshRun = useCallback(async () => {
    if (!selectedRunId) return
    try {
      const [detail, conversation, eventData, reasoningData] = await Promise.all([
        getRun(selectedRunId),
        getConversation(selectedRunId),
        getEvents(selectedRunId, { limit: 300 }),
        getReasoning(selectedRunId),
      ])
      setStatus(detail.status)
      mergeMessages(conversation.messages)
      setEvents(eventData.events)
      setReasoning(reasoningData)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    void refreshRuns()
  }, [selectedRunId, mergeMessages, refreshRuns])

  const selectedRun = runs.find((run) => run.runId === selectedRunId)

  return (
    <div className={css.shell}>
      <div className={css.topbar}>
        <BrandWordmark />
        <StateDot
          state={
            status?.status === 'failed'
              ? 'error'
              : status?.status === 'waiting_human'
                ? 'warning'
                : status?.status === 'completed'
                  ? 'done'
                  : 'ongoing'
          }
        />
        <span className={css.topbarTitle}>
          {status?.presentation?.title ?? 'THETA Agent 对话式研究助手'}
        </span>
        <span style={{ flex: 1 }} />
        {loadError != null && <span className={css.runMeta}>{loadError}</span>}
      </div>
      <div className={css.body}>
        <aside className={css.sidebar}>
          {runs.length === 0 && <div className={css.empty}>暂无研究任务</div>}
          {runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={`${css.runItem} ${run.runId === selectedRunId ? css.runItemActive : ''}`}
              onClick={() => setSelectedRunId(run.runId)}
            >
              <span className={css.runName}>{run.identity?.displayName ?? run.runId}</span>
              <span className={css.runMeta}>
                <StateDot
                  size={8}
                  state={
                    run.status === 'failed'
                      ? 'error'
                      : run.status === 'waiting_human'
                        ? 'warning'
                        : run.status === 'completed'
                          ? 'done'
                          : 'ongoing'
                  }
                />
                {run.currentState ?? run.status}
              </span>
            </button>
          ))}
        </aside>
        <main className={css.center}>
          <ConversationPane
            messages={messages}
            sending={sending}
            onSend={send}
            runId={selectedRunId}
            status={status}
            onApproved={() => void refreshRun()}
          />
        </main>
        <DetailPane
          runId={selectedRunId}
          status={status}
          events={events}
          reasoning={reasoning}
          onChanged={() => {
            void refreshRuns()
          }}
        />
      </div>
    </div>
  )
}
