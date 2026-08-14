import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getStatus,
  postAction,
  type WebAgentInteraction,
  type WebReasoning,
  type WebRunStatus,
} from '../api/client.ts'
import { Button, Input } from '../ui/index.ts'
import css from '../styles/app.module.css'

/** Approximate shapes of the dataset facts/understanding carried by /status. */
interface ColumnFact {
  name: string
  dataType?: string
  nonNullRatio?: number
  sampleValues?: string[]
}

interface WebDatasetFacts {
  rowCount?: number
  columns?: ColumnFact[]
}

interface RoleColumns {
  column: string
}

interface WebDatasetUnderstanding {
  domain?: { label?: string }
  analysisUnit?: string
  textColumns?: RoleColumns[]
  timeColumns?: RoleColumns[]
  idColumns?: RoleColumns[]
  metadataColumns?: RoleColumns[]
  groupColumns?: RoleColumns[]
  covariateColumns?: RoleColumns[]
  evaluationColumns?: RoleColumns[]
  ignoredColumns?: RoleColumns[]
}

type StatusExtras = WebRunStatus & {
  datasetFacts?: WebDatasetFacts
  datasetUnderstanding?: WebDatasetUnderstanding
}

const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'textColumns', label: '正文列' },
  { value: 'timeColumns', label: '时间列' },
  { value: 'idColumns', label: 'ID 列' },
  { value: 'metadataColumns', label: '元数据列' },
  { value: 'groupColumns', label: '分组列' },
  { value: 'covariateColumns', label: '协变量列' },
  { value: 'evaluationColumns', label: '评估列' },
  { value: 'ignoredColumns', label: '忽略列' },
]

interface ApprovalPanelProps {
  runId?: string
  interaction: WebAgentInteraction
  reasoning?: WebReasoning
  onApproved: () => void
}

export const ApprovalPanel = ({
  runId,
  interaction,
  reasoning,
  onApproved,
}: ApprovalPanelProps): React.ReactElement | null => {
  const cardKind = interaction.card?.kind
  if (cardKind == null || runId == null) return null

  if (cardKind === 'dataset_review' || cardKind === 'column_review') {
    return <DatasetConfirmForm runId={runId} onApproved={onApproved} />
  }
  if (cardKind === 'research_intent_review') {
    return <SimpleApproval runId={runId} onApproved={onApproved} />
  }
  if (cardKind === 'plan_review') {
    return <PlanApproval runId={runId} reasoning={reasoning} onApproved={onApproved} />
  }
  if (cardKind === 'training_review') {
    return <TrainingApproval runId={runId} onApproved={onApproved} />
  }
  return null
}

