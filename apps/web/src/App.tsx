import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createWorkspaceSession,
  deleteWorkspaceSession,
  deleteRun,
  getConversation,
  getEvents,
  getReasoning,
  getRun,
  getRuntimeProfile,
  getWorkspaceConversation,
  listWorkspaceSessions,
  listRuns,
  openRunStream,
  postMessage,
  postWorkspaceMessage,
  renameRun,
  renameWorkspaceSession,
  type WebAgentInteraction,
  type WebAttachment,
  type WebConversationMemory,
  type WebMessage,
  type WebReasoning,
  type WebRunEvent,
  type WebRunStatus,
  type WebRunSummary,
  type WebRuntimeProfile,
  type WebRunResults,
  type WebWorkspaceSummary,
} from './api/client.ts'
import {
  BrandWordmark,
  Button,
  IconNewChatOutline16,
  IconPanelLeftOutline16,
  IconTrashOutline16,
  StateDot,
} from './ui/index.ts'
import { ConversationPane, type QueuedChatMessage } from './panels/ConversationPane.tsx'
import { DetailPane } from './panels/DetailPane.tsx'
import { usePreferences } from './preferences.tsx'
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

const relativeTime = (timestamp: string, locale: 'zh-CN' | 'en'): string => {
  const elapsed = Date.now() - Date.parse(timestamp)
  if (!Number.isFinite(elapsed) || elapsed < 0) return locale === 'zh-CN' ? '刚刚' : 'now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return locale === 'zh-CN' ? '刚刚' : 'now'
  if (minutes < 60) return locale === 'zh-CN' ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return locale === 'zh-CN' ? `${hours} 小时前` : `${hours}h ago`
  return locale === 'zh-CN' ? `${Math.floor(hours / 24)} 天前` : `${Math.floor(hours / 24)}d ago`
}

const runStateLabel = (state: string | undefined, status: string, locale: 'zh-CN' | 'en'): string => {
  const waiting = status === 'waiting_human'
  if (locale === 'en') {
    if (status === 'completed') return 'Completed'
    if (status === 'failed') return 'Needs attention'
    if (waiting) return 'Waiting for you'
    return 'In progress'
  }
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '需要处理'
  if (waiting) return state?.includes('Training') ? '等待启动确认' : '等待你确认'
  return '进行中'
}

