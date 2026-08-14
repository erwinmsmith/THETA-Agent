import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  getInferenceCatalog,
  getInferenceSettings,
  updateInferenceSettings,
  type WebInferenceCatalog,
  type WebInferenceSettings,
  type WebInferenceSettingsUpdate,
} from './api/client.ts'

interface InferenceSettingsValue {
  catalog?: WebInferenceCatalog
  settings?: WebInferenceSettings
  loading: boolean
  error?: string
  refresh: () => Promise<void>
  update: (input: WebInferenceSettingsUpdate) => Promise<WebInferenceSettings>
}

const InferenceSettingsContext = createContext<InferenceSettingsValue | null>(null)

export const InferenceSettingsProvider = ({ children }: { children: ReactNode }): React.ReactElement => {
  const [catalog, setCatalog] = useState<WebInferenceCatalog>()
  const [settings, setSettings] = useState<WebInferenceSettings>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [catalogResult, settingsResult] = await Promise.allSettled([
      getInferenceCatalog(),
      getInferenceSettings(),
    ])
    if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value)
    if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value)
    const failures = [catalogResult, settingsResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
    setError(failures.length > 0 ? [...new Set(failures)].join(' · ') : undefined)
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const update = useCallback(async (input: WebInferenceSettingsUpdate): Promise<WebInferenceSettings> => {
    const next = await updateInferenceSettings(input)
    setSettings(next)
    setCatalog(await getInferenceCatalog())
    setError(undefined)
    return next
  }, [])

  const value = useMemo<InferenceSettingsValue>(() => ({
    catalog,
    settings,
    loading,
    error,
    refresh,
    update,
  }), [catalog, settings, loading, error, refresh, update])

  return <InferenceSettingsContext.Provider value={value}>{children}</InferenceSettingsContext.Provider>
}

export const useInferenceSettings = (): InferenceSettingsValue => {
  const value = useContext(InferenceSettingsContext)
  if (!value) throw new Error('useInferenceSettings must be used within InferenceSettingsProvider.')
  return value
}
