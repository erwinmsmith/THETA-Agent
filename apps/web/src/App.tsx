import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteRun,
  getConversation,
  getEvents,
  getReasoning,
  getRun,
  getRuntimeProfile,
  listRuns,
  openRunStream,
  postMessage,
  type WebMessage,
  type WebReasoning,
  type WebRunEvent,
  type WebRunStatus,
  type WebRunSummary,
  type WebRuntimeProfile,
} from './api/client.ts'
import {
  BrandWordmark,
  Button,
  IconNewChatOutline16,
  IconPanelLeftOutline16,
  IconTrashOutline16,
  StateDot,
} from './ui/index.ts'
import { ConversationPane } from './panels/ConversationPane.tsx'
import { DetailPane } from './panels/DetailPane.tsx'
import { InferenceSelector } from './panels/InferenceSelector.tsx'
import { NewRunDialog } from './panels/NewRunDialog.tsx'
import './styles/base.css'
import css from './styles/app.module.css'

type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting'

const dotState = (value?: string): 'error' | 'warning' | 'done' | 'ongoing' =>
  value === 'failed'
    ? 'error'
    : value === 'waiting_human'
      ? 'warning'
      : value === 'completed'
        ? 'done'
        : 'ongoing'

const relativeTime = (timestamp: string): string => {
  const elapsed = Date.now() - Date.parse(timestamp)
  if (!Number.isFinite(elapsed) || elapsed < 0) return '刚刚'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export const AppRoot = (): React.ReactElement => {
  const [runs, setRuns] = useState<WebRunSummary[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [messages, setMessages] = useState<WebMessage[]>([])
  const [status, setStatus] = useState<WebRunStatus>()
  const [events, setEvents] = useState<WebRunEvent[]>([])
  const [reasoning, setReasoning] = useState<WebReasoning>()
  const [sending, setSending] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [runtimeProfile, setRuntimeProfile] = useState<WebRuntimeProfile>()
  const [newRunOpen, setNewRunOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [detailOpen, setDetailOpen] = useState(true)
  const knownMessageIds = useRef(new Set<string>())

  const refreshRuns = useCallback(async () => {
    try {
      const data = await listRuns()
      setRuns(data.runs)
      setSelectedRunId((current) => {
        if (current != null && data.runs.some((run) => run.runId === current)) return current
        return data.runs[0]?.runId
      })
      setLoadError(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshRuns()
  }, [refreshRuns])

  useEffect(() => {
    void getRuntimeProfile()
      .then(setRuntimeProfile)
      .catch(() => setRuntimeProfile(undefined))
  }, [])

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)')
    const syncPanels = (matches: boolean): void => {
      setSidebarOpen(!matches)
      setDetailOpen(!matches)
    }
    syncPanels(narrow.matches)
    const onChange = (event: MediaQueryListEvent): void => syncPanels(event.matches)
    narrow.addEventListener('change', onChange)
    return () => narrow.removeEventListener('change', onChange)
  }, [])

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
      setLoadError(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    void refreshRuns()
  }, [selectedRunId, mergeMessages, refreshRuns])

  useEffect(() => {
    if (!selectedRunId) {
      setStreamState('idle')
      return
    }
    let cancelled = false
    let reasoningTimer: number | undefined
    setLoadError(undefined)
    setMessages([])
    setEvents([])
    setReasoning(undefined)
    setStatus(undefined)
    setStreamState('connecting')
    knownMessageIds.current.clear()

    void (async () => {
      try {
        const [detail, conversation, eventData, reasoningData] = await Promise.all([
          getRun(selectedRunId),
          getConversation(selectedRunId),
          getEvents(selectedRunId, { limit: 300 }),
          getReasoning(selectedRunId),
        ])
        if (cancelled) return
        setStatus(detail.status)
        mergeMessages(conversation.messages)
        setEvents(eventData.events)
        setReasoning(reasoningData)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }
    })()

    const scheduleReasoningRefresh = (): void => {
      window.clearTimeout(reasoningTimer)
      reasoningTimer = window.setTimeout(() => {
        void getReasoning(selectedRunId)
          .then((data) => {
            if (!cancelled) setReasoning(data)
          })
          .catch(() => undefined)
      }, 250)
    }
    const source = openRunStream(selectedRunId, {
      onOpen: () => setStreamState('live'),
      onSnapshot: (data) => {
        setStatus(data.status)
        setStreamState('live')
      },
      onStatus: (data) => setStatus(data.status),
      onEvents: (data) => {
        setEvents((current) => {
          const known = new Set(current.map((event) => event.id))
          return [...current, ...data.events.filter((event) => !known.has(event.id))].sort(
            (left, right) => left.timestamp.localeCompare(right.timestamp),
          )
        })
        scheduleReasoningRefresh()
      },
      onMessages: (data) => mergeMessages(data.messages),
      onError: () => setStreamState('reconnecting'),
    })
    return () => {
      cancelled = true
      window.clearTimeout(reasoningTimer)
      source.close()
    }
  }, [selectedRunId, mergeMessages])

  const send = useCallback(async (text: string) => {
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
  }, [selectedRunId, sending, mergeMessages, refreshRuns])

  const removeSelectedRun = async (): Promise<void> => {
    if (!selectedRunId || !window.confirm('删除该研究任务及其本地运行记录？此操作无法撤销。')) return
    try {
      await deleteRun(selectedRunId)
      setSelectedRunId(undefined)
      setMessages([])
      setStatus(undefined)
      await refreshRuns()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId),
    [runs, selectedRunId],
  )

  const toggleSidebar = (): void => {
    setSidebarOpen((current) => {
      if (!current && window.matchMedia('(max-width: 900px)').matches) setDetailOpen(false)
      return !current
    })
  }

  const toggleDetail = (): void => {
    setDetailOpen((current) => {
      if (!current && window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false)
      return !current
    })
  }

  return (
    <div className={css.shell}>
      <header className={css.topbar}>
        <Button
          size="sm"
          variant="ghost"
          className={css.iconButton}
          aria-label={sidebarOpen ? '收起任务列表' : '展开任务列表'}
          onClick={toggleSidebar}
        >
          <IconPanelLeftOutline16 />
        </Button>
        <BrandWordmark />
        <span className={css.workspaceDivider} />
        <div className={css.titleBlock}>
          <span className={css.topbarTitle}>{status?.presentation?.title ?? 'Research workspace'}</span>
          <span className={css.topbarSubtitle}>{selectedRun?.identity?.datasetName ?? 'THETA autonomous research agent'}</span>
        </div>
        <div className={css.topbarActions}>
          <div
            className={css.computeState}
            title={runtimeProfile == null
              ? '正在读取 Agent 计算运行时'
              : `${runtimeProfile.capabilities.tools} tools · ${runtimeProfile.capabilities.skills} skills`}
          >
            <span />
            {runtimeProfile == null
              ? 'RUNTIME'
              : `${runtimeProfile.compute.defaultDevice.toUpperCase()} · ${runtimeProfile.compute.backend.toUpperCase()}`}
          </div>
          <InferenceSelector />
          <div className={`${css.connectionState} ${css[`connection_${streamState}`]}`}>
            <span />
            {streamState === 'live'
              ? '实时'
              : streamState === 'reconnecting'
                ? '重连中'
                : streamState === 'connecting'
                  ? '连接中'
                  : '待机'}
          </div>
          {selectedRunId != null && (
            <Button
              size="sm"
              variant="ghost"
              className={css.iconButton}
              aria-label="删除当前任务"
              onClick={() => void removeSelectedRun()}
            >
              <IconTrashOutline16 />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={`${css.iconButton} ${detailOpen ? css.detailToggleActive : ''}`}
            aria-label={detailOpen ? '收起运行详情' : '展开运行详情'}
            onClick={toggleDetail}
          >
            <IconPanelLeftOutline16 className={css.flipIcon} />
          </Button>
        </div>
      </header>

      {loadError != null && (
        <div className={css.errorStrip} role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => setLoadError(undefined)}>关闭</button>
        </div>
      )}

      <div className={css.body}>
        {sidebarOpen && (
          <aside className={css.sidebar}>
            <Button
              variant="primary"
              className={css.newRunButton}
              icon={<IconNewChatOutline16 />}
              onClick={() => setNewRunOpen(true)}
            >
              新建研究任务
            </Button>
            <div className={css.sidebarHeading}>
              <span>RESEARCH RUNS</span>
              <span>{runs.length}</span>
            </div>
            <nav className={css.runList} aria-label="研究任务">
              {runsLoading && <div className={css.sidebarEmpty}>正在同步任务目录…</div>}
              {!runsLoading && runs.length === 0 && (
                <div className={css.sidebarEmpty}>还没有任务。上传数据集后开始第一次研究。</div>
              )}
              {runs.map((run) => (
                <button
                  key={run.runId}
                  type="button"
                  className={`${css.runItem} ${run.runId === selectedRunId ? css.runItemActive : ''}`}
                  onClick={() => setSelectedRunId(run.runId)}
                >
                  <span className={css.runName}>{run.identity?.displayName ?? run.presentation?.title ?? run.runId}</span>
                  <span className={css.runDataset}>{run.identity?.datasetName ?? run.identity?.researchQuestion ?? 'Local research run'}</span>
                  <span className={css.runMeta}>
                    <StateDot size={7} state={dotState(run.status)} />
                    <span>{run.currentState ?? run.status}</span>
                    <time dateTime={run.updatedAt}>{relativeTime(run.updatedAt)}</time>
                  </span>
                </button>
              ))}
            </nav>
            <div className={css.sidebarFooter}>
              <span>LOCAL WORKSPACE</span>
              <span>THETA 2.0</span>
            </div>
          </aside>
        )}

        <main className={css.center}>
          {runsLoading && selectedRunId == null
            ? (
              <div className={css.catalogLoading}>
                <span />
                <strong>正在恢复研究工作区</strong>
                <small>读取本地任务、对话与 Agent 状态</small>
              </div>
            )
            : (
              <ConversationPane
                messages={messages}
                sending={sending}
                onSend={send}
                onCreate={() => setNewRunOpen(true)}
                runId={selectedRunId}
                status={status}
                onApproved={() => void refreshRun()}
              />
            )}
        </main>

        {detailOpen && (
          <DetailPane
            runId={selectedRunId}
            status={status}
            events={events}
            reasoning={reasoning}
            onChanged={() => void refreshRun()}
          />
        )}
      </div>

      <NewRunDialog
        open={newRunOpen}
        onClose={() => setNewRunOpen(false)}
        onCreated={(runId) => {
          setSelectedRunId(runId)
          void refreshRuns()
        }}
      />
    </div>
  )
}