export const AppRoot = (): React.ReactElement => {
  const { locale, setLocale, resolvedTheme, toggleTheme, t } = usePreferences()
  const [runs, setRuns] = useState<WebRunSummary[]>([])
  const [workspaceSessions, setWorkspaceSessions] = useState<WebWorkspaceSummary[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [messages, setMessages] = useState<WebMessage[]>([])
  const [status, setStatus] = useState<WebRunStatus>()
  const [events, setEvents] = useState<WebRunEvent[]>([])
  const [reasoning, setReasoning] = useState<WebReasoning>()
  const [results, setResults] = useState<WebRunResults>()
  const [memory, setMemory] = useState<WebConversationMemory>()
  const [sending, setSending] = useState(false)
  const [queued, setQueued] = useState<Array<QueuedChatMessage & { runId?: string; workspaceSessionId?: string }>>([])
  const [attachments, setAttachments] = useState<WebAttachment[]>([])
  const [loadError, setLoadError] = useState<string>()
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [runtimeProfile, setRuntimeProfile] = useState<WebRuntimeProfile>()
  const [workspaceSessionId, setWorkspaceSessionId] = useState<string>()
  const [workspaceInteraction, setWorkspaceInteraction] = useState<WebAgentInteraction>()
  const [workspaceActivity, setWorkspaceActivity] = useState<{ proposal?: unknown; result?: unknown; evidenceRefs?: unknown }>()
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

  const refreshWorkspaceSessions = useCallback(async () => {
    try {
      setWorkspaceSessions((await listWorkspaceSessions()).sessions)
    } catch {
      setWorkspaceSessions([])
    }
  }, [])

  useEffect(() => {
    void refreshRuns()
    void refreshWorkspaceSessions()
  }, [refreshRuns, refreshWorkspaceSessions])

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
      setResults(detail.results)
      setMemory(conversation.memory)
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
    setResults(undefined)
    setMemory(undefined)
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
        setResults(detail.results)
        setMemory(conversation.memory)
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

  const enqueue = useCallback((text: string, nextAttachments: WebAttachment[]) => {
    setQueued((current) => [...current, {
      id: crypto.randomUUID(),
      text,
      attachments: nextAttachments,
      ...(selectedRunId ? { runId: selectedRunId } : {}),
      ...(workspaceSessionId ? { workspaceSessionId } : {}),
    }])
  }, [selectedRunId, workspaceSessionId])

  useEffect(() => {
    const next = queued[0]
    if (!next || sending) return
    setSending(true)
    setLoadError(undefined)
    void (async () => {
      try {
        if (next.runId) {
          const result = await postMessage(next.runId, next.text, true, next.attachments)
          if (selectedRunId === next.runId) {
            setStatus(result.status)
            mergeMessages(result.messages)
          }
          void refreshRuns()
        } else {
          let sessionId = next.workspaceSessionId ?? workspaceSessionId
          if (!sessionId) {
            const created = await createWorkspaceSession()
            sessionId = created.sessionId
            setWorkspaceSessionId(sessionId)
            setWorkspaceInteraction(created.interaction)
          }
          const result = await postWorkspaceMessage(sessionId, next.text)
          if (selectedRunId == null) {
            mergeMessages(result.messages)
            setWorkspaceInteraction(result.interaction)
            setWorkspaceActivity(result.activity)
            setMemory(result.memory)
          }
          void refreshWorkspaceSessions()
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        setQueued((current) => current.filter((item) => item.id !== next.id))
        setSending(false)
      }
    })()
  }, [queued, sending, selectedRunId, workspaceSessionId, mergeMessages, refreshRuns, refreshWorkspaceSessions])

  const startNewConversation = useCallback(async () => {
    setSelectedRunId(undefined)
    setMessages([])
    setEvents([])
    setReasoning(undefined)
    setResults(undefined)
    setMemory(undefined)
    setStatus(undefined)
    setWorkspaceActivity(undefined)
    setWorkspaceInteraction(undefined)
    setAttachments([])
    knownMessageIds.current.clear()
    try {
      const created = await createWorkspaceSession()
      setWorkspaceSessionId(created.sessionId)
      setWorkspaceInteraction(created.interaction)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const removeRun = async (runId: string): Promise<void> => {
    if (!window.confirm(locale === 'zh-CN' ? '删除该研究任务及其本地运行记录？此操作无法撤销。' : 'Delete this research task and its local records? This cannot be undone.')) return
    try {
      await deleteRun(runId)
      if (selectedRunId === runId) {
        setSelectedRunId(undefined)
        setMessages([])
        setStatus(undefined)
      }
      await refreshRuns()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const renameHistory = async (run: WebRunSummary): Promise<void> => {
    const current = run.identity?.displayName ?? run.presentation?.title ?? run.runId
    const displayName = window.prompt(locale === 'zh-CN' ? '修改对话名称' : 'Rename conversation', current)?.trim()
    if (!displayName || displayName === current) return
    try {
      await renameRun(run.runId, displayName)
      await refreshRuns()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const selectWorkspaceHistory = async (sessionId: string): Promise<void> => {
    setSelectedRunId(undefined)
    setMessages([])
    setStatus(undefined)
    setEvents([])
    setReasoning(undefined)
    setResults(undefined)
    setWorkspaceActivity(undefined)
    setWorkspaceInteraction(undefined)
    setAttachments([])
    knownMessageIds.current.clear()
    try {
      const conversation = await getWorkspaceConversation(sessionId)
      setWorkspaceSessionId(sessionId)
      setWorkspaceInteraction(conversation.interaction)
      setMemory(conversation.memory)
      mergeMessages(conversation.messages)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const renameWorkspaceHistory = async (session: WebWorkspaceSummary): Promise<void> => {
    const displayName = window.prompt(locale === 'zh-CN' ? '修改对话名称' : 'Rename conversation', session.title)?.trim()
    if (!displayName || displayName === session.title) return
    try {
      await renameWorkspaceSession(session.sessionId, displayName)
      await refreshWorkspaceSessions()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const removeWorkspaceHistory = async (session: WebWorkspaceSummary): Promise<void> => {
    if (!window.confirm(locale === 'zh-CN' ? '删除这个对话？' : 'Delete this conversation?')) return
    try {
      await deleteWorkspaceSession(session.sessionId)
      if (workspaceSessionId === session.sessionId) await startNewConversation()
      await refreshWorkspaceSessions()
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
          <div className={`${css.connectionState} ${css[`connection_${streamState}`]}`} title={streamState}>
            <span />
            {streamState === 'live' ? (locale === 'zh-CN' ? '实时' : 'Live') : (locale === 'zh-CN' ? '本地' : 'Local')}
          </div>
          <button type="button" className={css.preferenceButton} onClick={toggleTheme} title={resolvedTheme === 'dark' ? t('light') : t('dark')}>
            {resolvedTheme === 'dark' ? '☼' : '◐'}
          </button>
          <button type="button" className={css.preferenceButton} onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>
            {locale === 'zh-CN' ? 'EN' : '中'}
          </button>
          {selectedRunId != null && (
            <Button
              size="sm"
              variant="ghost"
              className={`${css.iconButton} ${detailOpen ? css.detailToggleActive : ''}`}
              aria-label={detailOpen ? '收起运行详情' : '展开运行详情'}
              onClick={toggleDetail}
            >
              <IconPanelLeftOutline16 className={css.flipIcon} />
            </Button>
          )}
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
              onClick={() => void startNewConversation()}
            >
              {t('newChat')}
            </Button>
            <div className={css.sidebarHeading}>
              <span>{t('history')}</span>
              <span>{runs.length + workspaceSessions.length}</span>
            </div>
            <nav className={css.runList} aria-label="研究任务">
              {runsLoading && <div className={css.sidebarEmpty}>正在同步任务目录…</div>}
              {!runsLoading && runs.length === 0 && workspaceSessions.length === 0 && (
                <div className={css.sidebarEmpty}>{t('emptyHistory')}</div>
              )}
              {workspaceSessions.map((session) => (
                <div key={session.sessionId} className={css.runRow}>
                  <button
                    type="button"
                    className={`${css.runItem} ${session.sessionId === workspaceSessionId && selectedRunId == null ? css.runItemActive : ''}`}
                    onClick={() => void selectWorkspaceHistory(session.sessionId)}
                  >
                    <span className={css.runName}>{session.title}</span>
                    <span className={css.runDataset}>{locale === 'zh-CN' ? '普通对话' : 'Conversation'} · {session.messageCount} messages</span>
                    <span className={css.runMeta}>
                      <StateDot size={7} state="done" />
                      <span>{locale === 'zh-CN' ? '可继续' : 'Ready'}</span>
                      <time dateTime={session.updatedAt}>{relativeTime(session.updatedAt, locale)}</time>
                    </span>
                  </button>
                  <div className={css.runActions}>
                    <button type="button" title={t('rename')} onClick={() => void renameWorkspaceHistory(session)}>✎</button>
                    <button type="button" title={t('delete')} onClick={() => void removeWorkspaceHistory(session)}><IconTrashOutline16 /></button>
                  </div>
                </div>
              ))}
              {runs.map((run) => (
                <div key={run.runId} className={css.runRow}>
                  <button
                    type="button"
                    className={`${css.runItem} ${run.runId === selectedRunId ? css.runItemActive : ''}`}
                    onClick={() => {
                      setWorkspaceSessionId(undefined)
                      setWorkspaceActivity(undefined)
                      setSelectedRunId(run.runId)
                    }}
                  >
                    <span className={css.runName}>{run.identity?.displayName ?? run.presentation?.title ?? run.runId}</span>
                    <span className={css.runDataset}>{run.identity?.datasetName ?? run.identity?.researchQuestion ?? 'Local research run'}</span>
                    <span className={css.runMeta}>
                      <StateDot size={7} state={dotState(run.status)} />
                      <span>{runStateLabel(run.currentState, run.status, locale)}</span>
                      <time dateTime={run.updatedAt}>{relativeTime(run.updatedAt, locale)}</time>
                    </span>
                  </button>
                  <div className={css.runActions}>
                    <button type="button" title={t('rename')} onClick={() => void renameHistory(run)}>✎</button>
                    <button type="button" title={t('delete')} onClick={() => void removeRun(run.runId)}><IconTrashOutline16 /></button>
                  </div>
                </div>
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
                queued={queued.filter((item) => item.runId === selectedRunId && item.workspaceSessionId === (selectedRunId ? undefined : workspaceSessionId))}
                onSend={enqueue}
                onCreated={(runId) => {
                  setSelectedRunId(runId)
                  setWorkspaceSessionId(undefined)
                  setWorkspaceActivity(undefined)
                  void refreshRuns()
                }}
                workspaceSessionId={workspaceSessionId}
                entryInteraction={workspaceInteraction ?? runtimeProfile?.entryInteraction}
                workspaceActivity={workspaceActivity}
                runId={selectedRunId}
                status={status}
                reasoning={reasoning}
                onApproved={() => void refreshRun()}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
              />
            )}
        </main>

        {detailOpen && selectedRunId != null && (
          <DetailPane
            runId={selectedRunId}
            status={status}
            events={events}
            reasoning={reasoning}
            results={results}
            memory={memory}
            onAttach={(attachment) => {
              setAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment].slice(-12))
            }}
            onChanged={() => void refreshRun()}
          />
        )}
      </div>
    </div>
  )
}
