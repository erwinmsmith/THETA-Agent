import { useEffect, useMemo, useState } from 'react'
import { useInferenceSettings } from '../inference-settings.tsx'
import { Button, Modal } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import type { WebInferenceSettings, WebReasoningMode } from '../api/client.ts'
import css from './SettingsDialog.module.css'

interface SettingsDialogProps { open: boolean; onClose: () => void }

const numberOr = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const SettingsDialog = ({ open, onClose }: SettingsDialogProps): React.ReactElement => {
  const { locale } = usePreferences()
  const { catalog, settings, loading, error: loadError, update } = useInferenceSettings()
  const [tab, setTab] = useState<'llm' | 'embedding'>('llm')
  const [draft, setDraft] = useState<WebInferenceSettings>()
  const [llmKey, setLlmKey] = useState('')
  const [embeddingKey, setEmbeddingKey] = useState('')
  const [clearLlmKey, setClearLlmKey] = useState(false)
  const [clearEmbeddingKey, setClearEmbeddingKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (open && settings) {
      setDraft(structuredClone(settings))
      setLlmKey('')
      setEmbeddingKey('')
      setClearLlmKey(false)
      setClearEmbeddingKey(false)
      setError(undefined)
    }
  }, [open, settings])

  const provider = useMemo(
    () => catalog?.providers.find((item) => item.id === draft?.llm.providerId),
    [catalog, draft?.llm.providerId],
  )

  const editLlm = (next: Partial<WebInferenceSettings['llm']>): void => {
    setDraft((current) => current ? { ...current, llm: { ...current.llm, ...next } } : current)
  }
  const editEmbedding = (next: Partial<WebInferenceSettings['embedding']>): void => {
    setDraft((current) => current ? { ...current, embedding: { ...current.embedding, ...next } } : current)
  }

  const save = async (): Promise<void> => {
    if (!draft || !draft.llm.providerId || !draft.llm.model.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await update({
        llm: {
          providerId: draft.llm.providerId,
          model: draft.llm.model.trim(),
          baseUrl: draft.llm.baseUrl,
          reasoningMode: draft.llm.reasoningMode,
          reasoningEffort: draft.llm.reasoningEffort,
          reasoningBudgetTokens: draft.llm.reasoningBudgetTokens,
          temperature: draft.llm.temperature,
          maxTokens: draft.llm.maxTokens,
          timeoutMs: draft.llm.timeoutMs,
          streaming: draft.llm.streaming,
          typewriter: draft.llm.typewriter,
          typewriterSpeedMs: draft.llm.typewriterSpeedMs,
          ...(llmKey ? { apiKey: llmKey } : {}),
          ...(clearLlmKey ? { clearApiKey: true } : {}),
          models: [...new Set([...(provider?.models ?? []), draft.llm.model.trim()])],
        },
        embedding: {
          enabled: draft.embedding.enabled,
          providerId: draft.embedding.providerId,
          model: draft.embedding.model,
          baseUrl: draft.embedding.baseUrl,
          dimensions: draft.embedding.dimensions,
          ...(embeddingKey ? { apiKey: embeddingKey } : {}),
          ...(clearEmbeddingKey ? { clearApiKey: true } : {}),
        },
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const zh = locale === 'zh-CN'
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={zh ? '模型与 API 设置' : 'Model & API settings'}
      description={zh ? '配置 Agent 使用的语言模型和可选嵌入服务。密钥仅保存在本机私有状态目录。' : 'Configure the Agent LLM and optional embedding service. Keys stay in the private local state directory.'}
      className={css.dialog}
      contentClassName={css.content}
      footer={<><Button variant="ghost" onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button><Button variant="primary" disabled={busy || !draft} onClick={() => void save()}>{busy ? '…' : zh ? '保存设置' : 'Save settings'}</Button></>}
    >
      <div className={css.layout}>
        <nav className={css.nav} aria-label={zh ? '设置分类' : 'Settings sections'}>
          <button type="button" className={tab === 'llm' ? css.active : ''} onClick={() => setTab('llm')}>{zh ? '语言模型' : 'Language model'}</button>
          <button type="button" className={tab === 'embedding' ? css.active : ''} onClick={() => setTab('embedding')}>{zh ? '嵌入模型（可选）' : 'Embedding (optional)'}</button>
        </nav>
        {loading || !draft ? <div className={css.note}>{zh ? '正在读取本地配置…' : 'Loading local settings…'}</div> : tab === 'llm' ? (
          <section className={css.section}>
            <div className={css.sectionHeader}><h3>{zh ? 'Agent 语言模型' : 'Agent language model'}</h3><p>{zh ? '供应商、模型和推理类型会影响对话与工具决策；不影响 THETA 训练模型。' : 'Provider, model, and reasoning type affect chat and tool decisions, not THETA training models.'}</p></div>
            <div className={css.grid}>
              <label className={css.field}><span>{zh ? '供应商' : 'Provider'}</span><select value={draft.llm.providerId ?? ''} onChange={(event) => {
                const next = catalog?.providers.find((item) => item.id === event.target.value)
                editLlm({ providerId: event.target.value, model: next?.configuredModel ?? next?.models[0] ?? '', baseUrl: next?.baseUrl ?? '', apiKeyConfigured: next?.credentialConfigured ?? false })
              }}>{catalog?.providers.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.category}</option>)}</select></label>
              <label className={css.field}><span>{zh ? '模型' : 'Model'}</span><input list="theta-provider-models" value={draft.llm.model} onChange={(event) => editLlm({ model: event.target.value })} /><datalist id="theta-provider-models">{provider?.models.map((model) => <option key={model} value={model} />)}</datalist></label>
              <label className={`${css.field} ${css.wide}`}><span>Base URL</span><input type="url" value={draft.llm.baseUrl} onChange={(event) => editLlm({ baseUrl: event.target.value })} /></label>
              <label className={`${css.field} ${css.wide}`}><span>API key {draft.llm.apiKeyConfigured && <em className={css.keyStatus}>· {zh ? '已配置' : 'configured'}</em>}</span><input type="password" name="theta-llm-api-token" autoComplete="new-password" data-1p-ignore="true" data-lpignore="true" spellCheck={false} value={llmKey} placeholder={draft.llm.apiKeyConfigured ? (zh ? '留空以保留当前密钥' : 'Leave blank to keep current key') : 'sk-…'} onChange={(event) => { setLlmKey(event.target.value); setClearLlmKey(false) }} /></label>
              {draft.llm.apiKeyConfigured && <label className={css.field}><span><input type="checkbox" checked={clearLlmKey} onChange={(event) => setClearLlmKey(event.target.checked)} /> {zh ? '清除已保存密钥' : 'Clear saved key'}</span></label>}
              <div className={`${css.field} ${css.wide}`}><span>{zh ? '推理类型' : 'Reasoning type'}</span><div className={css.segmented}>{(['auto', 'chat', 'reasoning'] as WebReasoningMode[]).map((mode) => <button key={mode} type="button" className={draft.llm.reasoningMode === mode ? css.active : ''} onClick={() => editLlm({ reasoningMode: mode })}>{mode === 'auto' ? (zh ? '自动' : 'Auto') : mode === 'chat' ? (zh ? '对话' : 'Chat') : (zh ? '推理' : 'Reasoning')}</button>)}</div></div>
              {draft.llm.reasoningMode === 'reasoning' && <><label className={css.field}><span>{zh ? '推理强度' : 'Reasoning effort'}</span><select value={draft.llm.reasoningEffort} disabled={!provider?.capabilities.reasoningEffort} onChange={(event) => editLlm({ reasoningEffort: event.target.value as WebInferenceSettings['llm']['reasoningEffort'] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label className={css.field}><span>{zh ? '推理预算（可选）' : 'Reasoning budget (optional)'}</span><input type="number" min="256" value={draft.llm.reasoningBudgetTokens ?? ''} onChange={(event) => editLlm({ reasoningBudgetTokens: event.target.value ? numberOr(event.target.value, 256) : null })} /></label></>}
              <label className={css.field}><span>Temperature</span><input type="number" min="0" max="2" step="0.1" value={draft.llm.temperature} onChange={(event) => editLlm({ temperature: numberOr(event.target.value, 0.1) })} /></label>
              <label className={css.field}><span>Max tokens</span><input type="number" min="64" value={draft.llm.maxTokens} onChange={(event) => editLlm({ maxTokens: numberOr(event.target.value, 800) })} /></label>
              <label className={css.field}><span>{zh ? '超时（毫秒）' : 'Timeout (ms)'}</span><input type="number" min="1000" value={draft.llm.timeoutMs} onChange={(event) => editLlm({ timeoutMs: numberOr(event.target.value, 60000) })} /></label>
              <label className={css.field}><span>{zh ? '打字速度（毫秒）' : 'Typewriter speed (ms)'}</span><input type="number" min="0" max="100" value={draft.llm.typewriterSpeedMs} onChange={(event) => editLlm({ typewriterSpeedMs: numberOr(event.target.value, 18) })} /></label>
            </div>
            <label className={css.toggleRow}><span className={css.toggleCopy}><strong>{zh ? '流式输出' : 'Streaming output'}</strong><small>{zh ? '支持文本调用的供应商增量输出；结构化决策会先完成契约校验再展示。' : 'Stream incremental text on supported calls; structured decisions remain buffered until contract validation.'}</small></span><input type="checkbox" checked={draft.llm.streaming} onChange={(event) => editLlm({ streaming: event.target.checked })} /></label>
            <label className={css.toggleRow}><span className={css.toggleCopy}><strong>{zh ? '打字机效果' : 'Typewriter rendering'}</strong><small>{zh ? '新回答逐字显示；减少动态效果偏好会自动禁用。' : 'Reveal new replies progressively; reduced-motion preferences disable it.'}</small></span><input type="checkbox" checked={draft.llm.typewriter} onChange={(event) => editLlm({ typewriter: event.target.checked })} /></label>
          </section>
        ) : (
          <section className={css.section}>
            <div className={css.sectionHeader}><h3>{zh ? '嵌入 API（可选）' : 'Embedding API (optional)'}</h3><p>{zh ? '仅为未来的检索或零样本嵌入能力预留。不会自动调用，也不会改变 THETA 训练模型或训练参数。' : 'Reserved for future retrieval or zero-shot embeddings. It is never called automatically and does not change THETA training models or parameters.'}</p></div>
            <label className={css.toggleRow}><span className={css.toggleCopy}><strong>{zh ? '启用嵌入配置' : 'Enable embedding configuration'}</strong><small>{zh ? '启用表示配置可供 Agent 使用，不代表立即发起请求。' : 'Makes the configuration available to the Agent; it does not send a request.'}</small></span><input type="checkbox" checked={draft.embedding.enabled} onChange={(event) => editEmbedding({ enabled: event.target.checked })} /></label>
            <div className={css.grid}>
              <label className={css.field}><span>{zh ? '供应商 ID' : 'Provider ID'}</span><input value={draft.embedding.providerId} onChange={(event) => editEmbedding({ providerId: event.target.value })} /></label>
              <label className={css.field}><span>{zh ? '模型' : 'Model'}</span><input value={draft.embedding.model} onChange={(event) => editEmbedding({ model: event.target.value })} /></label>
              <label className={`${css.field} ${css.wide}`}><span>Base URL</span><input type="url" value={draft.embedding.baseUrl} onChange={(event) => editEmbedding({ baseUrl: event.target.value })} /></label>
              <label className={css.field}><span>{zh ? '维度（可选）' : 'Dimensions (optional)'}</span><input type="number" min="1" value={draft.embedding.dimensions ?? ''} onChange={(event) => editEmbedding({ dimensions: event.target.value ? numberOr(event.target.value, 1) : null })} /></label>
              <label className={css.field}><span>API key {draft.embedding.apiKeyConfigured && <em className={css.keyStatus}>· {zh ? '已配置' : 'configured'}</em>}</span><input type="password" name="theta-embedding-api-token" autoComplete="new-password" data-1p-ignore="true" data-lpignore="true" spellCheck={false} value={embeddingKey} placeholder={draft.embedding.apiKeyConfigured ? (zh ? '留空以保留当前密钥' : 'Leave blank to keep current key') : 'sk-…'} onChange={(event) => { setEmbeddingKey(event.target.value); setClearEmbeddingKey(false) }} /></label>
              {draft.embedding.apiKeyConfigured && <label className={css.field}><span><input type="checkbox" checked={clearEmbeddingKey} onChange={(event) => setClearEmbeddingKey(event.target.checked)} /> {zh ? '清除已保存密钥' : 'Clear saved key'}</span></label>}
            </div>
          </section>
        )}
      </div>
      {(error ?? loadError) && <p className={css.error} role="alert">{error ?? loadError}</p>}
    </Modal>
  )
}
