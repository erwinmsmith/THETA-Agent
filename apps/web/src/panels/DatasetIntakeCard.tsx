import { useEffect, useMemo, useState } from 'react'
import {
  createRun,
  listDatasets,
  uploadDataset,
  type WebAgentInteraction,
  type WebDataset,
} from '../api/client.ts'
import { Button } from '../ui/index.ts'
import css from '../styles/app.module.css'

interface DatasetIntakeCardProps {
  interaction: WebAgentInteraction
  onCreated: (runId: string) => void
}

const readableBytes = (value: number): string => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export const DatasetIntakeCard = ({
  interaction,
  onCreated,
}: DatasetIntakeCardProps): React.ReactElement => {
  const [datasets, setDatasets] = useState<WebDataset[]>([])
  const [datasetRef, setDatasetRef] = useState('')
  const [researchGoal, setResearchGoal] = useState('')
  const [useLanguageProvider, setUseLanguageProvider] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void listDatasets()
      .then(({ datasets: available }) => {
        setDatasets(available)
        setDatasetRef((current) => current || available[0]?.datasetRef || '')
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
  }, [])

  const selected = useMemo(
    () => datasets.find((dataset) => dataset.datasetRef === datasetRef),
    [datasets, datasetRef],
  )

  const upload = async (file?: File): Promise<void> => {
    if (!file || uploading) return
    setUploading(true)
    setError(undefined)
    try {
      const dataset = await uploadDataset(file)
      setDatasets((current) => [dataset, ...current.filter((item) => item.datasetRef !== dataset.datasetRef)])
      setDatasetRef(dataset.datasetRef)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError))
    } finally {
      setUploading(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!datasetRef || creating) return
    setCreating(true)
    setError(undefined)
    try {
      const result = await createRun({
        datasetRef,
        ...(researchGoal.trim().length >= 4 ? { researchGoal: researchGoal.trim() } : {}),
        useLanguageProvider,
      })
      onCreated(result.runId)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className={`${css.agentCard} ${css.intakeCard}`} aria-label={interaction.card?.title}>
      <div className={css.agentCardHead}>
        <span>01 · DATA INTAKE</span>
        <strong>{interaction.card?.title ?? '上传研究数据'}</strong>
        <p>{interaction.card?.description}</p>
      </div>
      <div className={css.agentCardBody}>
        <label className={css.fieldLabel} htmlFor="inline-dataset-select">已注册数据</label>
        <select
          id="inline-dataset-select"
          className={css.selectControl}
          value={datasetRef}
          onChange={(event) => setDatasetRef(event.target.value)}
        >
          {datasets.length === 0 && <option value="">尚未上传数据集</option>}
          {datasets.map((dataset) => (
            <option key={dataset.datasetRef} value={dataset.datasetRef}>
              {dataset.name} · {readableBytes(dataset.sizeBytes)}
            </option>
          ))}
        </select>
        {selected != null && <span className={css.fieldHint}>{selected.suffix.toUpperCase()} · 已完成本地注册</span>}

        <label className={css.uploadBox}>
          <input
            type="file"
            accept=".csv,.tsv,.json,.jsonl,.txt,.xlsx,.xls,.parquet"
            disabled={uploading}
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <span>{uploading ? '正在安全注册数据…' : '拖入或选择新的数据集'}</span>
          <small>文件只写入本地受管目录；Agent 在创建 Run 后才会读取。</small>
        </label>

        <label className={css.fieldLabel} htmlFor="inline-research-goal">给 Agent 的研究方向</label>
        <textarea
          id="inline-research-goal"
          className={css.textareaControl}
          rows={3}
          value={researchGoal}
          placeholder="例如：识别用户反馈中的核心主题，并解释负面体验。留空则自主探索。"
          onChange={(event) => setResearchGoal(event.target.value)}
        />
        <label className={css.checkRow}>
          <input
            type="checkbox"
            checked={useLanguageProvider}
            onChange={(event) => setUseLanguageProvider(event.target.checked)}
          />
          <span>允许 DeepSeek 执行结构化 Agent 推理<small>Tool 仍受 FSM allowlist、Hypha policy 与审批约束。</small></span>
        </label>
        {error != null && <div className={css.formError}>{error}</div>}
        <Button variant="primary" disabled={!datasetRef || uploading || creating} onClick={() => void start()}>
          {creating ? '正在创建 FSM Run…' : '交给 Agent 开始研究'}
        </Button>
      </div>
    </section>
  )
}
