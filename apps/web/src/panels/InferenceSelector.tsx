import { useEffect, useMemo, useState } from 'react'
import {
  getInferenceCatalog,
  selectInferenceModel,
  type WebInferenceProvider,
} from '../api/client.ts'
import { Button } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import css from '../styles/app.module.css'

export const InferenceSelector = (): React.ReactElement => {
  const { locale } = usePreferences()
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
    <details className={css.modelPicker} title={message}>
      <summary aria-label={locale === 'zh-CN' ? '选择模型' : 'Select model'}>
        <span>{provider?.displayName ?? 'Model'}</span>
        <strong>{model || provider?.configuredModel || '—'}</strong>
        <span>⌄</span>
      </summary>
      <div className={css.modelPickerPanel}>
        <label>
          <span>{locale === 'zh-CN' ? '供应商' : 'Provider'}</span>
          <select
            aria-label={locale === 'zh-CN' ? '语言模型供应商' : 'Model provider'}
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
                {item.displayName}{item.configured ? '' : locale === 'zh-CN' ? '（未配置）' : ' (not configured)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{locale === 'zh-CN' ? '模型' : 'Model'}</span>
          <input
            aria-label={locale === 'zh-CN' ? '模型名称' : 'Model name'}
            value={model}
            placeholder={provider?.configuredModel ?? 'model'}
            onChange={(event) => setModel(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void save() }}
          />
        </label>
        <Button size="sm" variant="primary" disabled={busy || !provider?.configured || !model.trim()} onClick={() => void save()}>
          {busy ? '…' : message === '已切换' ? (locale === 'zh-CN' ? '已应用' : 'Applied') : (locale === 'zh-CN' ? '应用' : 'Apply')}
        </Button>
      </div>
    </details>
  )
}
