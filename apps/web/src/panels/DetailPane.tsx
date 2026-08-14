import { useCallback, useState } from 'react'
import {
  postAction,
  type WebReasoning,
  type WebRunEvent,
  type WebRunStatus,
} from '../api/client.ts'
import { Button, JsonTree, Pill, StateDot } from '../ui/index.ts'
import css from '../styles/app.module.css'

type TabId = 'status' | 'tools' | 'reasoning' | 'events'

interface DetailPaneProps {
  runId?: string
  status?: WebRunStatus
  events: WebRunEvent[]
  reasoning?: WebReasoning
  onChanged: () => void
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'status', label: '状态' },
  { id: 'tools', label: '工具' },
  { id: 'reasoning', label: '推理' },
  { id: 'events', label: '事件' },
]

const stateOf = (status?: WebRunStatus): 'done' | 'warning' | 'ongoing' | 'error' =>
  status?.status === 'failed'
    ? 'error'
    : status?.status === 'waiting_human'
      ? 'warning'
      : status?.status === 'completed'
        ? 'done'
        : 'ongoing'

const jsonPayload = (payload: unknown): React.ReactElement | string => {
  if (payload !== null && typeof payload === 'object') {
    return <JsonTree data={payload as object | unknown[]} copyable={false} />
  }
  return String(payload)
}

