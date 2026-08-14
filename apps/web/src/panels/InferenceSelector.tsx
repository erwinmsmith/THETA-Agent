import { useMemo, useState } from 'react'
import { useInferenceSettings } from '../inference-settings.tsx'
import { usePreferences } from '../preferences.tsx'
import type { WebInferenceProvider, WebReasoningEffort, WebReasoningMode } from '../api/client.ts'
import css from '../styles/app.module.css'

const categories: Array<{ id: WebInferenceProvider['category']; en: string; zh: string }> = [
  { id: 'direct', en: 'Direct providers', zh: '直连厂商' },
  { id: 'router', en: 'Model routers', zh: '模型路由' },
  { id: 'local', en: 'Local runtime', zh: '本地运行时' },
  { id: 'compatible', en: 'Compatible APIs', zh: '兼容 API' },
]

export const InferenceSelector = (): React.ReactElement => {
  const { locale } = usePreferences()
  const { catalog, settings, loading, update } = useInferenceSettings()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const provider = useMemo(
    () => catalog?.providers.find((item) => item.id === settings?.llm.providerId),
    [catalog, settings?.llm.providerId],
  )

  const apply = async (input: { providerId?: string; model?: string; reasoningMode?: WebReasoningMode; reasoningEffort?: WebReasoningEffort }): Promise<void> => {
    if (!settings || busy) return
    const nextProvider = catalog?.providers.find((item) => item.id === (input.providerId ?? settings.llm.providerId))
    const model = input.model ?? (input.providerId ? nextProvider?.configuredModel ?? nextProvider?.models[0] : undefined) ?? settings.llm.model
    if (!nextProvider || !model) return
    setBusy(true)
    setMessage(undefined)
    try {
      await update({ llm: {
        providerId: nextProvider.id,
        model,
        baseUrl: nextProvider.baseUrl,
        reasoningMode: input.reasoningMode ?? settings.llm.reasoningMode,
        reasoningEffort: input.reasoningEffort ?? settings.llm.reasoningEffort,
        models: [...new Set([...nextProvider.models, model])],
      } })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (loading || !settings || !catalog) return <span className={css.modelPickerLoading}>Model…</span>
  return (
    <div className={css.quickModelPicker} title={message} aria-busy={busy}>
      <select aria-label={locale === 'zh-CN' ? '模型供应商' : 'Model provider'} value={settings.llm.providerId ?? ''} onChange={(event) => void apply({ providerId: event.target.value })}>
        {categories.map((category) => {
          const items = catalog.providers.filter((item) => item.category === category.id)
          return items.length ? <optgroup key={category.id} label={locale === 'zh-CN' ? category.zh : category.en}>{items.map((item) => <option key={item.id} value={item.id} disabled={!item.configured}>{item.displayName}{item.configured ? '' : locale === 'zh-CN' ? '（未配置）' : ' (not configured)'}</option>)}</optgroup> : null
        })}
      </select>
      <select aria-label={locale === 'zh-CN' ? '语言模型' : 'Language model'} value={settings.llm.model} onChange={(event) => void apply({ model: event.target.value })}>
        {[...new Set([settings.llm.model, ...(provider?.models ?? [])])].filter(Boolean).map((model) => <option key={model} value={model}>{model}</option>)}
      </select>
      <select aria-label={locale === 'zh-CN' ? '推理类型' : 'Reasoning type'} value={settings.llm.reasoningMode} onChange={(event) => void apply({ reasoningMode: event.target.value as WebReasoningMode })}>
        <option value="auto">{locale === 'zh-CN' ? '自动推理' : 'Auto reasoning'}</option>
        <option value="chat">{locale === 'zh-CN' ? '对话' : 'Chat'}</option>
        <option value="reasoning">{locale === 'zh-CN' ? '深度推理' : 'Reasoning'}</option>
      </select>
      <select aria-label={locale === 'zh-CN' ? '推理强度' : 'Reasoning effort'} value={settings.llm.reasoningEffort} onChange={(event) => void apply({ reasoningEffort: event.target.value as WebReasoningEffort })}>
        <option value="low">{locale === 'zh-CN' ? '强度 Low' : 'Effort Low'}</option>
        <option value="medium">{locale === 'zh-CN' ? '强度 Medium' : 'Effort Medium'}</option>
        <option value="high">{locale === 'zh-CN' ? '强度 High' : 'Effort High'}</option>
      </select>
      {busy && <span className={css.quickModelBusy} aria-hidden="true" />}
    </div>
  )
}
