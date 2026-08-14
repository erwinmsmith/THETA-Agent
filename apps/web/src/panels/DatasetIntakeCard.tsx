import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createRun,
  listDatasets,
  uploadDataset,
  type WebAgentInteraction,
  type WebDataset,
} from '../api/client.ts'
import { Button } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import css from '../styles/app.module.css'

interface DatasetIntakeCardProps {
  interaction: WebAgentInteraction
  sourceSessionId?: string
  initialGoal?: string
  onCreated: (runId: string) => void
}

const readableBytes = (value: number): string => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export const DatasetIntakeCard = ({
  interaction,
  sourceSessionId,
  initialGoal = '',
  onCreated,
}: DatasetIntakeCardProps): React.ReactElement => {
  const { locale, t } = usePreferences()
  const [datasets, setDatasets] = useState<WebDataset[]>([])
  const [datasetRef, setDatasetRef] = useState('')
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
    folderInput.current?.setAttribute('directory', '')
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

  const uploadFiles = async (files: File[]): Promise<void> => {
    const accepted = files
      .filter((file) => /\.(csv|tsv|json|jsonl|txt|xlsx|xls|parquet)$/iu.test(file.name))
      .slice(0, 25)
    if (accepted.length === 0 || uploading) return
    setUploading(true)
    setError(undefined)
    try {
      const uploaded: WebDataset[] = []
      for (const file of accepted) uploaded.push(await uploadDataset(file))
      setDatasets((current) => [
        ...uploaded,
        ...current.filter((item) => !uploaded.some((next) => next.datasetRef === item.datasetRef)),
      ])
      setDatasetRef(uploaded[0]?.datasetRef ?? '')
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
        ...(initialGoal.trim().length >= 4 ? { researchGoal: initialGoal.trim() } : {}),
        useLanguageProvider: true,
        ...(sourceSessionId ? { sourceSessionId } : {}),
      })
      onCreated(result.runId)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className={`${css.datasetIntakePanel} ${dragging ? css.contextCardDragging : ''}`} aria-label={interaction.card?.title ?? t('addData')}>
      <div
        className={css.contextDropzone}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void uploadFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <span>{uploading ? (locale === 'zh-CN' ? '正在注册数据…' : 'Registering data…') : t('chooseFiles')}</span>
        <div>
          <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {locale === 'zh-CN' ? '选择文件' : 'Choose files'}
          </Button>
          <Button size="sm" variant="ghost" disabled={uploading} onClick={() => folderInput.current?.click()}>
            {locale === 'zh-CN' ? '选择文件夹' : 'Choose folder'}
          </Button>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))} />
        <input ref={folderInput} type="file" multiple hidden onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))} />
      </div>
      <div className={css.contextCardActions}>
        <select value={datasetRef} onChange={(event) => setDatasetRef(event.target.value)}>
          {datasets.length === 0 && <option value="">{locale === 'zh-CN' ? '还没有数据' : 'No data yet'}</option>}
          {datasets.map((dataset) => (
            <option key={dataset.datasetRef} value={dataset.datasetRef}>
              {dataset.name} · {readableBytes(dataset.sizeBytes)}
            </option>
          ))}
        </select>
        {selected != null && <small>{selected.suffix.toUpperCase()} · {locale === 'zh-CN' ? '本地受管注册' : 'locally managed'}</small>}
        <Button size="sm" variant="primary" disabled={!datasetRef || uploading || creating} onClick={() => void start()}>
          {creating ? (locale === 'zh-CN' ? '创建中…' : 'Creating…') : t('run')}
        </Button>
      </div>
      {error != null && <div className={css.formError}>{error}</div>}
    </section>
  )
}