export const DetailPane = ({
  runId,
  status,
  events,
  reasoning,
  onChanged,
}: DetailPaneProps): React.ReactElement => {
  const [tab, setTab] = useState<TabId>('status')
  const [expandedEvent, setExpandedEvent] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  const poll = useCallback(async () => {
    if (!runId || busy) return
    setBusy(true)
    setActionError(undefined)
    try {
      await postAction(runId, { action: 'poll' })
      onChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [runId, busy, onChanged])

  const presentation = status?.presentation
  const statePath = status?.statePath?.filter(
    (state, index, path) => index === 0 || state !== path[index - 1],
  )

  return (
    <aside className={css.detail}>
      <div className={css.detailHeader}>
        <span>RUN INSPECTOR</span>
        <strong>{events.length} events</strong>
      </div>
      <div className={css.tabs}>
        {TABS.map((item) => (
          <Pill key={item.id} active={tab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
          </Pill>
        ))}
      </div>
      <div className={css.tabBody}>
        {runId == null && <div className={css.empty}>选择一个研究任务以查看运行详情。</div>}
        {tab === 'status' && (
          <>
            {presentation != null && (
              <>
                <div className={css.section}>
                  <span className={css.sectionTitle}>{presentation.title}</span>
                  <span className={css.sectionLine}>{presentation.summary}</span>
                  {presentation.progress != null && (
                    <>
                      <div className={css.progressTrack}>
                        <div
                          className={css.progressFill}
                          style={{
                            width: `${Math.round(
                              ((presentation.progress.current /
                                Math.max(presentation.progress.total, 1)) *
                                100),
                            )}%`,
                          }}
                        />
                      </div>
                      <span className={css.runMeta}>
                        {presentation.progress.label} · {presentation.progress.current}/
                        {presentation.progress.total}
                      </span>
                    </>
                  )}
                </div>
                {presentation.sections?.map((section) => (
                  <div key={section.title} className={css.section}>
                    <span className={css.sectionTitle}>{section.title}</span>
                    {section.lines.map((line, index) => (
                      <span key={index} className={css.sectionLine}>
                        {line}
                      </span>
                    ))}
                  </div>
                ))}
                {presentation.nextActions.length > 0 && (
                  <div className={css.section}>
                    <span className={css.sectionTitle}>下一步</span>
                    <div className={css.actions}>
                      {presentation.nextActions.map((action) => (
                        <div key={action.id} className={css.sectionLine}>
                          <span style={{ fontWeight: 600 }}>{action.label}</span>
                          {action.recommended === true && (
                            <span style={{ marginLeft: 6, color: 'var(--dsw-alias-accent)' }}>
                              推荐
                            </span>
                          )}
                          <br />
                          <span>{action.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            {status?.pendingReason != null && (
              <div className={css.banner}>等待你处理：{status.pendingReason}</div>
            )}
            {statePath != null && statePath.length > 0 && (
              <div className={css.section}>
                <span className={css.sectionTitle}>状态路径</span>
                <div className={css.statePath}>
                  {statePath.map((state, index) => (
                    <span key={`${state}-${index}`} className={css.runMeta}>
                      <StateDot
                        size={8}
                        state={index < statePath.length - 1 ? 'done' : stateOf(status)}
                      />
                      {state}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <Button variant="outline" disabled={!runId || busy} onClick={() => void poll()}>
              同步运行状态
            </Button>
            {actionError != null && <div className={css.formError}>{actionError}</div>}
          </>
        )}

        {tab === 'tools' && (
          <>
            {(reasoning?.toolCalls.length ?? 0) === 0 && (
              <div className={css.empty}>还没有工具调用</div>
            )}
            {reasoning?.toolCalls.map((call) => (
              <div key={call.eventId} className={css.toolCall}>
                <div className={css.toolCallHead}>
                  <StateDot
                    size={8}
                    state={call.phase === 'failed' ? 'error' : call.phase === 'completed' ? 'done' : 'ongoing'}
                  />
                  <span style={{ fontWeight: 600 }}>{call.toolId}</span>
                  <span className={css.runMeta}>
                    {call.phase} · {call.timestamp.slice(11, 19)}
                  </span>
                </div>
                {call.payload !== undefined && (
                  <div className={css.toolCallPayload}>{jsonPayload(call.payload)}</div>
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'reasoning' && (
          <>
            {reasoning?.currentDecisionGap != null && (
              <div className={css.banner}>待回答的研究问题：{reasoning.currentDecisionGap}</div>
            )}
            {reasoning?.decisionGaps.map((gap, index) => (
              <div key={index} className={css.section}>
                <span className={css.sectionTitle}>
                  {gap.resolved ? '已回答' : '进行中'} · {gap.question}
                </span>
                {gap.answers.map((answer, answerIndex) => (
                  <span key={answerIndex} className={css.sectionLine}>
                    → {answer.content}
                  </span>
                ))}
                {gap.answers.length === 0 && (
                  <span className={css.sectionLine}>尚无回答</span>
                )}
              </div>
            ))}
            {reasoning?.intentSummary != null && (
              <div className={css.section}>
                <span className={css.sectionTitle}>研究意图摘要</span>
                <div className={css.toolCallPayload}>
                  {jsonPayload(reasoning.intentSummary)}
                </div>
              </div>
            )}
            {reasoning?.recommendation != null && (
              <div className={css.section}>
                <span className={css.sectionTitle}>模型推荐</span>
                <div className={css.toolCallPayload}>
                  {jsonPayload(reasoning.recommendation)}
                </div>
              </div>
            )}
            {reasoning?.plan != null && (
              <div className={css.section}>
                <span className={css.sectionTitle}>方案阶段：{reasoning.plan.state}</span>
                {reasoning.plan.presentation != null && (
                  <>
                    <span className={css.sectionLine}>{reasoning.plan.presentation.summary}</span>
                    {reasoning.plan.presentation.sections?.map((section) => (
                      <div key={section.title}>
                        <span className={css.sectionTitle}>{section.title}</span>
                        {section.lines.map((line, index) => (
                          <span key={index} className={css.sectionLine}>
                            {line}
                          </span>
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
            {(reasoning?.decisionGaps.length ?? 0) === 0 &&
              reasoning?.intentSummary == null &&
              reasoning?.recommendation == null &&
              reasoning?.plan == null && <div className={css.empty}>还没有推理产物</div>}
          </>
        )}

        {tab === 'events' && (
          <>
            {events.length === 0 && <div className={css.empty}>还没有运行时事件</div>}
            {[...events].reverse().map((event) => (
              <div key={event.id} className={css.section}>
                <button
                  type="button"
                  className={css.toolCallHead}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
                  onClick={() =>
                    setExpandedEvent((current) => (current === event.id ? undefined : event.id))
                  }
                >
                  <StateDot
                    size={8}
                    state={
                      event.type.includes('failed') || event.type.includes('rejected')
                        ? 'error'
                        : event.type.includes('completed') || event.type.includes('approved')
                          ? 'done'
                          : 'ongoing'
                    }
                  />
                  <span style={{ fontWeight: 600 }}>{event.title}</span>
                  <span className={css.runMeta}>
                    {event.source} · {event.timestamp.slice(11, 19)}
                  </span>
                </button>
                {event.detail != null && <span className={css.sectionLine}>{event.detail}</span>}
                {expandedEvent === event.id && event.payload !== undefined && (
                  <div className={css.toolCallPayload}>{jsonPayload(event.payload)}</div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