const DatasetConfirmForm = ({
  runId,
  onApproved,
}: {
  runId: string
  onApproved: () => void
}): React.ReactElement | null => {
  const [status, setStatus] = useState<StatusExtras>()
  const [domainLabel, setDomainLabel] = useState('')
  const [analysisUnit, setAnalysisUnit] = useState('')
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void (async () => {
      try {
        const data = (await getStatus(runId)) as StatusExtras
        setStatus(data)
        const understanding = data.datasetUnderstanding
        const nextRoles: Record<string, string> = {}
        const roleSets: Array<[string, RoleColumns[] | undefined]> = [
          ['textColumns', understanding?.textColumns],
          ['timeColumns', understanding?.timeColumns],
          ['idColumns', understanding?.idColumns],
          ['metadataColumns', understanding?.metadataColumns],
          ['groupColumns', understanding?.groupColumns],
          ['covariateColumns', understanding?.covariateColumns],
          ['evaluationColumns', understanding?.evaluationColumns],
          ['ignoredColumns', understanding?.ignoredColumns],
        ]
        for (const [role, entries] of roleSets) {
          for (const entry of entries ?? []) nextRoles[entry.column] = role
        }
        setRoles(nextRoles)
        setDomainLabel(understanding?.domain?.label ?? '')
        setAnalysisUnit(understanding?.analysisUnit ?? '')
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : String(submitError))
      }
    })()
  }, [runId])

  const originalRoles = useMemo(() => {
    const map: Record<string, string> = {}
    const understanding = status?.datasetUnderstanding
    const roleSets: Array<[string, RoleColumns[] | undefined]> = [
      ['textColumns', understanding?.textColumns],
      ['timeColumns', understanding?.timeColumns],
      ['idColumns', understanding?.idColumns],
      ['metadataColumns', understanding?.metadataColumns],
      ['groupColumns', understanding?.groupColumns],
      ['covariateColumns', understanding?.covariateColumns],
      ['evaluationColumns', understanding?.evaluationColumns],
      ['ignoredColumns', understanding?.ignoredColumns],
    ]
    for (const [role, entries] of roleSets) {
      for (const entry of entries ?? []) map[entry.column] = role
    }
    return map
  }, [status])

  const submit = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    const columnList = (role: string): string[] =>
      Object.entries(roles)
        .filter(([, value]) => value === role)
        .map(([column]) => column)
    const changed =
      Object.entries(roles).some(([column, role]) => originalRoles[column] !== role) ||
      domainLabel !== (status?.datasetUnderstanding?.domain?.label ?? '') ||
      analysisUnit !== (status?.datasetUnderstanding?.analysisUnit ?? '')
    try {
      await postAction(runId, {
        action: 'confirmDataset',
        status: changed ? 'corrected' : 'confirmed',
        domainLabel: domainLabel.trim() || '通用文本数据',
        analysisUnit: analysisUnit.trim() || '每一行是一条独立记录',
        textColumns: columnList('textColumns'),
        timeColumns: columnList('timeColumns'),
        idColumns: columnList('idColumns'),
        metadataColumns: columnList('metadataColumns'),
        groupColumns: columnList('groupColumns'),
        covariateColumns: columnList('covariateColumns'),
        evaluationColumns: columnList('evaluationColumns'),
        ignoredColumns: columnList('ignoredColumns'),
      })
      onApproved()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setBusy(false)
    }
  }, [roles, originalRoles, domainLabel, analysisUnit, status, runId, onApproved])

  if (status?.datasetFacts == null) {
    return <div className={css.banner}>正在加载数据集事实…</div>
  }

  return (
    <div className={css.banner}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        确认数据理解（{status.datasetFacts.rowCount ?? '?'} 行 · {status.datasetFacts.columns?.length ?? 0} 列）
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label className={css.runMeta}>
          领域
          <Input
            value={domainLabel}
            onChange={(event) => setDomainLabel(event.target.value)}
            style={{ marginTop: 2 }}
          />
        </label>
        <label className={css.runMeta}>
          分析单位
          <Input
            value={analysisUnit}
            onChange={(event) => setAnalysisUnit(event.target.value)}
            style={{ marginTop: 2 }}
          />
        </label>
        {(status.datasetFacts.columns ?? []).map((column) => (
          <label key={column.name} className={css.runMeta}>
            {column.name}
            <select
              value={roles[column.name] ?? 'ignoredColumns'}
              onChange={(event) =>
                setRoles((current) => ({ ...current, [column.name]: event.target.value }))
              }
              style={{ marginLeft: 8 }}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {error != null && <span>{error}</span>}
        <Button
          variant="primary"
          disabled={busy || !columnListOk(roles)}
          onClick={() => void submit()}
        >
          {busy ? '提交中…' : '确认数据理解'}
        </Button>
      </div>
    </div>
  )
}

const columnListOk = (roles: Record<string, string>): boolean =>
  Object.values(roles).some((role) => role === 'textColumns')

const SimpleApproval = ({
  runId,
  onApproved,
}: {
  runId: string
  onApproved: () => void
}): React.ReactElement => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <div className={css.banner}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>研究意图确认</div>
      <div style={{ marginBottom: 8 }}>
        请查看右侧「推理」页的研究意图摘要；需要修改可直接在对话中输入，确认无误后点击批准。
      </div>
      {error != null && <div>{error}</div>}
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void postAction(runId, { action: 'confirmIntent' })
            .then(onApproved)
            .catch((submitError: unknown) =>
              setError(submitError instanceof Error ? submitError.message : String(submitError)),
            )
            .finally(() => setBusy(false))
        }}
      >
        {busy ? '提交中…' : '批准研究意图'}
      </Button>
    </div>
  )
}

const PlanApproval = ({
  runId,
  reasoning,
  onApproved,
}: {
  runId: string
  reasoning?: WebReasoning
  onApproved: () => void
}): React.ReactElement => {
  const [acceptDegradation, setAcceptDegradation] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <section className={css.agentCard}>
      <div className={css.agentCardHead}>
        <span>PLAN · HUMAN REVIEW</span>
        <strong>确认 Agent 生成的训练方案</strong>
        <p>方案由 Planner、模型能力卡和 RAG 证据共同生成；批准只固化方案，不启动训练。</p>
      </div>
      <div className={css.agentCardBody}>
        {reasoning?.plan?.presentation != null && (
          <div className={css.planReviewSummary}>
            <strong>{reasoning.plan.presentation.title}</strong>
            <p>{reasoning.plan.presentation.summary}</p>
            {reasoning.plan.presentation.sections?.slice(0, 4).map((section) => (
              <div key={section.title}>
                <span>{section.title}</span>
                {section.lines.slice(0, 4).map((line) => <small key={line}>{line}</small>)}
              </div>
            ))}
          </div>
        )}
      <label className={css.runMeta} style={{ display: 'block', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={acceptDegradation}
          onChange={(event) => setAcceptDegradation(event.target.checked)}
        />{' '}
        接受方案中的性能降级项（如有）
      </label>
      {error != null && <div>{error}</div>}
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void postAction(runId, { action: 'approvePlan', acceptDegradation })
            .then(onApproved)
            .catch((submitError: unknown) =>
              setError(submitError instanceof Error ? submitError.message : String(submitError)),
            )
            .finally(() => setBusy(false))
        }}
      >
        {busy ? '提交中…' : '批准训练方案'}
      </Button>
      </div>
    </section>
  )
}

const TrainingApproval = ({
  runId,
  onApproved,
}: {
  runId: string
  onApproved: () => void
}): React.ReactElement => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <div className={css.banner}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>训练启动审批</div>
      <div style={{ marginBottom: 8 }}>
        训练将按已批准的方案执行（设备、工作目录、下载与写入均已在 dry-run 中列出）。确认后开始训练。
      </div>
      {error != null && <div>{error}</div>}
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void postAction(runId, { action: 'startTraining' })
            .then(onApproved)
            .catch((submitError: unknown) =>
              setError(submitError instanceof Error ? submitError.message : String(submitError)),
            )
            .finally(() => setBusy(false))
        }}
      >
        {busy ? '提交中…' : '批准并启动训练'}
      </Button>
    </div>
  )
}
