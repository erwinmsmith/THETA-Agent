import { useEffect, useMemo, useState } from 'react'
import {
  getInferenceCatalog,
  selectInferenceModel,
  type WebInferenceProvider,
} from '../api/client.ts'
import { Button } from '../ui/index.ts'
import css from '../styles/app.module.css'

export const InferenceSelector = (): React.ReactElement => {
  const [providers, setProviders] = useState<WebInferenceProvider[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    void getInferenceCatalog()
      .then((catalog) => {
        setProviders(catalog.providers)
        const active = catalog.providers.find((provider) => provider.selected)
          ?? catalog.providers.find((provider) => provider.configured)
        if (active != null) {
          setProviderId(active.id)
          setModel(catalog.selection?.providerId === active.id
            ? catalog.selection.model
            : active.configuredModel ?? '')
        }
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
  }, [])

  const provider = useMemo(
    () => providers.find((item) => item.id === providerId),
    [providers, providerId],
  )

  const save = async (): Promise<void> => {
    if (!providerId || !model.trim() || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await selectInferenceModel(providerId, model.trim())
      setProviders((current) => current.map((item) => ({ ...item, selected: item.id === providerId })))
      setMessage('已切换')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.inferenceSelector} title={message}>
      <span className={css.toolbarLabel}>MODEL</span>
      <select
        aria-label="语言模型供应商"
        value={providerId}
        onChange={(event) => {
          const next = providers.find((item) => item.id === event.target.value)
          setProviderId(event.target.value)
          setModel(next?.configuredModel ?? '')
          setMessage(undefined)
        }}
      >
        {providers.map((item) => (
          <option key={item.id} value={item.id} disabled={!item.configured}>
            {item.displayName}{item.configured ? '' : '（未配置）'}
          </option>
        ))}
      </select>
      <input
        aria-label="模型名称"
        value={model}
        placeholder={provider?.configuredModel ?? 'model'}
        onChange={(event) => setModel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save()
        }}
      />
      <Button size="sm" variant="outline" disabled={busy || !provider?.configured || !model.trim()} onClick={() => void save()}>
        {busy ? '…' : message === '已切换' ? '已应用' : '应用'}
      </Button>
    </div>
  )
}
