import { useEffect, useMemo, useState } from 'react'
import {
  createRun,
  listDatasets,
  uploadDataset,
  type WebDataset,
} from '../api/client.ts'
import { Button, Modal } from '../ui/index.ts'
import css from '../styles/app.module.css'

interface NewRunDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (runId: string) => void
}

const readableBytes = (value: number): string => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export const NewRunDialog = ({
  open,
  onClose,
  onCreated,
}: NewRunDialogProps): React.ReactElement => {
  const [datasets, setDatasets] = useState<WebDataset[]>([])
  const [datasetRef, setDatasetRef] = useState('')
  const [researchGoal, setResearchGoal] = useState('')
  const [useLanguageProvider, setUseLanguageProvider] = useState(true)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setError(undefined)
    void listDatasets()
      .then(({ datasets: available }) => {
        setDatasets(available)
        setDatasetRef((current) => current || available[0]?.datasetRef || '')
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
  }, [open])

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

  const submit = async (): Promise<void> => {
    if (!datasetRef || loading) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await createRun({
        datasetRef,
        ...(researchGoal.trim().length >= 4 ? { researchGoal: researchGoal.trim() } : {}),
        useLanguageProvider,
      })
      onCreated(result.runId)
      onClose()
      setResearchGoal('')
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建研究任务"
      closeLabel="关闭"
      description="选择文本数据，并给 Agent 一个清晰的研究方向。"
      className={css.newRunDialog}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!datasetRef || loading || uploading} onClick={() => void submit()}>
            {loading ? '正在初始化…' : '创建并开始'}
          </Button>
        </>
      )}
    >
      <div className={css.formStack}>
        <label className={css.fieldLabel} htmlFor="dataset-select">数据集</label>
        <select
          id="dataset-select"
          className={css.selectControl}
          value={datasetRef}
          onChange={(event) => setDatasetRef(event.target.value)}
        >
          {datasets.length === 0 && <option value="">暂无已注册数据集</option>}
          {datasets.map((dataset) => (
            <option key={dataset.datasetRef} value={dataset.datasetRef}>
              {dataset.name} · {readableBytes(dataset.sizeBytes)}
            </option>
          ))}
        </select>
        {selected != null && (
          <span className={css.fieldHint}>{selected.suffix.toUpperCase()} · {selected.datasetRef}</span>
        )}

        <label className={css.uploadBox}>
          <input
            type="file"
            accept=".csv,.tsv,.json,.jsonl,.txt,.xlsx,.xls,.parquet"
            disabled={uploading}
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <span>{uploading ? '正在上传…' : '上传新的数据集'}</span>
          <small>CSV、TSV、JSONL、TXT、Excel 或 Parquet，最大 100 MB</small>
        </label>

        <label className={css.fieldLabel} htmlFor="research-goal">研究方向</label>
        <textarea
          id="research-goal"
          className={css.textareaControl}
          rows={4}
          value={researchGoal}
          placeholder="例如：分析用户反馈中的核心主题、负面体验与产品改进机会。留空则由 THETA 自主探索。"
          onChange={(event) => setResearchGoal(event.target.value)}
        />

        <label className={css.checkRow}>
          <input
            type="checkbox"
            checked={useLanguageProvider}
            onChange={(event) => setUseLanguageProvider(event.target.checked)}
          />
          <span>
            使用语言模型规划
            <small>关闭后使用确定性后备规划，不会调用远程模型。</small>
          </span>
        </label>
        {error != null && <div className={css.formError}>{error}</div>}
      </div>
    </Modal>
  )
}
